// Dragging a branch (a label in the graph, or a row in the left panel)
// onto another branch or a commit, then choosing what to do. Pointer events,
// not HTML5 drag and drop, as in Hostly.
import { el } from "../dom";
import { icon } from "../icons";
import type { RepoView } from "./repo-view";

/** Movement before a press becomes a drag, so clicks still work. */
const THRESHOLD = 5;

export interface DropTarget {
  /** A branch or tag, when dropped on one. */
  ref: string | null;
  oid: string;
}

export function startRefDrag(view: RepoView, refName: string, down: PointerEvent): void {
  if (down.button !== 0) return;
  const source = view.actions.findRef(refName);
  if (!source || source.kind === "tag") return;
  const startX = down.clientX;
  const startY = down.clientY;
  let ghost: HTMLElement | null = null;
  let hovered: HTMLElement | null = null;

  const targetAt = (x: number, y: number): { node: HTMLElement; target: DropTarget } | null => {
    const hit = document.elementFromPoint(x, y);
    const chip = hit?.closest<HTMLElement>(".ref-chip[data-ref], .ref-row[data-ref]");
    if (chip?.dataset.ref) {
      const ref = view.actions.findRef(chip.dataset.ref);
      if (ref && ref.name !== source.name) return { node: chip, target: { ref: ref.name, oid: ref.oid } };
      return null;
    }
    const row = hit?.closest<HTMLElement>(".graph-row[data-oid]");
    const oid = row?.dataset.oid;
    const commit = view.graph?.commits.find((c) => c.oid === oid);
    if (row && commit?.kind === "commit" && commit.oid !== source.oid) return { node: row, target: { ref: null, oid: commit.oid } };
    return null;
  };

  const highlight = (node: HTMLElement | null) => {
    if (hovered === node) return;
    hovered?.classList.remove("drop-target");
    hovered = node;
    hovered?.classList.add("drop-target");
  };

  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      ghost = el("div", "drag-ghost", icon(source.kind === "remote" ? "cloud" : "branch", 13), source.short);
      document.body.append(ghost);
      document.body.classList.add("dragging");
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 10}px`;
    highlight(targetAt(e.clientX, e.clientY)?.node ?? null);
  };

  const finish = (e: PointerEvent | null) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("keydown", key, true);
    highlight(null);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("dragging");
    // The release would otherwise land as a click on whatever is under it.
    // That click comes in the same turn, so the guard only lasts that long.
    const swallow = (c: MouseEvent) => c.stopPropagation();
    window.addEventListener("click", swallow, true);
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!e) return;
    const found = targetAt(e.clientX, e.clientY);
    if (found) view.actions.dropMenu(source.name, found.target, { x: e.clientX, y: e.clientY });
  };
  const up = (e: PointerEvent) => finish(e);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("keydown", key, true);
}
