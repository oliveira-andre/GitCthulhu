// Builds a line of code: syntax colors, with changed words marked on top.
import { type Segment, tokenize } from "./syntax";
import type { Range } from "./word-diff";

export function codeLine(text: string, lang: string | null, changed: Range[] = []): HTMLElement {
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
      if (inside) piece.classList.add("word-change");
      code.append(piece);
      offset += take;
    }
    pos += s.text.length;
  }
  return code;
}

function span(segment: Segment): HTMLElement {
  const node = document.createElement("span");
  if (segment.cls) node.className = segment.cls;
  node.textContent = segment.text;
  return node;
}
