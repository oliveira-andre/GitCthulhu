// One open repository: toolbar, branch panel, graph, diff and commit panel.
// It owns the repository's data and refreshes it after every change.
import {
  type DiffTarget,
  type Extras,
  type FileChange,
  type Graph,
  type RefFilter,
  type RepoInfo,
  type Settings,
  type Snapshot,
  WORK_IN_PROGRESS,
  api,
  errorKind,
  errorMessage,
} from "../api";
import { el } from "../dom";
import { notify, toast } from "../toast";
import { Actions } from "./actions";
import { CodeView } from "./code-view";
import { DetailPanel } from "./detail-panel";
import { DiffView } from "./diff-view";
import { ExtrasActions } from "./extras-actions";
import { GraphView } from "./graph-view";
import { HistoryView } from "./history-view";
import { MergeView } from "./merge-view";
import { RebaseView } from "./rebase-view";
import { TerminalPanel } from "./terminal-panel";
import { RefPanel } from "./ref-panel";
import { Toolbar } from "./toolbar";

/** What the rest of the app offers a repository view. */
export interface Shell {
  settings(): Settings;
  saveSettings(settings: Settings): Promise<void>;
  openRepo(path: string): Promise<void>;
  /** Picks a folder and opens it in a tab of its own. */
  openRepoPicker(): void;
  newTab(): void;
  openPalette(): void;
  openPreferences(): void;
  /** The global name and email changed: the title bar and every composer show it. */
  identityChanged(): void;
}

export interface DiffRequest {
  target: DiffTarget;
  file: FileChange;
}

export interface RunOptions {
  /** Shows a progress notice that follows git's output. */
  progress?: boolean;
  /** Message for success; none for quick local changes. */
  success?: string;
  /** Reload the graph afterwards (default true). */
  graph?: boolean;
}

export class RepoView {
  readonly root: HTMLElement;
  readonly actions: Actions;
  snapshot: Snapshot | null = null;
  graph: Graph | null = null;
  /** Submodules, worktrees, LFS and Gitflow; reloaded with the graph. */
  extras: Extras | null = null;
  readonly extrasActions: ExtrasActions;
  readonly toolbar: Toolbar;
  readonly refPanel: RefPanel;
  readonly graphView: GraphView;
  readonly detail: DetailPanel;
  readonly diff: DiffView;
  readonly rebase: RebaseView;
  readonly merge: MergeView;
  readonly history: HistoryView;
  readonly code: CodeView;
  readonly terminal: TerminalPanel;
  /** Commits in HEAD's history, among those loaded. */
  headAncestors = new Set<string>();
  /** Hidden and soloed refs, remembered per repository on this computer. */
  filter: RefFilter;
  /** Commits loaded beyond the limit in Preferences ("Load more"). */
  private extraCommits = 0;
  /** How long loading the graph took when it was slow for want of a commit-graph. */
  slowHistory: number | null = null;
  private selected: string | null = null;
  /** Several selected commits; empty when one (or none) is selected. */
  private chosen = new Set<string>();
  /** Where a ⇧-click range starts. */
  private anchor: string | null = null;
  private refreshing = false;
  private refreshAgain: { graph: boolean } | null = null;
  private staleWhileHidden = false;
  private visible = false;
  private autoFetch: number | undefined;
  private busy = 0;

  constructor(
    readonly info: RepoInfo,
    readonly shell: Shell,
  ) {
    this.actions = new Actions(this);
    this.extrasActions = new ExtrasActions(this);
    this.filter = loadFilter(info.root);
    this.toolbar = new Toolbar(this);
    this.refPanel = new RefPanel(this);
    this.graphView = new GraphView(this);
    this.diff = new DiffView(this);
    this.rebase = new RebaseView(this);
    this.merge = new MergeView(this);
    this.history = new HistoryView(this);
    this.code = new CodeView(this);
    this.terminal = new TerminalPanel(this);
    this.detail = new DetailPanel(this);

    const center = el("main", "center", this.graphView.root, this.diff.root, this.rebase.root, this.merge.root, this.history.root, this.code.root, this.terminal.root);
    const left = el("div", "resizer", "");
    const right = el("div", "resizer", "");
    const body = el("div", "repo-body", this.refPanel.root, left, center, right, this.detail.root);
    this.root = el("section", "repo-view", this.toolbar.root, body);
    this.applyPanelWidths();
    this.resizable(left, "left");
    this.resizable(right, "right");
    this.scheduleAutoFetch();
  }

  get id(): string {
    return this.info.id;
  }

  settings(): Settings {
    return this.shell.settings();
  }

  selectedOid(): string | null {
    return this.selected;
  }

  isBusy(): boolean {
    return this.busy > 0;
  }

  /** Called when this tab is shown or hidden. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
    if (visible && this.staleWhileHidden) {
      this.staleWhileHidden = false;
      void this.refresh();
    }
  }

  dispose(): void {
    window.clearInterval(this.autoFetch);
    this.terminal.dispose();
    this.root.remove();
  }

  /** Repaints what script colors from the theme: the graph's canvas and labels, and the terminal. */
  themeChanged(): void {
    this.graphView.invalidate();
    this.terminal.applyTheme();
  }

  settingsChanged(): void {
    this.applyPanelWidths();
    this.scheduleAutoFetch();
    void this.refresh();
  }

  /**
   * Selects a commit. `toggle` (⌘/Ctrl-click) adds or removes it and `range`
   * (⇧-click) selects everything from the last plain click; several
   * selected commits can be picked, reverted or compared together. The
   * work-in-progress row and stashes are only ever selected alone.
   */
  selectCommit(oid: string, options: { scroll?: "center" | "nearest"; mode?: "single" | "toggle" | "range" }): void {
    const commits = this.graph?.commits ?? [];
    const multiSelectable = (id: string) => commits.find((c) => c.oid === id)?.kind === "commit";
    const before = [...this.chosen].join();
    const beforePrimary = this.selected;
    let mode = options.mode ?? "single";
    if (mode !== "single" && (!multiSelectable(oid) || !this.selected || !multiSelectable(this.selected))) mode = "single";

    if (mode === "toggle") {
      if (this.chosen.size === 0 && this.selected) this.chosen.add(this.selected);
      if (this.chosen.has(oid) && this.chosen.size > 1) {
        this.chosen.delete(oid);
        oid = [...this.chosen][this.chosen.size - 1];
      } else {
        this.chosen.add(oid);
      }
    } else if (mode === "range") {
      const from = commits.findIndex((c) => c.oid === (this.anchor ?? this.selected));
      const to = commits.findIndex((c) => c.oid === oid);
      const [a, b] = from < to ? [from, to] : [to, from];
      this.chosen = new Set(commits.slice(a, b + 1).filter((c) => c.kind === "commit").map((c) => c.oid));
    } else {
      this.chosen.clear();
      this.anchor = oid;
    }
    if (this.chosen.size === 1) this.chosen.clear();
    this.selected = oid;

    if (options.scroll) {
      this.graphView.scrollToIndex(this.graphView.indexOf(oid), options.scroll === "center");
    }
    if (beforePrimary === this.selected && before === [...this.chosen].join()) return;
    this.graphView.invalidate();
    this.diff.close();
    if (this.chosen.size > 1) void this.detail.showMany(this.selection());
    else void this.detail.show(oid);
  }

  /** The selected commits, newest first (graph order). */
  selection(): string[] {
    if (this.chosen.size < 2) return this.selected ? [this.selected] : [];
    return (this.graph?.commits ?? []).filter((c) => this.chosen.has(c.oid)).map((c) => c.oid);
  }

  isSelected(oid: string): boolean {
    return this.chosen.size > 1 ? this.chosen.has(oid) : this.selected === oid;
  }

  /** Jumps to a commit if the graph has it. */
  revealCommit(oid: string): boolean {
    if (this.graphView.indexOf(oid) < 0) {
      notify.info("That commit isn't in the graph", "It may be beyond the commit limit or hidden.");
      return false;
    }
    this.selectCommit(oid, { scroll: "center" });
    return true;
  }

  /**
   * `scroll` puts the diff back where it was, after "go to" and Back.
   * `focus: false` keeps the keyboard in the file list it was opened from.
   */
  openDiff(request: DiffRequest, scroll?: number, focus = true): void {
    if (request.file.kind === "conflicted") {
      void this.merge.open(request.file.path);
      return;
    }
    void this.diff.open(request, scroll, focus);
    this.detail.markOpenFile(request);
  }

  closeDiff(): void {
    this.diff.close();
    this.detail.markOpenFile(null);
  }

  /** The middle of the view shows one of the graph, a diff, a rebase plan, the merge tool, a file's history or "go to" results. */
  showCenter(which: "graph" | "diff" | "rebase" | "merge" | "history" | "code"): void {
    if (which !== "diff" && this.diff.isOpen()) {
      this.diff.reset();
      this.detail.markOpenFile(null);
    }
    this.graphView.root.hidden = which !== "graph";
    this.diff.root.hidden = which !== "diff";
    this.rebase.root.hidden = which !== "rebase";
    this.merge.root.hidden = which !== "merge";
    this.history.root.hidden = which !== "history";
    this.code.root.hidden = which !== "code";
    if (which === "graph") this.graphView.focus();
  }

  /** Reloads status and refs, and the graph unless `graph` is false. */
  async refresh(options: { graph?: boolean } = {}): Promise<void> {
    const graph = options.graph ?? true;
    if (!this.visible && this.snapshot) {
      this.staleWhileHidden = true;
      return;
    }
    if (this.refreshing) {
      this.refreshAgain = { graph: graph || (this.refreshAgain?.graph ?? false) };
      return;
    }
    this.refreshing = true;
    try {
      const snapshot = await api.snapshot(this.id);
      const dirty = isDirty(snapshot);
      const headMoved = snapshot.head.oid !== this.snapshot?.head.oid;
      const wipChanged = dirty !== (this.graph?.commits[0]?.oid === WORK_IN_PROGRESS);
      let next = this.graph;
      if (graph || !next || headMoved || wipChanged) {
        const started = performance.now();
        const [loaded, extras] = await Promise.all([
          api.loadGraph(this.id, this.settings().commitLimit + this.extraCommits, dirty, this.filter).then((g) => {
            const took = performance.now() - started;
            if (g.indexed) this.slowHistory = null;
            else if (took > SLOW_GRAPH_MS) this.slowHistory = took;
            return g;
          }),
          api.extras(this.id).catch(() => null),
        ]);
        next = loaded;
        this.extras = extras;
      }
      this.apply(snapshot, next);
    } catch (error) {
      if (errorKind(error) === "notOpen") return;
      notify.error("Couldn't read the repository", errorMessage(error));
    } finally {
      this.refreshing = false;
      const again = this.refreshAgain;
      this.refreshAgain = null;
      if (again) void this.refresh(again);
    }
  }

  private apply(snapshot: Snapshot, graph: Graph): void {
    const first = !this.snapshot;
    this.snapshot = snapshot;
    this.graph = graph;
    this.toolbar.render();
    this.refPanel.render();
    this.graphView.setData(graph, snapshot.refs, snapshot.head.oid);
    this.headAncestors = ancestorsOf(graph, snapshot.head.oid);

    // Keep the selection when it still exists; otherwise fall back to the
    // uncommitted changes, then HEAD.
    const has = (oid: string | null) => oid !== null && graph.commits.some((c) => c.oid === oid);
    let selection = this.selected;
    if (!has(selection)) {
      selection = has(WORK_IN_PROGRESS) ? WORK_IN_PROGRESS : (snapshot.head.oid ?? graph.commits[0]?.oid ?? null);
    }
    for (const oid of [...this.chosen]) if (!has(oid)) this.chosen.delete(oid);
    if (this.chosen.size === 1) this.chosen.clear();
    if (selection !== this.selected || first) {
      this.selected = selection;
      this.graphView.invalidate();
      if (first && selection) this.graphView.scrollToIndex(this.graphView.indexOf(selection), true);
      void this.detail.show(selection);
    } else {
      void this.detail.refresh();
    }
    void this.diff.refresh();
  }

  /**
   * Runs one git operation with consistent feedback: a progress notice for
   * network work, errors as notices (conflicts explained), then a refresh.
   */
  async run<T>(label: string, operation: (progress: (line: string) => void) => Promise<T>, options: RunOptions = {}): Promise<T | undefined> {
    const notice = options.progress ? toast("progress", label) : null;
    this.busy++;
    this.toolbar.render();
    try {
      const result = await operation((line) => notice?.update(line));
      if (options.success) {
        if (notice) notice.done("success", options.success);
        else notify.success(options.success);
      } else {
        notice?.close();
      }
      return result;
    } catch (error) {
      const kind = errorKind(error);
      if (kind === "conflicts") {
        const message = "Resolve the conflicted files in the panel on the right, then continue.";
        if (notice) notice.done("error", "Stopped on conflicts", message);
        else notify.error("Stopped on conflicts", message);
      } else if (notice) {
        notice.done("error", `${label} failed`, errorMessage(error));
      } else {
        notify.error(`${label} failed`, errorMessage(error));
      }
      throw error;
    } finally {
      this.busy--;
      await this.refresh({ graph: options.graph ?? true });
    }
  }

  /** Like run, but swallows the error after reporting it. */
  async attempt<T>(label: string, operation: (progress: (line: string) => void) => Promise<T>, options: RunOptions = {}): Promise<T | undefined> {
    try {
      return await this.run(label, operation, options);
    } catch {
      return undefined;
    }
  }

  private applyPanelWidths(): void {
    const s = this.settings();
    this.root.style.setProperty("--left-width", `${s.leftPanelWidth}px`);
    this.root.style.setProperty("--right-width", `${s.rightPanelWidth}px`);
  }

  // What the graph shows

  setFilter(change: (filter: RefFilter) => void): void {
    change(this.filter);
    this.filter.hidden = [...new Set(this.filter.hidden)];
    this.filter.solo = [...new Set(this.filter.solo)];
    saveFilter(this.info.root, this.filter);
    void this.refresh();
  }

  isHidden(refName: string): boolean {
    const f = this.filter;
    if (f.solo.length) return !f.solo.includes(refName);
    return f.hidden.some((pattern) => pattern === refName || (pattern.endsWith("/*") && refName.startsWith(pattern.slice(0, -1))));
  }

  loadMore(): void {
    this.extraCommits += this.settings().commitLimit;
    void this.refresh();
  }

  togglePanel(side: "left" | "right"): void {
    this.root.classList.toggle(`hide-${side}`);
  }

  private resizable(handle: HTMLElement, side: "left" | "right"): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const s = this.settings();
      const start = side === "left" ? s.leftPanelWidth : s.rightPanelWidth;
      let width = start;
      document.body.classList.add("resizing");
      const move = (e: PointerEvent) => {
        const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
        width = Math.round(Math.min(Math.max(start + delta, 180), 640));
        this.root.style.setProperty(`--${side}-width`, `${width}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        const next = { ...this.settings() };
        if (side === "left") next.leftPanelWidth = width;
        else next.rightPanelWidth = width;
        void this.shell.saveSettings(next);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }

  private scheduleAutoFetch(): void {
    window.clearInterval(this.autoFetch);
    const minutes = this.settings().autoFetchMinutes;
    if (minutes > 0) {
      this.autoFetch = window.setInterval(() => {
        if (!this.isBusy() && this.snapshot?.remotes.length) {
          api.fetch(this.id, null).then(
            () => this.refresh(),
            () => undefined,
          );
        }
      }, minutes * 60_000);
    }
  }
}

export function isDirty(snapshot: Snapshot): boolean {
  const s = snapshot.status;
  return s.staged.length > 0 || s.unstaged.length > 0 || s.conflicted.length > 0 || snapshot.state.kind !== "clean";
}

/** Every loaded commit reachable from `head` through parents. */
function ancestorsOf(graph: Graph, head: string | null): Set<string> {
  const seen = new Set<string>();
  if (!head) return seen;
  const parents = new Map(graph.commits.map((c) => [c.oid, c.parents]));
  const stack = [head];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !parents.has(oid)) continue;
    seen.add(oid);
    stack.push(...parents.get(oid)!);
  }
  return seen;
}

const FILTER_KEY = "gitcthulhu.graphFilter:";
/** A graph load slower than this, without a commit-graph, offers to index the history. */
const SLOW_GRAPH_MS = 1000;

function loadFilter(root: string): RefFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY + root) ?? "null") as Partial<RefFilter> | null;
    if (saved) return { hidden: saved.hidden ?? [], solo: saved.solo ?? [], hideStashes: saved.hideStashes ?? false };
  } catch {
    // Storage can be unavailable or hold something else; start clean.
  }
  return { hidden: [], solo: [], hideStashes: false };
}

function saveFilter(root: string, filter: RefFilter): void {
  try {
    localStorage.setItem(FILTER_KEY + root, JSON.stringify(filter));
  } catch {
    // Not remembered this time.
  }
}
