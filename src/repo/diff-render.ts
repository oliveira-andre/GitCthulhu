// Read-only rendering of a file diff, for views that only show changes
// (file history). The diff view has its own, with line selection.
import type { FileDiff } from "../api";
import { codeLine } from "../code/render";
import { languageFor } from "../code/syntax";
import { pairChangedLines, wordRanges } from "../code/word-diff";
import { el } from "../dom";

const MAX_LINES = 20_000;

export function renderDiff(diff: FileDiff): HTMLElement[] {
  const lang = languageFor(diff.path);
  if (diff.tooLarge) return [el("div", "diff-notice", "This diff is too large to show.")];
  if (diff.binary) return [el("div", "diff-notice", "Binary file: no text diff to show.")];
  if (!diff.hunks.length) return [el("div", "diff-notice", "No content changes (the mode or the file name may have changed).")];
  let budget = MAX_LINES;
  const nodes: HTMLElement[] = [];
  for (const hunk of diff.hunks) {
    if (budget <= 0) {
      nodes.push(el("div", "diff-notice", `Only the first ${MAX_LINES.toLocaleString()} lines are shown.`));
      break;
    }
    const lines = el("div", "hunk-lines");
    const shown = hunk.lines.slice(0, budget);
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
    budget -= hunk.lines.length;
    const context = hunk.header.replace(/^@@[^@]*@@\s?/, "");
    nodes.push(
      el(
        "div",
        "hunk",
        el("div", "hunk-header", el("span", "hunk-range mono", `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), el("span", "hunk-context mono", context)),
        lines,
      ),
    );
  }
  return nodes;
}
