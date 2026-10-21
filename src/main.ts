import "./fonts";
import { listen } from "@tauri-apps/api/event";
import { WORK_IN_PROGRESS, api, errorMessage, onRepoChanged } from "./api";
import { listenForPrompts } from "./askpass";
import { el } from "./dom";
import { type ShortcutId, isMac, shortcutFor } from "./platform";
import { Workspace } from "./workspace";

/** Commands run from shortcuts and from the macOS menu bar (src-tauri/src/menu.rs). */
type Command = ShortcutId | "cloneRepo" | "initRepo";

/** Dialogs and the palette own the keyboard while they're open. */
function modalOpen(): boolean {
  return document.querySelector("dialog[open], .palette-backdrop") !== null;
}

function handleShortcut(event: KeyboardEvent, workspace: Workspace): void {
  if (event.repeat && !["ArrowDown", "ArrowUp"].includes(event.key)) return;
  if (modalOpen()) return;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const repo = workspace.activeRepo();

  if (mod && !event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) {
    event.preventDefault();
    workspace.selectTab(Number(event.code.slice(5)));
    return;
  }
  if (event.key === "Escape" && repo?.diff.isOpen()) {
    event.preventDefault();
    repo.closeDiff();
    return;
  }
  if (event.key === "Escape" && repo?.rebase.isOpen()) {
    event.preventDefault();
    repo.rebase.close();
    return;
  }
  if (event.key === "Escape" && repo?.merge.isOpen()) {
    event.preventDefault();
    repo.merge.close();
    return;
  }
  if (event.key === "Escape" && repo?.history.isOpen()) {
    event.preventDefault();
    repo.history.close();
    return;
  }

  // s and u stage and unstage the picked files, as in GitKraken, unless typing.
  if (repo && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "s" || event.key === "u")) {
    const target = event.target as Element | null;
    if (!target?.closest?.("input, textarea, [contenteditable], .terminal-panel, .rebase-view")) {
      event.preventDefault();
      if (event.key === "s") repo.detail.stageKey();
      else repo.detail.unstageKey();
      return;
    }
  }

  const id = shortcutFor(event);
  if (!id) return;
  // Off macOS, Ctrl+letter belongs to the shell while the terminal has focus.
  if (!isMac && id !== "toggleTerminal" && (event.target as Element | null)?.closest?.(".terminal-panel")) return;
  // The composer commits on its own, with its own text.
  if (id === "commit" && (event.target as Element | null)?.closest?.(".composer")) return;
  // In a text field, ⌘Z undoes typing (the Edit menu's Undo), not git.
  const typing = (event.target as Element | null)?.closest?.("input, textarea, [contenteditable]");
  if ((id === "undo" || id === "redo" || id === "redoAlt") && typing) return;
  event.preventDefault();
  event.stopPropagation();
  runCommand(id, workspace);
}

function runCommand(id: Command, workspace: Workspace): void {
  switch (id) {
    case "palette":
    case "paletteAlt":
      return workspace.openPalette();
    case "openRepo":
      return workspace.browse();
    case "cloneRepo":
      return workspace.clone();
    case "initRepo":
      return workspace.init();
    case "newTab":
      return workspace.newTab();
    case "closeTab":
      return workspace.closeTab();
    case "reopenTab":
      return workspace.reopenClosed();
    case "nextTab":
      return workspace.cycle(1);
    case "previousTab":
      return workspace.cycle(-1);
    case "settings":
      return void workspace.openPreferences();
    case "zoomIn":
      return workspace.zoom(1);
    case "zoomOut":
      return workspace.zoom(-1);
    case "zoomReset":
      return workspace.zoom(0);
    case "shortcuts":
      return workspace.showShortcuts();
  }
  const repo = workspace.activeRepo();
  if (!repo) return;
  const actions = repo.actions;
  switch (id) {
    case "createBranch": {
      const selected = repo.selectedOid();
      const at = selected && selected !== WORK_IN_PROGRESS && selected !== repo.snapshot?.head.oid ? selected : null;
      return void actions.createBranch(at);
    }
    case "fetch":
      return void actions.fetch();
    case "pull":
      return void actions.pull("merge");
    case "push":
      return void actions.push();
    case "stash":
      return void actions.stash();
    case "pop":
      return void actions.pop();
    case "stageAll":
      return void actions.stageAll();
    case "unstageAll":
      return void actions.unstageAll();
    case "focusMessage":
      return repo.detail.focusMessage();
    case "commit":
      return void repo.detail.commit(false);
    case "toggleLeft":
      return repo.togglePanel("left");
    case "toggleRight":
      return repo.togglePanel("right");
    case "search":
      return repo.graphView.openSearch();
    case "filterRefs":
      return repo.refPanel.focusFilter();
    case "refresh":
      return void repo.refresh();
    case "toggleTerminal":
      return repo.terminal.toggle();
    case "fileHistory":
      return void workspace.openFileFinder(repo);
    case "undo":
      return void actions.undo();
    case "redo":
    case "redoAlt":
      return void actions.redo();
  }
}

async function start(): Promise<void> {
  const [data, info] = await Promise.all([api.loadAppData(), api.appInfo()]);
  document.body.classList.toggle("mac", info.platform === "macos");
  const workspace = new Workspace(data, info);
  workspace.applyAppearance();
  listenForPrompts();
  void onRepoChanged((change) => workspace.repoChanged(change));
  window.addEventListener("keydown", (event) => handleShortcut(event, workspace), true);
  // Menu items with shortcuts take the key before the page sees it, so both
  // paths end in runCommand.
  void listen<string>("menu", (event) => {
    if (!modalOpen()) runCommand(event.payload as Command, workspace);
  });
  // Keep the webview's own menu (reload, inspect) out of the way.
  window.addEventListener("contextmenu", (event) => {
    const target = event.target as Element;
    if (!target.closest("input, textarea, .commit-body, .code")) event.preventDefault();
  });
  await workspace.restore();
}

start().catch((error) => {
  document.body.append(el("pre", "fatal", `GitCthulhu couldn't start:\n${errorMessage(error)}`));
});
