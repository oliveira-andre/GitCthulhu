// The repository toolbar: where you are, and the everyday remote and stash
// actions, with ahead/behind counts on Pull and Push.
import { type PullMode, api } from "../api";
import { el } from "../dom";
import { shortSha } from "../format";
import { type IconName, icon } from "../icons";
import { showMenu } from "../menu";
import { type ShortcutId, shortcutLabel } from "../platform";
import type { RepoView } from "./repo-view";

const PULL_MODE_KEY = "gitcthulhu.pullMode";
const PULL_LABELS: Record<PullMode, string> = {
  merge: "Pull (fast-forward if possible)",
  fastForwardOnly: "Pull (fast-forward only)",
  rebase: "Pull (rebase)",
};

function savedPullMode(): PullMode {
  try {
    const mode = localStorage.getItem(PULL_MODE_KEY);
    if (mode === "merge" || mode === "fastForwardOnly" || mode === "rebase") return mode;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return "merge";
}

function savePullMode(mode: PullMode): void {
  try {
    localStorage.setItem(PULL_MODE_KEY, mode);
  } catch {
    // Not remembered this time.
  }
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly repoButton: HTMLButtonElement;
  private readonly branchButton: HTMLButtonElement;
  private readonly pullBadge = el("span", "badge");
  private readonly pushBadge = el("span", "badge");
  private readonly stateBanner = el("div", "toolbar-state");
  private readonly actionButtons: HTMLButtonElement[] = [];
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;

  constructor(private readonly view: RepoView) {
    this.repoButton = this.picker("repo", view.info.name, (b) => this.repoMenu(b));
    this.branchButton = this.picker("branch", "", () => view.shell.openPalette());

    const pull = this.action("pull", "Pull", "pull", () => view.actions.pull(savedPullMode()));
    pull.append(this.pullBadge);
    const pullMenu = el("button", "toolbar-caret", icon("chevronDown", 12));
    pullMenu.type = "button";
    pullMenu.title = "Pull options";
    pullMenu.addEventListener("click", () => this.pullMenu(pullMenu));
    const push = this.action("push", "Push", "push", () => view.actions.push());
    push.append(this.pushBadge);

    this.undoButton = this.action("undo", "Undo", "undo", () => view.actions.undo());
    this.redoButton = this.action("redo", "Redo", "redo", () => view.actions.redo());
    const center = el(
      "div",
      "toolbar-actions",
      this.undoButton,
      this.redoButton,
      el("span", "toolbar-gap"),
      el("div", "split", pull, pullMenu),
      push,
      this.action("branchPlus", "Branch", "createBranch", () => view.actions.createBranch()),
      this.action("stash", "Stash", "stash", () => view.actions.stash()),
      this.action("pop", "Pop", "pop", () => view.actions.pop()),
    );
    const right = el(
      "div",
      "toolbar-right",
      this.tool("search", "Find commits", "search", () => view.graphView.openSearch()),
      this.tool("terminal", "Terminal", "toggleTerminal", () => view.terminal.toggle()),
      this.tool("folderOpen", "Show in file manager", null, () => void api.reveal(view.info.root)),
      this.tool("leftPanel", "Toggle left panel", "toggleLeft", () => view.togglePanel("left")),
      this.tool("rightPanel", "Toggle commit panel", "toggleRight", () => view.togglePanel("right")),
    );
    this.root = el("header", "toolbar", el("div", "toolbar-left", this.repoButton, this.branchButton), center, right, this.stateBanner);
  }

  render(): void {
    const snapshot = this.view.snapshot;
    if (!snapshot) return;
    const head = snapshot.head;
    const branchLabel = head.branch ?? (head.oid ? `detached at ${shortSha(head.oid)}` : "no commits yet");
    this.branchButton.querySelector(".picker-label")!.textContent = branchLabel;
    this.branchButton.title = "Switch branch";
    const ref = snapshot.refs.find((r) => r.kind === "local" && r.isHead);
    this.pullBadge.textContent = ref?.behind ? `${ref.behind}` : "";
    this.pullBadge.hidden = !ref?.behind;
    this.pushBadge.textContent = ref?.ahead ? `${ref.ahead}` : "";
    this.pushBadge.hidden = !ref?.ahead;
    for (const b of this.actionButtons) b.disabled = this.view.isBusy();
    const { undo, redo } = snapshot.undo;
    this.undoButton.disabled ||= !undo;
    this.redoButton.disabled ||= !redo;
    this.undoButton.title = undo ? `Undo ${undo.toLowerCase()} (${shortcutLabel("undo")})` : "Nothing to undo";
    this.redoButton.title = redo ? `Redo ${redo.toLowerCase()} (${shortcutLabel("redo")})` : "Nothing to redo";

    const state = snapshot.state;
    const text =
      state.kind === "merging"
        ? "Merging"
        : state.kind === "rebasing"
          ? `Rebasing${state.branch ? ` ${state.branch}` : ""}${state.step && state.total ? ` · ${state.step}/${state.total}` : ""}`
          : state.kind === "cherryPicking"
            ? "Cherry-picking"
            : state.kind === "reverting"
              ? "Reverting"
              : state.kind === "applyingPatches"
                ? `Applying patches${state.step && state.total ? ` · ${state.step}/${state.total}` : ""}`
              : state.kind === "bisecting"
                ? "Bisecting"
                : "";
    this.stateBanner.textContent = text;
    this.stateBanner.hidden = !text;
  }

  private picker(name: IconName, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
    const b = el("button", "picker", icon(name, 14), el("span", "picker-label", label), icon("chevronDown", 12));
    b.type = "button";
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  private action(name: IconName, label: string, shortcut: ShortcutId | null, onClick: () => void): HTMLButtonElement {
    const b = el("button", "toolbar-button", icon(name, 18), el("span", "toolbar-label", label));
    b.type = "button";
    b.title = shortcut ? `${label} (${shortcutLabel(shortcut)})` : label;
    b.addEventListener("click", onClick);
    this.actionButtons.push(b);
    return b;
  }

  private tool(name: IconName, label: string, shortcut: ShortcutId | null, onClick: () => void): HTMLButtonElement {
    const b = el("button", "icon-button", icon(name, 16));
    b.type = "button";
    b.title = shortcut ? `${label} (${shortcutLabel(shortcut)})` : label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  private pullMenu(anchor: HTMLElement): void {
    const current = savedPullMode();
    const choose = (mode: PullMode) => () => {
      savePullMode(mode);
      void this.view.actions.pull(mode);
    };
    showMenu(
      [
        { label: "Fetch all", icon: "refresh", hint: shortcutLabel("fetch"), action: () => this.view.actions.fetch() },
        { separator: true },
        ...(["merge", "fastForwardOnly", "rebase"] as PullMode[]).map((mode) => ({
          label: PULL_LABELS[mode],
          icon: mode === current ? ("check" as const) : undefined,
          action: choose(mode),
        })),
      ],
      anchor,
    );
  }

  private repoMenu(anchor: HTMLElement): void {
    showMenu(
      [
        { label: "Open another repository…", icon: "folderOpen", hint: shortcutLabel("openRepo"), action: () => this.view.shell.openRepoPicker() },
        { label: "New tab", icon: "plus", hint: shortcutLabel("newTab"), action: () => this.view.shell.newTab() },
        { separator: true },
        { label: "Open in editor", icon: "fileModified", action: () => void this.view.actions.openInEditor(null) },
        { label: "Open in the system terminal", icon: "terminal", action: () => void api.openTerminal(this.view.info.root) },
        { label: "Show in file manager", icon: "folder", action: () => void api.reveal(this.view.info.root) },
        { label: "Copy path", icon: "copy", action: () => this.view.actions.copy(this.view.info.root, "the path") },
        { separator: true },
        { label: "Add a remote…", icon: "cloud", action: () => this.view.actions.addRemote() },
        { label: "Apply a patch…", icon: "file", action: () => this.view.actions.applyPatch() },
        { label: "Refresh", icon: "refresh", hint: shortcutLabel("refresh"), action: () => void this.view.refresh() },
      ],
      anchor,
    );
  }
}
