// Keyboard shortcuts, defined once: handlers, tooltips and the palette all
// read this table.

export const isMac = navigator.userAgent.includes("Mac");

export type ShortcutId =
  | "palette"
  | "paletteAlt"
  | "openRepo"
  | "newTab"
  | "closeTab"
  | "reopenTab"
  | "nextTab"
  | "previousTab"
  | "createBranch"
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "pop"
  | "stageAll"
  | "unstageAll"
  | "focusMessage"
  | "commit"
  | "toggleLeft"
  | "toggleRight"
  | "search"
  | "filterRefs"
  | "settings"
  | "refresh"
  | "fileHistory"
  | "toggleTerminal"
  | "undo"
  | "redo"
  | "redoAlt"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "shortcuts";

/** Combos are written for macOS; `mod` is ⌘ there and Ctrl elsewhere. */
export const SHORTCUTS: Record<ShortcutId, { combo: string; label: string }> = {
  palette: { combo: "mod+p", label: "Command palette" },
  paletteAlt: { combo: "mod+shift+p", label: "Command palette" },
  openRepo: { combo: "mod+o", label: "Open repository" },
  newTab: { combo: "mod+t", label: "New tab" },
  closeTab: { combo: "mod+w", label: "Close tab" },
  reopenTab: { combo: "mod+shift+t", label: "Reopen closed tab" },
  nextTab: { combo: isMac ? "ctrl+tab" : "mod+tab", label: "Next tab" },
  previousTab: { combo: isMac ? "ctrl+shift+tab" : "mod+shift+tab", label: "Previous tab" },
  createBranch: { combo: "mod+b", label: "Create branch" },
  fetch: { combo: "mod+l", label: "Fetch" },
  pull: { combo: "mod+shift+l", label: "Pull" },
  push: { combo: "mod+shift+k", label: "Push" },
  stash: { combo: "mod+alt+s", label: "Stash changes" },
  pop: { combo: "mod+alt+shift+s", label: "Pop stash" },
  stageAll: { combo: "mod+shift+s", label: "Stage all changes" },
  unstageAll: { combo: "mod+shift+u", label: "Unstage all changes" },
  focusMessage: { combo: "mod+shift+m", label: "Write a commit message" },
  commit: { combo: "mod+enter", label: "Commit" },
  toggleLeft: { combo: "mod+j", label: "Toggle left panel" },
  toggleRight: { combo: "mod+k", label: "Toggle commit panel" },
  search: { combo: "mod+f", label: "Find commits" },
  filterRefs: { combo: "mod+alt+f", label: "Filter branches" },
  settings: { combo: "mod+,", label: "Preferences" },
  refresh: { combo: "mod+r", label: "Refresh" },
  fileHistory: { combo: "mod+shift+h", label: "File history" },
  toggleTerminal: { combo: "mod+`", label: "Toggle terminal" },
  undo: { combo: "mod+z", label: "Undo" },
  redo: { combo: "mod+shift+z", label: "Redo" },
  redoAlt: { combo: "mod+y", label: "Redo" },
  zoomIn: { combo: "mod+=", label: "Zoom in" },
  zoomOut: { combo: "mod+-", label: "Zoom out" },
  zoomReset: { combo: "mod+0", label: "Actual size" },
  shortcuts: { combo: "mod+/", label: "Keyboard shortcuts" },
};

export function comboOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod) parts.push("mod");
  if (isMac && event.ctrlKey) parts.push("ctrl");
  if (!isMac && event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  let key = event.key.toLowerCase();
  // Alt and Shift change event.key on macOS; fall back to the physical key.
  if (event.code.startsWith("Key")) key = event.code.slice(3).toLowerCase();
  else if (event.code.startsWith("Digit")) key = event.code.slice(5);
  else if (event.code === "Comma") key = ",";
  else if (event.code === "Backquote") key = "`";
  else if (event.code === "Equal") key = "=";
  else if (event.code === "Minus") key = "-";
  else if (event.code === "Slash") key = "/";
  parts.push(key);
  return parts.join("+");
}

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", enter: "↩", tab: "⇥" };

/** `mod+shift+s` → `⇧⌘S` on macOS, `Ctrl+Shift+S` elsewhere. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  if (isMac) {
    const order = ["ctrl", "alt", "shift", "mod"];
    const mods = order.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
    const key = parts.filter((p) => !order.includes(p)).map((k) => MAC_SYMBOLS[k] ?? k.toUpperCase());
    return [...mods, ...key].join("");
  }
  return parts
    .map((p) => (p === "mod" ? "Ctrl" : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

export function shortcutLabel(id: ShortcutId): string {
  return comboLabel(SHORTCUTS[id].combo);
}

export function shortcutFor(event: KeyboardEvent): ShortcutId | null {
  const combo = comboOf(event);
  for (const [id, shortcut] of Object.entries(SHORTCUTS)) {
    if (shortcut.combo === combo) {
      return id as ShortcutId;
    }
  }
  return null;
}
