// One open repository: toolbar, branch panel, graph, diff and commit panel.
// It owns the repository's data and refreshes it after every change.
import {
  type DiffTarget,
  type FileChange,
  type Graph,
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
import { DetailPanel } from "./detail-panel";
import { DiffView } from "./diff-view";
import { GraphView } from "./graph-view";
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
  readonly toolbar: Toolbar;
  readonly refPanel: RefPanel;
  readonly graphView: GraphView;
  readonly detail: DetailPanel;
  readonly diff: DiffView;
  private selected: string | null = null;
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
    this.toolbar = new Toolbar(this);
    this.refPanel = new RefPanel(this);
    this.graphView = new GraphView(this);
    this.diff = new DiffView(this);
    this.detail = new DetailPanel(this);

    const center = el("main", "center", this.graphView.root, this.diff.root);
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
    this.root.remove();
  }

  settingsChanged(): void {
    this.applyPanelWidths();
    this.scheduleAutoFetch();
    void this.refresh();
  }

  selectCommit(oid: string, options: { scroll?: "center" | "nearest" }): void {
    const changed = this.selected !== oid;
    this.selected = oid;
    if (options.scroll) {
      this.graphView.scrollToIndex(this.graphView.indexOf(oid), options.scroll === "center");
    }
    if (!changed) return;
    this.graphView.invalidate();
    this.diff.close();
    void this.detail.show(oid);
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

  openDiff(request: DiffRequest): void {
    void this.diff.open(request);
    this.detail.markOpenFile(request);
  }

  closeDiff(): void {
    this.diff.close();
    this.detail.markOpenFile(null);
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
        next = await api.loadGraph(this.id, this.settings().commitLimit, dirty);
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

    // Keep the selection when it still exists; otherwise fall back to the
    // uncommitted changes, then HEAD.
    const has = (oid: string | null) => oid !== null && graph.commits.some((c) => c.oid === oid);
    let selection = this.selected;
    if (!has(selection)) {
      selection = has(WORK_IN_PROGRESS) ? WORK_IN_PROGRESS : (snapshot.head.oid ?? graph.commits[0]?.oid ?? null);
    }
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
