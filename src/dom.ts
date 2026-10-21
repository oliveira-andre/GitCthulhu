// Small DOM helpers. User data always goes in through textContent.

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(label: string | Node, onClick: (event: MouseEvent) => void, className = "button-secondary"): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

export function clear(node: Element): void {
  node.replaceChildren();
}
