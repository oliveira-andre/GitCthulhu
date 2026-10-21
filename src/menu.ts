// Context menus and dropdowns, positioned at the pointer or under a button.
import { el } from "./dom";
import { icon, type IconName } from "./icons";

export type MenuItem =
  | {
      label: string;
      icon?: IconName;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      action: () => void;
    }
  | { separator: true }
  | { heading: string };

let open: { node: HTMLElement; restore: Element | null } | null = null;

export function closeMenu(): void {
  if (!open) return;
  open.node.remove();
  if (open.restore instanceof HTMLElement) open.restore.focus();
  open = null;
}

export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement): void {
  closeMenu();
  const node = el("div", "menu");
  node.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if ("separator" in item) {
      node.append(el("div", "menu-separator"));
      continue;
    }
    if ("heading" in item) {
      node.append(el("div", "menu-heading", item.heading));
      continue;
    }
    const b = el("button", `menu-item${item.danger ? " danger" : ""}`);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.disabled = item.disabled ?? false;
    b.append(item.icon ? icon(item.icon, 14) : el("span", "menu-icon-space"), el("span", "menu-label", item.label));
    if (item.hint) b.append(el("span", "menu-hint", item.hint));
    b.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    buttons.push(b);
    node.append(b);
  }
  if (buttons.length === 0) return;
  document.body.append(node);

  const rect = node.getBoundingClientRect();
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const anchor = at.getBoundingClientRect();
    x = anchor.left;
    y = anchor.bottom + 4;
  } else {
    ({ x, y } = at);
  }
  x = Math.min(x, window.innerWidth - rect.width - 8);
  y = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y;
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${y}px`;

  open = { node, restore: document.activeElement };
  buttons.find((b) => !b.disabled)?.focus();
  node.addEventListener("keydown", (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      enabled[(index + step + enabled.length) % enabled.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  });
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (open && !open.node.contains(event.target as Node)) closeMenu();
  },
  true,
);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
