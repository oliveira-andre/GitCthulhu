// The commit graph: a virtualized table of commits with the lanes drawn on
// a canvas over the graph column. Only the rows in view exist in the DOM.
import { type CommitStat, type Graph, type GraphCommit, type Ref, WORK_IN_PROGRESS, api, errorMessage } from "../api";
import { el } from "../dom";
import { avatarColor, formatTime, initials, laneColor, plural, relativeTime, shortSha } from "../format";
import { icon, iconButton } from "../icons";
import { type MenuItem, showMenu } from "../menu";
import { isMac } from "../platform";
import { startRefDrag } from "./ref-drag";
import type { RepoView } from "./repo-view";

export const ROW = 28;
const LANE = 20;
const PAD = 8;
const OVERSCAN = 8;

type ColumnId = "refs" | "graph" | "author" | "changes" | "date" | "sha";

interface Columns {
  widths: Record<ColumnId, number>;
  hidden: ColumnId[];
}

/** The columns that can be hidden; the graph can only be resized. */
const COLUMN_NAMES: Partial<Record<ColumnId, string>> = { refs: "Branch / Tag", author: "Author", changes: "Changes", date: "Date", sha: "SHA" };
/** A graph width of 0 sizes it to its lanes (up to 320 px). */
const DEFAULT_COLUMNS: Columns = { widths: { refs: 170, graph: 0, author: 140, changes: 110, date: 116, sha: 76 }, hidden: ["changes"] };
const COLUMNS_KEY = "gitcthulhu.graphColumns";

function loadColumns(): Columns {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null") as Partial<Columns> | null;
    if (saved) return { widths: { ...DEFAULT_COLUMNS.widths, ...saved.widths }, hidden: (saved.hidden ?? DEFAULT_COLUMNS.hidden).filter((h) => h !== "graph") };
  } catch {
    // Use the defaults.
  }
  return structuredClone(DEFAULT_COLUMNS);
}

function saveColumns(columns: Columns): void {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // Not remembered this time.
  }
}

/** Branches that share a name locally and on remotes become one label. */
interface RefLabel {
  name: string;
  local: Ref | null;
  remotes: Ref[];
  tag: Ref | null;
  isHead: boolean;
}

export class GraphView {
  readonly root: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly searchBar: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly indexBar: HTMLElement;
  private readonly header: HTMLElement;
  private readonly results: HTMLElement;
  private columns = loadColumns();
  /** Changed-line counts, fetched for the rows in view while that column shows. */
  private stats = new Map<string, CommitStat>();
  private pendingStats = new Set<string>();
  private statsTimer: number | undefined;
  private graph: Graph = { commits: [], rows: [], truncated: false, indexed: true };
  private labels = new Map<string, RefLabel[]>();
  private headOid: string | null = null;
  private graphWidth = 56;
  private rendered = new Map<number, HTMLElement>();
  private frame = 0;
  private search = "";
  private matches: number[] = [];
  private matchSet = new Set<number>();
  private matchIndex = -1;

  constructor(private readonly view: RepoView) {
    this.searchInput = el("input", "search graph-search-input");
    this.searchInput.type = "search";
    this.searchInput.placeholder = "Find commits by message, author or SHA";
    this.searchInput.spellcheck = false;
    this.searchCount = el("span", "graph-search-count");
    const prev = el("button", "icon-button", icon("arrowUp", 14));
    prev.type = "button";
    prev.title = "Previous match (⇧↩)";
    prev.addEventListener("click", () => this.step(-1));
    const next = el("button", "icon-button", icon("arrowDown", 14));
    next.type = "button";
    next.title = "Next match (↩)";
    next.addEventListener("click", () => this.step(1));
    const closeSearch = el("button", "icon-button", icon("close", 14));
    closeSearch.type = "button";
    closeSearch.title = "Close (Esc)";
    closeSearch.addEventListener("click", () => this.closeSearch());
    const everywhere = el("button", "button-secondary small", "All history");
    everywhere.type = "button";
    everywhere.title = "Search every commit, not just the ones loaded";
    everywhere.addEventListener("click", () => void this.searchEverywhere());
    this.results = el("div", "search-results");
    this.results.hidden = true;
    this.searchBar = el("div", "graph-search", icon("search", 14), this.searchInput, this.searchCount, prev, next, everywhere, closeSearch, this.results);
    this.searchBar.hidden = true;
    this.searchInput.addEventListener("input", () => this.setSearch(this.searchInput.value));
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeSearch();
      }
    });

    const headerCell = (id: ColumnId | "graph" | "message", label: string) => {
      const cell = el("div", `col col-${id}`, label);
      if (id !== "message") {
        const grip = el("span", "col-grip");
        grip.addEventListener("pointerdown", (event) => this.resizeColumn(event, id, grip));
        cell.append(grip);
      }
      return cell;
    };
    const columnsButton = iconButton("settings", "Columns", (event) => this.columnMenu({ x: event.clientX, y: event.clientY }), "icon-button small columns-button");
    this.header = el(
      "div",
      "graph-header",
      headerCell("refs", "Branch / Tag"),
      headerCell("graph", "Graph"),
      headerCell("message", "Commit message"),
      headerCell("author", "Author"),
      headerCell("changes", "Changes"),
      headerCell("date", "Date"),
      headerCell("sha", "SHA"),
      columnsButton,
    );
    this.header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.columnMenu({ x: event.clientX, y: event.clientY });
    });
    this.filterBar = el("div", "graph-filter");
    this.filterBar.hidden = true;
    this.indexBar = el("div", "graph-index");
    this.indexBar.hidden = true;
    this.canvas = el("canvas", "graph-canvas");
    this.spacer = el("div", "graph-spacer", this.canvas);
    this.scroll = el("div", "graph-scroll", this.spacer);
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("aria-label", "Commits");
    this.footer = el("div", "graph-footer");
    this.root = el("div", "graph-view", this.searchBar, this.indexBar, this.filterBar, this.header, this.scroll, this.footer);
    this.applyColumns();

    this.scroll.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroll);
    this.scroll.addEventListener("keydown", (event) => this.onKey(event));
  }

  setData(graph: Graph, refs: Ref[], headOid: string | null): void {
    this.graph = graph;
    this.headOid = headOid;
    this.labels = buildLabels(refs.filter((r) => !this.view.isHidden(r.name)));
    let maxLane = 0;
    for (const row of graph.rows) {
      maxLane = Math.max(maxLane, row.lane);
      for (const e of row.edges) maxLane = Math.max(maxLane, e.from, e.to);
    }
    const lanes = Math.min(Math.max(PAD * 2 + (maxLane + 1) * LANE, 56), 320);
    this.graphWidth = this.columns.widths.graph > 0 ? this.columns.widths.graph : lanes;
    this.root.style.setProperty("--graph-width", `${this.graphWidth}px`);
    this.spacer.style.height = `${graph.commits.length * ROW}px`;
    this.footer.replaceChildren();
    if (graph.truncated) {
      const more = el("button", "button-secondary small", `Load ${this.view.settings().commitLimit.toLocaleString()} more`);
      more.type = "button";
      more.addEventListener("click", () => this.view.loadMore());
      this.footer.append(`Showing the latest ${plural(graph.commits.length, "commit")}. `, more);
    }
    this.footer.hidden = !graph.truncated;
    this.renderFilterBar();
    this.renderIndexBar();
    if (this.search) this.setSearch(this.search, false);
    this.invalidate();
  }

  /**
   * Redraws every row, for example after the selection moved. It happens
   * at once: waiting for a frame would show an empty graph in between.
   */
  invalidate(): void {
    for (const node of this.rendered.values()) node.remove();
    this.rendered.clear();
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.draw();
  }

  focus(): void {
    this.scroll.focus({ preventScroll: true });
  }

  indexOf(oid: string): number {
    return this.graph.commits.findIndex((c) => c.oid === oid);
  }

  scrollToIndex(index: number, center = false): void {
    if (index < 0) return;
    const top = index * ROW;
    const height = this.scroll.clientHeight;
    if (center) {
      this.scroll.scrollTop = Math.max(0, top - height / 2 + ROW / 2);
    } else if (top < this.scroll.scrollTop) {
      this.scroll.scrollTop = top;
    } else if (top + ROW > this.scroll.scrollTop + height) {
      this.scroll.scrollTop = top + ROW - height;
    }
  }

  openSearch(): void {
    this.searchBar.hidden = false;
    this.searchInput.focus();
    this.searchInput.select();
  }

  private closeSearch(): void {
    this.searchBar.hidden = true;
    this.results.hidden = true;
    this.searchInput.value = "";
    this.setSearch("");
    this.focus();
  }

  private setSearch(query: string, jump = true): void {
    this.search = query.trim().toLowerCase();
    this.matches = [];
    if (this.search) {
      this.graph.commits.forEach((c, i) => {
        if (c.kind === "workInProgress") return;
        if (
          c.subject.toLowerCase().includes(this.search) ||
          c.author.toLowerCase().includes(this.search) ||
          c.email.toLowerCase().includes(this.search) ||
          c.oid.startsWith(this.search)
        ) {
          this.matches.push(i);
        }
      });
    }
    this.matchSet = new Set(this.matches);
    this.matchIndex = -1;
    this.root.classList.toggle("searching", Boolean(this.search));
    if (jump && this.matches.length) this.step(1);
    this.updateCount();
    this.invalidate();
  }

  private step(direction: 1 | -1): void {
    if (!this.matches.length) return;
    this.matchIndex = (this.matchIndex + direction + this.matches.length) % this.matches.length;
    const index = this.matches[this.matchIndex];
    this.view.selectCommit(this.graph.commits[index].oid, { scroll: "center" });
    this.updateCount();
  }

  private updateCount(): void {
    this.searchCount.textContent = this.search
      ? this.matches.length
        ? `${this.matchIndex + 1} of ${this.matches.length}`
        : "No matches"
      : "";
  }

  private onKey(event: KeyboardEvent): void {
    const keys: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
    const step = keys[event.key];
    if (step === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const current = this.indexOf(this.view.selectedOid() ?? "");
    const next = Math.min(Math.max(current + step, 0), this.graph.commits.length - 1);
    const commit = this.graph.commits[next];
    if (commit) this.view.selectCommit(commit.oid, { scroll: "nearest" });
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const total = this.graph.commits.length;
    const height = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((this.scroll.scrollTop + height) / ROW) + OVERSCAN);

    for (const [index, node] of this.rendered) {
      if (index < first || index > last) {
        node.remove();
        this.rendered.delete(index);
      }
    }
    for (let i = first; i <= last; i++) {
      if (!this.rendered.has(i)) {
        const node = this.renderRow(i);
        this.rendered.set(i, node);
        this.spacer.append(node);
      }
    }
    this.drawLanes(first, last);
    if (!this.columns.hidden.includes("changes")) this.requestStats(first, last);
  }

  private requestStats(first: number, last: number): void {
    const wanted = this.graph.commits
      .slice(first, last + 1)
      .filter((c) => c.kind === "commit" && !this.stats.has(c.oid) && !this.pendingStats.has(c.oid))
      .map((c) => c.oid);
    if (!wanted.length) return;
    for (const oid of wanted) this.pendingStats.add(oid);
    window.clearTimeout(this.statsTimer);
    this.statsTimer = window.setTimeout(() => {
      const batch = [...this.pendingStats];
      api.commitStats(this.view.id, batch).then(
        (stats) => {
          for (const stat of stats) this.stats.set(stat.oid, stat);
          for (const oid of batch) this.pendingStats.delete(oid);
          for (const row of this.rendered.values()) {
            const cell = row.querySelector<HTMLElement>(".col-changes");
            if (cell && row.dataset.oid) this.fillChanges(cell, row.dataset.oid);
          }
        },
        () => {
          for (const oid of batch) this.pendingStats.delete(oid);
        },
      );
    }, 120);
  }

  /** `+12 −3` and a bar split by their share. */
  private fillChanges(cell: HTMLElement, oid: string): void {
    const stat = this.stats.get(oid);
    if (!stat) return void cell.replaceChildren();
    const total = stat.insertions + stat.deletions;
    const bar = el("span", "change-bar");
    if (total) {
      const width = Math.min(48, 8 + Math.log2(total + 1) * 5);
      bar.style.width = `${width}px`;
      bar.style.setProperty("--added", `${(stat.insertions / total) * 100}%`);
    }
    cell.replaceChildren(el("span", "added", `+${stat.insertions}`), el("span", "removed", `−${stat.deletions}`), bar);
    cell.title = `${plural(stat.files, "file")} changed, ${stat.insertions} added, ${stat.deletions} removed`;
  }

  private applyColumns(): void {
    const { widths, hidden } = this.columns;
    for (const id of Object.keys(widths) as ColumnId[]) {
      if (id === "graph") continue;
      this.root.style.setProperty(`--col-${id}`, `${widths[id]}px`);
      this.root.classList.toggle(`hide-col-${id}`, hidden.includes(id));
    }
    this.root.style.setProperty("--refs-width", hidden.includes("refs") ? "0px" : `${widths.refs}px`);
  }

  private refsWidth(): number {
    return this.columns.hidden.includes("refs") ? 0 : this.columns.widths.refs;
  }

  private columnMenu(at: { x: number; y: number }): void {
    const items: MenuItem[] = [{ heading: "Columns" }];
    for (const [id, name] of Object.entries(COLUMN_NAMES) as [ColumnId, string][]) {
      const shown = !this.columns.hidden.includes(id);
      items.push({
        label: name,
        icon: shown ? "check" : undefined,
        action: () => {
          this.columns.hidden = shown ? [...this.columns.hidden, id] : this.columns.hidden.filter((h) => h !== id);
          saveColumns(this.columns);
          this.applyColumns();
          this.invalidate();
        },
      });
    }
    items.push({ separator: true }, {
      label: "Fit the graph to its lanes",
      disabled: !this.columns.widths.graph,
      action: () => {
        this.columns.widths.graph = 0;
        saveColumns(this.columns);
        this.view.graph && this.setData(this.view.graph, this.view.snapshot?.refs ?? [], this.headOid);
      },
    }, {
      label: "Reset columns",
      action: () => {
        this.columns = structuredClone(DEFAULT_COLUMNS);
        saveColumns(this.columns);
        this.applyColumns();
        this.invalidate();
      },
    });
    showMenu(items, at);
  }

  private resizeColumn(event: PointerEvent, id: ColumnId, grip: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = id === "graph" && !this.columns.widths.graph ? this.graphWidth : this.columns.widths[id];
    document.body.classList.add("resizing");
    const move = (e: PointerEvent) => {
      // Refs and the graph grow to the right; the others are right of the message, so they grow to the left.
      const delta = id === "refs" || id === "graph" ? e.clientX - startX : startX - e.clientX;
      this.columns.widths[id] = Math.round(Math.min(Math.max(start + delta, 48), id === "graph" ? 1000 : 480));
      if (id === "graph") {
        this.graphWidth = this.columns.widths.graph;
        this.root.style.setProperty("--graph-width", `${this.graphWidth}px`);
      }
      this.applyColumns();
      this.schedule();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      saveColumns(this.columns);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
  }

  private renderFilterBar(): void {
    const f = this.view.filter;
    const parts: string[] = [];
    if (f.solo.length) parts.push(`Soloing ${f.solo.map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, "")).join(", ")}`);
    else {
      const hiddenBranches = f.hidden.filter((h) => !h.endsWith("/*")).length;
      if (hiddenBranches) parts.push(`${plural(hiddenBranches, "branch", "branches")} hidden`);
      if (f.hidden.includes("refs/tags/*")) parts.push("tags hidden");
      if (f.hidden.some((h) => h.startsWith("refs/remotes/") && h.endsWith("/*"))) parts.push("some remotes hidden");
    }
    if (f.hideStashes && !f.solo.length) parts.push("stashes hidden");
    this.filterBar.hidden = !parts.length;
    if (!parts.length) return;
    const reset = el("button", "button-secondary small", "Show everything");
    reset.type = "button";
    reset.addEventListener("click", () =>
      this.view.setFilter((filter) => {
        filter.hidden = [];
        filter.solo = [];
        filter.hideStashes = false;
      }),
    );
    this.filterBar.replaceChildren(icon("eyeOff", 14), el("span", "", parts.join(" · ")), reset);
  }

  /** Offers to write a commit-graph when the history loaded slowly without one. */
  private renderIndexBar(): void {
    const took = this.view.slowHistory;
    const root = this.view.info.root;
    this.indexBar.hidden = took === null || indexOfferDismissed(root);
    if (this.indexBar.hidden || this.indexBar.dataset.indexing) return;
    const index = el("button", "button-secondary small", "Index history");
    index.type = "button";
    index.addEventListener("click", async () => {
      this.indexBar.dataset.indexing = "1";
      index.disabled = true;
      index.textContent = "Indexing…";
      try {
        await this.view.actions.indexHistory();
      } finally {
        delete this.indexBar.dataset.indexing;
        this.renderIndexBar();
      }
    });
    const later = iconButton("close", "Not now", () => {
      dismissIndexOffer(root);
      this.indexBar.hidden = true;
    }, "icon-button small");
    this.indexBar.replaceChildren(
      icon("speed", 14),
      el(
        "span",
        "",
        `Loading this history took ${(took! / 1000).toFixed(1)} s. Git can index it (a commit-graph) to make the graph and file history much faster.`,
      ),
      index,
      later,
    );
  }

  /** Searches every commit, for when the match isn't among those loaded. */
  private async searchEverywhere(): Promise<void> {
    const query = this.searchInput.value.trim();
    if (!query) return;
    this.results.hidden = false;
    this.results.replaceChildren(el("div", "search-result-note", "Searching…"));
    let found: GraphCommit[];
    try {
      found = await api.searchCommits(this.view.id, query, 200);
    } catch (error) {
      this.results.replaceChildren(el("div", "search-result-note", errorMessage(error)));
      return;
    }
    const close = iconButton("close", "Close", () => (this.results.hidden = true), "icon-button small");
    this.results.replaceChildren(el("div", "search-result-head", el("span", "", `${plural(found.length, "commit")} in all history${found.length === 200 ? " (the newest 200)" : ""}`), close));
    for (const commit of found) {
      const loaded = this.indexOf(commit.oid) >= 0;
      const row = el(
        "div",
        `search-result${loaded ? "" : " outside"}`,
        el("span", "mono", shortSha(commit.oid)),
        el("span", "search-result-subject", commit.subject),
        el("span", "search-result-meta", `${commit.author} · ${relativeTime(commit.authorTime)}`),
      );
      row.title = loaded ? "Show in the graph" : "Not among the loaded commits: shows its details";
      row.addEventListener("click", () => {
        if (loaded) this.view.selectCommit(commit.oid, { scroll: "center" });
        else void this.view.detail.show(commit.oid);
      });
      this.results.append(row);
    }
    if (!found.length) this.results.append(el("div", "search-result-note", "Nothing anywhere in the history matches."));
  }

  private renderRow(index: number): HTMLElement {
    const commit = this.graph.commits[index];
    const layout = this.graph.rows[index];
    const color = laneColor(layout?.color ?? 0);
    const selected = this.view.isSelected(commit.oid);
    const row = el("div", "graph-row");
    row.style.top = `${index * ROW}px`;
    row.style.setProperty("--lane-color", color);
    row.classList.toggle("selected", selected);
    row.classList.toggle("head", commit.oid === this.headOid);
    row.classList.toggle("wip", commit.kind === "workInProgress");
    row.classList.toggle("stash", commit.kind === "stash");
    if (this.search) {
      row.classList.toggle("match", this.matchSet.has(index));
      row.classList.toggle("current-match", this.matches[this.matchIndex] === index);
    }
    row.dataset.oid = commit.oid;

    row.append(this.refsCell(commit, color), el("div", "col col-graph"));
    if (commit.kind === "workInProgress") {
      row.append(this.wipCell(), el("div", "col col-author"), el("div", "col col-changes"), el("div", "col col-date"), el("div", "col col-sha"));
    } else {
      const message = el("div", "col col-message");
      if (commit.kind === "stash") message.append(icon("stash", 13));
      message.append(el("span", "subject", commit.subject || "(no message)"));
      const author = el("div", "col col-author", el("span", "author-name", commit.author));
      author.title = commit.email ? `${commit.author} <${commit.email}>` : commit.author;
      const date = el("div", "col col-date mono", formatTime(commit.authorTime, this.view.settings().dateFormat));
      date.title = new Date(commit.authorTime * 1000).toLocaleString();
      const changes = el("div", "col col-changes");
      this.fillChanges(changes, commit.oid);
      row.append(message, author, changes, date, el("div", "col col-sha mono", shortSha(commit.oid)));
    }

    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const toggle = isMac ? event.metaKey : event.ctrlKey;
      this.view.selectCommit(commit.oid, { mode: event.shiftKey ? "range" : toggle ? "toggle" : "single" });
      this.focus();
    });
    row.addEventListener("dblclick", (event) => {
      const chip = (event.target as Element).closest<HTMLElement>(".ref-chip");
      if (chip?.dataset.ref) this.view.actions.checkoutRef(chip.dataset.ref);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const chip = (event.target as Element).closest<HTMLElement>(".ref-chip");
      const point = { x: event.clientX, y: event.clientY };
      // Right-clicking inside a multi-selection acts on all of it.
      if (!chip && this.view.selection().length > 1 && this.view.isSelected(commit.oid)) {
        this.view.actions.multiMenu(this.view.selection(), point);
        return;
      }
      this.view.selectCommit(commit.oid, {});
      if (chip?.dataset.ref) {
        this.view.actions.refMenu(chip.dataset.ref, point);
      } else {
        this.view.actions.commitMenu(commit, point);
      }
    });
    return row;
  }

  private refsCell(commit: GraphCommit, color: string): HTMLElement {
    const cell = el("div", "col col-refs");
    const labels = this.labels.get(commit.oid) ?? [];
    if (commit.kind === "stash") {
      cell.append(el("span", "ref-chip stash-chip", icon("stash", 12), commit.stash ?? "stash"));
      return cell;
    }
    labels.forEach((label, i) => {
      const chip = el("span", "ref-chip");
      chip.style.setProperty("--chip", color);
      chip.classList.toggle("head", label.isHead);
      if (label.tag) {
        chip.classList.add("tag-chip");
        chip.append(icon("tag", 12), el("span", "chip-name", label.name));
        chip.dataset.ref = label.tag.name;
        chip.title = `Tag ${label.name}`;
      } else {
        if (label.isHead) chip.append(icon("check", 12));
        if (label.local) chip.append(icon("laptop", 12));
        if (label.remotes.length) chip.append(icon("cloud", 12));
        chip.append(el("span", "chip-name", label.name));
        chip.dataset.ref = (label.local ?? label.remotes[0]).name;
        const where = [label.local ? "local" : "", ...label.remotes.map((r) => r.short)].filter(Boolean);
        chip.title = `${label.name} (${where.join(", ")})`;
      }
      // Only the first label fits; the rest are counted.
      if (i > 0) chip.classList.add("extra");
      if (!label.tag) chip.addEventListener("pointerdown", (event) => startRefDrag(this.view, chip.dataset.ref!, event));
      cell.append(chip);
    });
    if (labels.length > 1) {
      const more = el("button", "ref-more", `+${labels.length - 1}`);
      more.type = "button";
      more.title = labels.map((l) => l.name).join("\n");
      more.addEventListener("mousedown", (event) => event.stopPropagation());
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        const at = { x: event.clientX, y: event.clientY };
        showMenu(
          [
            { heading: "Branches and tags here" },
            ...labels.map((label) => {
              const ref = label.tag ?? label.local ?? label.remotes[0];
              return { label: label.name, icon: label.tag ? ("tag" as const) : label.isHead ? ("check" as const) : ("branch" as const), action: () => this.view.actions.refMenu(ref.name, at) };
            }),
          ],
          at,
        );
      });
      cell.append(more);
    }
    return cell;
  }

  private wipCell(): HTMLElement {
    const status = this.view.snapshot?.status;
    const cell = el("div", "col col-message wip-message");
    cell.append(el("span", "wip-label", "// WIP"));
    if (status) {
      const counts: [number, string, string][] = [
        [status.conflicted.length, "conflicted", "fileConflict"],
        [status.unstaged.filter((f) => f.kind === "modified" || f.kind === "renamed").length + status.staged.filter((f) => f.kind === "modified" || f.kind === "renamed").length, "modified", "fileModified"],
        [status.unstaged.filter((f) => f.kind === "untracked" || f.kind === "added").length + status.staged.filter((f) => f.kind === "added").length, "added", "fileAdded"],
        [status.unstaged.filter((f) => f.kind === "deleted").length + status.staged.filter((f) => f.kind === "deleted").length, "removed", "fileRemoved"],
      ];
      for (const [count, kind, name] of counts) {
        if (count > 0) {
          cell.append(el("span", `wip-count ${kind}`, icon(name as "fileModified", 12), String(count)));
        }
      }
    }
    return cell;
  }

  private drawLanes(first: number, last: number): void {
    const dpr = window.devicePixelRatio || 1;
    const rows = Math.max(0, last - first + 1);
    const top = first * ROW;
    const width = this.graphWidth;
    const height = rows * ROW;
    const canvas = this.canvas;
    canvas.style.top = `${top}px`;
    canvas.style.left = `${this.refsWidth()}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (rows === 0) return;

    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue("--deep-night").trim() || "#1b1a23";
    const foreground = styles.getPropertyValue("--fg").trim() || "#f8f8f2";
    const x = (lane: number) => PAD + lane * LANE + LANE / 2;
    const y = (index: number) => index * ROW + ROW / 2 - top;
    // Lines first, so dots sit on top. Row i's edges come from row i - 1;
    // the row below the last visible one still draws into view.
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const end = Math.min(last + 1, this.graph.rows.length - 1);
    for (let i = Math.max(first, 1); i <= end; i++) {
      for (const edge of this.graph.rows[i].edges) {
        const x1 = x(edge.from);
        const x2 = x(edge.to);
        const y1 = y(i - 1);
        const y2 = y(i);
        ctx.strokeStyle = laneColor(edge.color);
        ctx.setLineDash(edge.dashed ? [3, 3] : []);
        ctx.globalAlpha = this.search ? 0.45 : 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (x1 === x2) {
          ctx.lineTo(x2, y2);
        } else {
          ctx.bezierCurveTo(x1, y1 + ROW * 0.55, x2, y2 - ROW * 0.55, x2, y2);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (let i = first; i <= last; i++) {
      const commit = this.graph.commits[i];
      const layout = this.graph.rows[i];
      const cx = x(layout.lane);
      const cy = y(i);
      const color = laneColor(layout.color);
      const dim = this.search && !this.matchSet.has(i);
      ctx.globalAlpha = dim ? 0.35 : 1;
      if (commit.kind === "workInProgress") {
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = color;
        ctx.fillStyle = background;
        circle(ctx, cx, cy, 9);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (commit.kind === "stash") {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = color;
        ctx.fillStyle = background;
        ctx.beginPath();
        ctx.roundRect(cx - 8, cy - 8, 16, 16, 4);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (commit.parents.length > 1) {
        ctx.fillStyle = color;
        circle(ctx, cx, cy, 6);
        ctx.fill();
      } else {
        ctx.fillStyle = this.view.settings().showAvatars ? avatarColor(commit.email || commit.author) : color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        circle(ctx, cx, cy, 10);
        ctx.fill();
        ctx.stroke();
        if (this.view.settings().showAvatars) {
          ctx.fillStyle = background;
          ctx.font = "700 9px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(initials(commit.author), cx, cy + 0.5);
        }
      }
      const isSelected = this.view.isSelected(commit.oid);
      if (isSelected || commit.oid === this.headOid) {
        ctx.strokeStyle = isSelected ? foreground : color;
        ctx.lineWidth = 1.5;
        circle(ctx, cx, cy, commit.parents.length > 1 && commit.kind === "commit" ? 9 : 13);
        ctx.stroke();
        ctx.lineWidth = 2;
      }
    }
    ctx.globalAlpha = 1;
  }
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function buildLabels(refs: Ref[]): Map<string, RefLabel[]> {
  const byOid = new Map<string, RefLabel[]>();
  const get = (oid: string) => {
    let list = byOid.get(oid);
    if (!list) byOid.set(oid, (list = []));
    return list;
  };
  for (const ref of refs) {
    const list = get(ref.oid);
    if (ref.kind === "tag") {
      list.push({ name: ref.short, local: null, remotes: [], tag: ref, isHead: false });
      continue;
    }
    const name = ref.kind === "remote" && ref.remote ? ref.short.slice(ref.remote.length + 1) : ref.short;
    let label = list.find((l) => !l.tag && l.name === name);
    if (!label) {
      label = { name, local: null, remotes: [], tag: null, isHead: false };
      list.push(label);
    }
    if (ref.kind === "local") {
      label.local = ref;
      label.isHead = ref.isHead;
    } else {
      label.remotes.push(ref);
    }
  }
  // The checked-out branch first, then local branches, remotes, tags.
  const rank = (l: RefLabel) => (l.isHead ? 0 : l.local ? 1 : l.remotes.length ? 2 : 3);
  for (const list of byOid.values()) list.sort((a, b) => rank(a) - rank(b));
  return byOid;
}

export { WORK_IN_PROGRESS };

const INDEX_DISMISSED_KEY = "gitcthulhu.indexOfferDismissed:";

function indexOfferDismissed(root: string): boolean {
  try {
    return localStorage.getItem(INDEX_DISMISSED_KEY + root) === "1";
  } catch {
    return false;
  }
}

function dismissIndexOffer(root: string): void {
  try {
    localStorage.setItem(INDEX_DISMISSED_KEY + root, "1");
  } catch {
    // Storage is unavailable; the offer comes back next time.
  }
}
