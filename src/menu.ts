// Context menus and dropdowns, positioned at the pointer or under a button.
// An item can open a submenu beside it.
import { el } from "./dom";
import { icon, type IconName } from "./icons";

export type MenuItem =
  | {
      label: string;
      icon?: IconName;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Disabled until this resolves to true, for example until a lookup has found something. */
      enabled?: Promise<boolean>;
      /** Shows a check mark in the icon's place, for choices such as the theme. */
      checked?: boolean;
      action: () => void;
    }
  | { label: string; icon?: IconName; disabled?: boolean; enabled?: Promise<boolean>; submenu: MenuItem[] }
  | { separator: true }
  | { heading: string; detail?: string };

interface Level {
  node: HTMLElement;
  buttons: HTMLButtonElement[];
  /** The item in the level above that opened this one. */
  trigger: HTMLButtonElement | null;
}

let open: { levels: Level[]; restore: Element | null } | null = null;

export function closeMenu(): void {
  if (!open) return;
  for (const level of open.levels) level.node.remove();
  if (open.restore instanceof HTMLElement) open.restore.focus();
  open = null;
}

export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement): void {
  closeMenu();
  const restore = document.activeElement;
  const level = build(items, 0, null);
  if (!level) return;
  document.body.append(level.node);

  const rect = level.node.getBoundingClientRect();
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const anchor = at.getBoundingClientRect();
    // A button near the right edge gets its menu aligned to its right side.
    x = anchor.left + rect.width > window.innerWidth - 8 ? anchor.right - rect.width : anchor.left;
    y = anchor.bottom + 4;
  } else {
    ({ x, y } = at);
  }
  place(level.node, x, y, rect);
  open = { levels: [level], restore };
  focusFirst(level);
}

/**
 * Focuses the first enabled item, unless an item above it is still waiting
 * to be enabled: then the menu holds focus until it is (see `enabled`).
 */
function focusFirst(level: Level): void {
  const first = level.buttons.find((b) => !b.disabled || b.classList.contains("pending"));
  if (first && !first.disabled) first.focus();
  else level.node.focus();
}

/** A menu that doesn't fit below `y` opens above it; a submenu (`shift`) moves up just enough. */
function place(node: HTMLElement, x: number, y: number, rect: DOMRect, shift = false): void {
  x = Math.min(x, window.innerWidth - rect.width - 8);
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, shift ? window.innerHeight - rect.height - 8 : y - rect.height);
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${y}px`;
}

function build(items: MenuItem[], depth: number, trigger: HTMLButtonElement | null): Level | null {
  const node = el("div", "menu");
  node.setAttribute("role", "menu");
  node.tabIndex = -1;
  const buttons: HTMLButtonElement[] = [];
  const level: Level = { node, buttons, trigger };
  for (const item of items) {
    if ("separator" in item) {
      node.append(el("div", "menu-separator"));
      continue;
    }
    if ("heading" in item) {
      node.append(el("div", `menu-heading${item.detail !== undefined ? " with-detail" : ""}`, el("span", "menu-heading-title", item.heading), item.detail ? el("span", "menu-heading-detail", item.detail) : null));
      continue;
    }
    const b = el("button", `menu-item${"danger" in item && item.danger ? " danger" : ""}`);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.disabled = item.disabled ?? false;
    if (item.enabled && !b.disabled) {
      b.disabled = true;
      b.classList.add("pending");
      const settle = (ok: boolean) => {
        b.disabled = !ok;
        b.classList.remove("pending");
        if (document.activeElement === node) focusFirst(level);
      };
      item.enabled.then(settle, () => settle(false));
    }
    const checked = "checked" in item ? item.checked : undefined;
    const glyph = checked ? icon("check", 14) : checked === false || !item.icon ? el("span", "menu-icon-space") : icon(item.icon, 14);
    if (checked) b.setAttribute("aria-checked", "true");
    b.append(glyph, el("span", "menu-label", item.label));
    if ("submenu" in item) {
      b.classList.add("has-submenu");
      b.setAttribute("aria-haspopup", "menu");
      b.append(icon("chevronRight", 13));
      const openSub = (focus: boolean) => {
        if (b.disabled) return;
        const sub = openSubmenu(item.submenu, depth + 1, b);
        if (focus) sub?.buttons.find((s) => !s.disabled)?.focus();
      };
      b.addEventListener("pointerenter", () => openSub(false));
      b.addEventListener("click", () => openSub(true));
      b.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          openSub(true);
        }
      });
    } else {
      if (item.hint) b.append(el("span", "menu-hint", item.hint));
      // Pointing at a plain item closes a submenu opened from this level.
      b.addEventListener("pointerenter", () => closeBelow(depth));
      b.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
    }
    buttons.push(b);
    node.append(b);
  }
  if (buttons.length === 0) return null;
  node.addEventListener("keydown", (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      enabled[(index + step + enabled.length) % enabled.length]?.focus();
    } else if (event.key === "Escape" || (event.key === "ArrowLeft" && depth > 0)) {
      event.preventDefault();
      event.stopPropagation();
      if (depth === 0) closeMenu();
      else {
        closeBelow(depth - 1);
        trigger?.focus();
      }
    }
  });
  return level;
}

/** Opens `items` beside `trigger`, replacing any submenu at that depth. */
function openSubmenu(items: MenuItem[], depth: number, trigger: HTMLButtonElement): Level | null {
  if (!open) return null;
  const current = open.levels[depth];
  if (current?.trigger === trigger) return current;
  closeBelow(depth - 1);
  const level = build(items, depth, trigger);
  if (!level) return null;
  document.body.append(level.node);
  const rect = level.node.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const parent = trigger.closest(".menu")!.getBoundingClientRect();
  // Beside the parent menu, or on its left when there's no room on the right.
  const x = parent.right + rect.width + 4 > window.innerWidth - 8 ? parent.left - rect.width - 2 : parent.right + 2;
  place(level.node, x, anchor.top - 6, rect, true);
  open.levels.push(level);
  trigger.classList.add("open");
  return level;
}

/** Closes the submenus deeper than `depth`. */
function closeBelow(depth: number): void {
  if (!open) return;
  for (const level of open.levels.splice(depth + 1)) {
    level.node.remove();
    level.trigger?.classList.remove("open");
  }
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (open && !open.levels.some((level) => level.node.contains(event.target as Node))) closeMenu();
  },
  true,
);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
