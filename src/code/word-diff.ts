// Word-level changes inside a changed line, for highlighting what exactly
// differs between a removed line and the added line that replaced it.

export type Range = [start: number, end: number];

const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Beyond this many tokens per line, skip word diffs: LCS is quadratic. */
const MAX_TOKENS = 400;

/** Character ranges that changed in `a` and in `b`, or null when the lines differ too much to be worth it. */
export function wordRanges(a: string, b: string): { a: Range[]; b: Range[] } | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS || !ta.length || !tb.length) return null;

  // Longest common subsequence of tokens.
  const n = ta.length;
  const m = tb.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = ta[i] === tb[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  // Mostly different lines read better highlighted whole.
  const shared = ta.filter((_, i) => keepA[i]).join("").trim().length;
  if (shared < Math.min(a.trim().length, b.trim().length) * 0.4) return null;
  return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
}

function ranges(tokens: string[], keep: boolean[]): Range[] {
  const out: Range[] = [];
  let pos = 0;
  tokens.forEach((token, i) => {
    const end = pos + token.length;
    // Whitespace-only differences between kept words aren't worth marking.
    if (!keep[i] && token.trim()) {
      const last = out[out.length - 1];
      if (last && last[1] >= pos - 1) last[1] = end;
      else out.push([pos, end]);
    }
    pos = end;
  });
  return out;
}

/**
 * Pairs removed lines with the added lines that follow them, one to one, as
 * candidates for word diffs. Returns, per line index, the index of its partner.
 */
export function pairChangedLines(kinds: string[]): Map<number, number> {
  const pairs = new Map<number, number>();
  for (let i = 0; i < kinds.length; ) {
    if (kinds[i] !== "removed") {
      i++;
      continue;
    }
    const removedStart = i;
    while (i < kinds.length && kinds[i] === "removed") i++;
    const addedStart = i;
    while (i < kinds.length && kinds[i] === "added") i++;
    const count = Math.min(addedStart - removedStart, i - addedStart);
    for (let k = 0; k < count; k++) {
      pairs.set(removedStart + k, addedStart + k);
      pairs.set(addedStart + k, removedStart + k);
    }
  }
  return pairs;
}
