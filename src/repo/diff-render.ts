// Read-only rendering of a file diff, for views that only show changes
// (file history), and the compact layout the diff view shares with it.
import type { FileDiff, Hunk, Line } from "../api";
import { codeLine, mergedLine } from "../code/render";
import { languageFor } from "../code/syntax";
import { type Piece, pairChangedLines, wordRanges, mergeWords } from "../code/word-diff";
import { el } from "../dom";
import { plural } from "../format";
import { icon } from "../icons";

const MAX_LINES = 20_000;

/**
 * A row of the compact layout. A removed line and the added line that
 * replaced it share a `modified` row when they're alike; other lines get a
 * row each.
 */
export type CompactRow = { kind: "line"; index: number } | { kind: "modified"; removed: number; added: number; pieces: Piece[] };

/**
 * Lays a hunk out one row per line, so line numbers don't repeat: each
 * removed run pairs with the added run after it, line by line, and lines
 * left unpaired keep their order (removed before added).
 */
export function compactLayout(lines: Line[]): CompactRow[] {
  const rows: CompactRow[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== "removed" && lines[i].kind !== "added") {
      rows.push({ kind: "line", index: i++ });
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (i < lines.length && lines[i].kind === "removed") removed.push(i++);
    while (i < lines.length && lines[i].kind === "added") added.push(i++);
    let waiting: number[] = [];
    let waitingAdded: number[] = [];
    const flush = () => {
      for (const index of [...waiting, ...waitingAdded]) rows.push({ kind: "line", index });
      waiting = [];
      waitingAdded = [];
    };
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const [r, a] = [removed[k], added[k]];
      const pieces = r !== undefined && a !== undefined ? mergeWords(lines[r].text, lines[a].text) : null;
      if (pieces) {
        flush();
        rows.push({ kind: "modified", removed: r, added: a, pieces });
      } else {
        if (r !== undefined) waiting.push(r);
        if (a !== undefined) waitingAdded.push(a);
      }
    }
    flush();
  }
  return rows;
}

/** A compact row's number, sign and code. Only new line numbers show; a removed line has none. */
export function compactParts(row: CompactRow, lines: Line[], lang: string | null): { kind: string; number: number | null; sign: string; code: HTMLElement } {
  if (row.kind === "modified") return { kind: "modified", number: lines[row.added].new, sign: "±", code: mergedLine(row.pieces, lang) };
  const line = lines[row.index];
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "" : " ";
  const code = line.kind === "noNewline" ? el("span", "code", line.text.replace(/^\\ /, "")) : codeLine(line.text, lang);
  return { kind: line.kind, number: line.kind === "removed" || line.kind === "noNewline" ? null : line.new, sign, code };
}

/**
 * The band above a hunk in a file's card: how many unchanged lines lie
 * between it and the hunk before, the function it's in, and on the right its
 * `actions` (Stage and Discard). Without actions, the first hunk only gets a
 * band when the file starts further up.
 */
export function hunkGap(hunk: Hunk, previous: Hunk | null, actions: HTMLElement | null = null): HTMLElement | null {
  // A hunk with no new lines (a pure removal) sits after its newStart.
  const first = (h: Hunk) => (h.newLines > 0 ? h.newStart : h.newStart + 1);
  const last = (h: Hunk) => (h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart);
  const skipped = previous ? first(hunk) - last(previous) - 1 : first(hunk) - 1;
  if (!previous && skipped <= 0 && !actions) return null;
  const context = hunk.header.replace(/^@@[^@]*@@\s?/, "");
  const count = skipped > 0 ? plural(skipped, "unchanged line") : previous ? "" : "Start of file";
  const band = el("div", "hunk-gap", icon("more", 14), el("span", "hunk-skipped", count), context ? el("span", "hunk-context mono", context) : null, actions);
  band.title = hunk.header.match(/^@@[^@]*@@/)?.[0] ?? hunk.header;
  return band;
}

export function renderDiff(diff: FileDiff, compact = false): HTMLElement[] {
  const lang = languageFor(diff.path);
  if (diff.tooLarge) return [el("div", "diff-notice", "This diff is too large to show.")];
  if (diff.binary) return [el("div", "diff-notice", "Binary file: no text diff to show.")];
  if (!diff.hunks.length) return [el("div", "diff-notice", "No content changes (the mode or the file name may have changed).")];
  let budget = MAX_LINES;
  // One file, one card: its hunks stack inside, each under its own header.
  const card = el("div", "hunks");
  const nodes: HTMLElement[] = [card];
  for (const [index, hunk] of diff.hunks.entries()) {
    if (budget <= 0) {
      nodes.push(el("div", "diff-notice", `Only the first ${MAX_LINES.toLocaleString()} lines are shown.`));
      break;
    }
    const lines = el("div", `hunk-lines${compact ? " compact" : ""}`);
    const shown = hunk.lines.slice(0, budget);
    if (compact) {
      for (const row of compactLayout(shown)) {
        const parts = compactParts(row, shown, lang);
        lines.append(el("div", `line ${parts.kind}`, el("span", "ln", parts.number === null ? "" : String(parts.number)), el("span", "sign", parts.sign), parts.code));
      }
    } else {
      const words = new Map<number, [number, number][]>();
      for (const [i, j] of pairChangedLines(shown.map((l) => l.kind))) {
        if (shown[i].kind !== "removed") continue;
        const ranges = wordRanges(shown[i].text, shown[j].text);
        if (ranges) {
          words.set(i, ranges.a);
          words.set(j, ranges.b);
        }
      }
      for (const [i, line] of shown.entries()) {
        const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "" : " ";
        lines.append(
          el(
            "div",
            `line ${line.kind}`,
            el("span", "ln", line.old === null ? "" : String(line.old)),
            el("span", "ln", line.new === null ? "" : String(line.new)),
            el("span", "sign", sign),
            line.kind === "noNewline" ? el("span", "code", line.text.replace(/^\\ /, "")) : codeLine(line.text, lang, words.get(i)),
          ),
        );
      }
    }
    budget -= hunk.lines.length;
    const gap = hunkGap(hunk, diff.hunks[index - 1] ?? null);
    if (gap) card.append(gap);
    card.append(el("div", "hunk", lines));
  }
  return nodes;
}
