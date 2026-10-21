// The commit graph: a virtualized table of commits with the lanes drawn on
// a canvas over the graph column. Only the rows in view exist in the DOM.
import { type Graph, type GraphCommit, type Ref, WORK_IN_PROGRESS } from "../api";
import { el } from "../dom";
import { avatarColor, formatTime, initials, laneColor, plural, shortSha } from "../format";
import { icon } from "../icons";
import type { RepoView } from "./repo-view";

export const ROW = 28;
const LANE = 20;
const PAD = 8;
const OVERSCAN = 8;
const REFS_WIDTH = 170;

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
  private graph: Graph = { commits: [], rows: [], truncated: false };
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
    this.searchBar = el("div", "graph-search", icon("search", 14), this.searchInput, this.searchCount, prev, next, closeSearch);
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

    const header = el(
      "div",
      "graph-header",
      el("div", "col col-refs", "Branch / Tag"),
      el("div", "col col-graph", "Graph"),
      el("div", "col col-message", "Commit message"),
      el("div", "col col-author", "Author"),
      el("div", "col col-date", "Date"),
      el("div", "col col-sha", "SHA"),
    );
    this.canvas = el("canvas", "graph-canvas");
    this.spacer = el("div", "graph-spacer", this.canvas);
    this.scroll = el("div", "graph-scroll", this.spacer);
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("aria-label", "Commits");
    this.footer = el("div", "graph-footer");
    this.root = el("div", "graph-view", this.searchBar, header, this.scroll, this.footer);

    this.scroll.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroll);
    this.scroll.addEventListener("keydown", (event) => this.onKey(event));
  }

  setData(graph: Graph, refs: Ref[], headOid: string | null): void {
    this.graph = graph;
    this.headOid = headOid;
    this.labels = buildLabels(refs);
    let maxLane = 0;
    for (const row of graph.rows) {
      maxLane = Math.max(maxLane, row.lane);
      for (const e of row.edges) maxLane = Math.max(maxLane, e.from, e.to);
    }
    this.graphWidth = Math.min(Math.max(PAD * 2 + (maxLane + 1) * LANE, 56), 320);
    this.root.style.setProperty("--graph-width", `${this.graphWidth}px`);
    this.root.style.setProperty("--refs-width", `${REFS_WIDTH}px`);
    this.spacer.style.height = `${graph.commits.length * ROW}px`;
    this.footer.textContent = graph.truncated
      ? `Showing the latest ${plural(graph.commits.length, "commit")}. Raise the limit in Preferences to see more.`
      : "";
    this.footer.hidden = !graph.truncated;
    if (this.search) this.setSearch(this.search, false);
    this.invalidate();
  }

  /** Redraws every row, for example after the selection moved. */
  invalidate(): void {
    for (const node of this.rendered.values()) node.remove();
    this.rendered.clear();
    this.schedule();
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
  }

  private renderRow(index: number): HTMLElement {
    const commit = this.graph.commits[index];
    const layout = this.graph.rows[index];
    const color = laneColor(layout?.color ?? 0);
    const selected = this.view.selectedOid() === commit.oid;
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
      row.append(this.wipCell(), el("div", "col col-author"), el("div", "col col-date"), el("div", "col col-sha"));
    } else {
      const message = el("div", "col col-message");
      if (commit.kind === "stash") message.append(icon("stash", 13));
      message.append(el("span", "subject", commit.subject || "(no message)"));
      const author = el("div", "col col-author", el("span", "author-name", commit.author));
      author.title = commit.email ? `${commit.author} <${commit.email}>` : commit.author;
      const date = el("div", "col col-date mono", formatTime(commit.authorTime, this.view.settings().dateFormat));
      date.title = new Date(commit.authorTime * 1000).toLocaleString();
      row.append(message, author, date, el("div", "col col-sha mono", shortSha(commit.oid)));
    }

    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      this.view.selectCommit(commit.oid, {});
      this.focus();
    });
    row.addEventListener("dblclick", (event) => {
      const chip = (event.target as Element).closest<HTMLElement>(".ref-chip");
      if (chip?.dataset.ref) this.view.actions.checkoutRef(chip.dataset.ref);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const chip = (event.target as Element).closest<HTMLElement>(".ref-chip");
      this.view.selectCommit(commit.oid, {});
      const point = { x: event.clientX, y: event.clientY };
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
      cell.append(chip);
    });
    if (labels.length > 1) {
      const more = el("span", "ref-more", `+${labels.length - 1}`);
      more.title = labels.map((l) => l.name).join("\n");
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
    canvas.style.left = `${REFS_WIDTH}px`;
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

    const x = (lane: number) => PAD + lane * LANE + LANE / 2;
    const y = (index: number) => index * ROW + ROW / 2 - top;
    const selected = this.view.selectedOid();

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
        ctx.fillStyle = "#1b1a23";
        circle(ctx, cx, cy, 9);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (commit.kind === "stash") {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = color;
        ctx.fillStyle = "#1b1a23";
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
          ctx.fillStyle = "#1b1a23";
          ctx.font = "700 9px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(initials(commit.author), cx, cy + 0.5);
        }
      }
      if (commit.oid === selected || commit.oid === this.headOid) {
        ctx.strokeStyle = commit.oid === selected ? "#f8f8f2" : color;
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
