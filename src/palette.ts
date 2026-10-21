// The command palette: commands, branches to check out and repositories to
// open, filtered by fuzzy matching as you type.
import { el } from "./dom";
import { type IconName, icon } from "./icons";

export interface PaletteItem {
  label: string;
  detail?: string;
  icon?: IconName;
  hint?: string;
  group: string;
  action: () => void;
}

/** Scores a subsequence match; higher is better, null is no match. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || /[\s/._-]/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const c of q) {
    const found = t.indexOf(c, ti);
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    if (found === 0 || /[\s/._-]/.test(t[found - 1])) score += 15;
    ti = found + 1;
  }
  return score;
}

export function openPalette(items: PaletteItem[], placeholder = "Type a command, branch or repository"): void {
  document.querySelector(".palette-backdrop")?.remove();
  const input = el("input", "palette-input");
  input.placeholder = placeholder;
  input.spellcheck = false;
  const list = el("div", "palette-list");
  const box = el("div", "palette", el("div", "palette-search", icon("search", 16), input), list);
  const backdrop = el("div", "palette-backdrop", box);
  document.body.append(backdrop);

  let shown: PaletteItem[] = [];
  let active = 0;
  const close = () => backdrop.remove();
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.action();
  };

  const render = () => {
    const query = input.value.trim();
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.detail ?? ""}`) }))
      .filter((s): s is { item: PaletteItem; score: number } => s.score !== null);
    if (query) scored.sort((a, b) => b.score - a.score);
    shown = scored.slice(0, 80).map((s) => s.item);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.replaceChildren();
    let group = "";
    shown.forEach((item, i) => {
      if (!query && item.group !== group) {
        group = item.group;
        list.append(el("div", "palette-group", group));
      }
      const row = el(
        "div",
        `palette-item${i === active ? " active" : ""}`,
        item.icon ? icon(item.icon, 15) : el("span", "menu-icon-space"),
        el("span", "palette-label", item.label),
        item.detail ? el("span", "palette-detail", item.detail) : null,
        item.hint ? el("span", "palette-hint", item.hint) : null,
      );
      row.addEventListener("mousemove", () => {
        if (active !== i) {
          active = i;
          for (const [j, node] of [...list.querySelectorAll(".palette-item")].entries()) node.classList.toggle("active", j === i);
        }
      });
      row.addEventListener("click", () => run(item));
      list.append(row);
    });
    if (!shown.length) list.append(el("div", "palette-empty", "No matches"));
    list.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(shown[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  render();
  input.focus();
}
