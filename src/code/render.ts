// Builds a line of code: syntax colors, with changed words marked on top.
import { type Segment, tokenize } from "./syntax";
import type { Piece, Range } from "./word-diff";

/** `changed` ranges get the `mark` class: changed words, or a looked-up symbol. */
export function codeLine(text: string, lang: string | null, changed: Range[] = [], mark = "word-change"): HTMLElement {
  const code = document.createElement("span");
  code.className = "code";
  const segments = tokenize(text, lang);
  if (!changed.length) {
    for (const s of segments) code.append(span(s));
    return code;
  }
  // Split segments at the changed ranges' edges.
  let pos = 0;
  let r = 0;
  for (const s of segments) {
    let offset = 0;
    while (offset < s.text.length) {
      while (r < changed.length && changed[r][1] <= pos + offset) r++;
      const inside = r < changed.length && changed[r][0] <= pos + offset;
      const stop = r < changed.length ? (inside ? changed[r][1] : changed[r][0]) : Number.POSITIVE_INFINITY;
      const take = Math.min(s.text.length - offset, stop - (pos + offset));
      const piece = span({ text: s.text.slice(offset, offset + take), cls: s.cls });
      if (inside) piece.classList.add(mark);
      code.append(piece);
      offset += take;
    }
    pos += s.text.length;
  }
  return code;
}

/**
 * A changed line shown once: the new text with syntax colors and its added
 * words marked, and the removed words put back where they were, struck
 * through (and left out when the line is copied).
 */
export function mergedLine(pieces: Piece[], lang: string | null): HTMLElement {
  let text = "";
  const added: Range[] = [];
  const removed: { at: number; text: string }[] = [];
  for (const piece of pieces) {
    if (piece.kind === "removed") {
      removed.push({ at: text.length, text: piece.text });
      continue;
    }
    if (piece.kind === "added") added.push([text.length, text.length + piece.text.length]);
    text += piece.text;
  }
  const code = codeLine(text, lang, added);
  // Splice the removed words in, splitting the span they fall inside.
  let pos = 0;
  let r = 0;
  for (const child of [...code.children] as HTMLElement[]) {
    let rest = child.textContent ?? "";
    while (r < removed.length && removed[r].at < pos + rest.length) {
      const cut = removed[r].at - pos;
      if (cut > 0) {
        const head = child.cloneNode(false) as HTMLElement;
        head.textContent = rest.slice(0, cut);
        child.before(head);
        rest = rest.slice(cut);
        pos += cut;
      }
      child.before(removedWords(removed[r++].text));
    }
    child.textContent = rest;
    pos += rest.length;
  }
  for (; r < removed.length; r++) code.append(removedWords(removed[r].text));
  return code;
}

function removedWords(text: string): HTMLElement {
  const node = document.createElement("span");
  node.className = "word-removed";
  node.textContent = text;
  return node;
}

function span(segment: Segment): HTMLElement {
  const node = document.createElement("span");
  if (segment.cls) node.className = segment.cls;
  node.textContent = segment.text;
  return node;
}
