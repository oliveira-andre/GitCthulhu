// Go to definition and references from code on screen: the identifier under
// the pointer, the lookup (git grep in the core), the menu items, and the
// peek that shows the results inline under a line of a diff.
import { type BlobSource, type DiffTarget, type SymbolMatch, type SymbolSearch, api, errorMessage } from "../api";
import { codeLine } from "../code/render";
import { languageFor } from "../code/syntax";
import type { Range } from "../code/word-diff";
import { el } from "../dom";
import { splitPath } from "../format";
import { icon, iconButton } from "../icons";
import type { MenuItem } from "../menu";
import { comboLabel } from "../platform";
import { notify } from "../toast";
import type { RepoView } from "./repo-view";

export interface SymbolQuery {
  symbol: string;
  search: SymbolSearch;
  source: BlobSource;
  matches: SymbolMatch[];
  truncated: boolean;
}

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const WORD = /[\p{L}\p{N}_$]/u;
/** Prism token types whose words aren't names to look up: keywords, literals, comments, symbols. */
const NOT_NAMES = /\b(keyword|string|template-string|comment|number|boolean|operator|punctuation|regex|char|url|important|doctype|prolog|cdata|entity|attr-value)\b/;
/** Lines shown above and below a match in a peek. */
const PEEK_AROUND = 150;

/** What a diff's lines are read from, and so where its symbols are looked up. */
export function sourceOf(target: DiffTarget): BlobSource {
  switch (target.kind) {
    case "unstaged":
      return { kind: "worktree" };
    case "staged":
      return { kind: "index" };
    case "commit":
      return { kind: "revision", rev: target.oid };
    case "range":
      return { kind: "revision", rev: target.to };
  }
}

/**
 * The name to look up: `selected` when the user selected one, otherwise the
 * word under the pointer in a line of code inside `within`. Not a keyword,
 * string or comment, and not blank space next to a word: the character under
 * the pointer has to be part of the name.
 */
export function symbolAt(event: MouseEvent, within: HTMLElement, selected = ""): string | null {
  const chosen = selected.trim();
  if (IDENTIFIER.test(chosen)) return chosen;
  const caret = caretAt(event.clientX, event.clientY);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  const node = caret.node as Text;
  const host = node.parentElement;
  const code = host?.closest(".code");
  if (!host || !code || !within.contains(code) || NOT_NAMES.test(host.className)) return null;
  // The caret falls between two characters; take the one the pointer is on.
  const index = [caret.offset, caret.offset - 1].find((i) => i >= 0 && i < node.length && covers(node, i, event.clientX, event.clientY));
  if (index === undefined || !WORD.test(node.data[index])) return null;
  // A compact row's removed words sit right against the new ones: a word
  // ends at their edge.
  const removed = host.closest(".word-removed");
  const text = [...code.childNodes]
    .map((child) => {
      const part = child.textContent ?? "";
      const isRemoved = child instanceof Element && child.classList.contains("word-removed");
      return (removed ? child !== removed : isRemoved) ? " ".repeat(part.length) : part;
    })
    .join("");
  const before = document.createRange();
  before.setStart(code, 0);
  before.setEnd(node, index);
  return wordAround(text, before.toString().length);
}

/** Whether character `i` of a text node is drawn under the point. */
function covers(node: Text, i: number, x: number, y: number): boolean {
  const range = document.createRange();
  range.setStart(node, i);
  range.setEnd(node, i + 1);
  const box = range.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  // WebKit (the macOS webview) only has the older call.
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The identifier that `at` is in or touches. */
export function wordAround(text: string, at: number): string | null {
  let start = at;
  let end = at;
  while (start > 0 && WORD.test(text[start - 1])) start--;
  while (end < text.length && WORD.test(text[end])) end++;
  const word = text.slice(start, end);
  return IDENTIFIER.test(word) ? word : null;
}

/** Where `symbol` appears in `text` as a whole word. */
export function symbolRanges(text: string, symbol: string): Range[] {
  const out: Range[] = [];
  for (let at = text.indexOf(symbol); at >= 0; at = text.indexOf(symbol, at + symbol.length)) {
    const end = at + symbol.length;
    if ((at === 0 || !WORD.test(text[at - 1])) && (end === text.length || !WORD.test(text[end]))) out.push([at, end]);
  }
  return out;
}

/**
 * Looks the symbol up. Definitions in the file being read, then in its
 * folder, come first. `quiet` skips the error notice, for lookups made ahead
 * of a click.
 */
export async function findSymbol(view: RepoView, source: BlobSource, symbol: string, search: SymbolSearch, near: string | null, quiet = false): Promise<SymbolQuery | null> {
  try {
    const results = await api.findSymbol(view.id, source, symbol, search);
    let matches = results.matches;
    if (near && search === "definitions") {
      const dir = splitPath(near).dir;
      const rank = (m: SymbolMatch) => (m.path === near ? 0 : splitPath(m.path).dir === dir ? 1 : 2);
      matches = [...matches].sort((a, b) => rank(a) - rank(b));
    }
    return { symbol, search, source, matches, truncated: results.truncated };
  } catch (error) {
    if (!quiet) notify.error(`Couldn't look up ${symbol}`, errorMessage(error));
    return null;
  }
}

/** "3 definitions of `x`", "12 references to `x`". */
export function describeQuery(query: SymbolQuery): (string | HTMLElement)[] {
  const n = query.matches.length;
  const count = query.truncated ? `${n.toLocaleString()}+` : n === 0 ? "No" : n.toLocaleString();
  const one = n === 1 && !query.truncated;
  const what = query.search === "definitions" ? (one ? "definition of" : "definitions of") : one ? "reference to" : "references to";
  return [`${count} ${what} `, el("code", "symbol-name", query.symbol)];
}

export const LOOKUP_KEYS = {
  definitions: comboLabel("f12"),
  references: comboLabel("shift+f12"),
  peekDefinitions: comboLabel("alt+f12"),
  peekReferences: comboLabel("alt+shift+f12"),
};

/** F12 and its variants: which lookup a key press asks for, or null. */
export function lookupKey(event: KeyboardEvent): { search: SymbolSearch; peek: boolean } | null {
  if (event.key !== "F12" || event.metaKey || event.ctrlKey) return null;
  return { search: event.shiftKey ? "references" : "definitions", peek: event.altKey };
}

/** Both lookups for a name, started when its menu opens. */
export interface Lookups {
  definitions: Promise<SymbolQuery | null>;
  references: Promise<SymbolQuery | null>;
}

export function startLookups(view: RepoView, source: BlobSource, symbol: string, near: string | null): Lookups {
  return {
    definitions: findSymbol(view, source, symbol, "definitions", near, true),
    references: findSymbol(view, source, symbol, "references", near, true),
  };
}

/**
 * Go to Definition, Go to References and, where the view can show one, a
 * Peek submenu. Each item turns on only once its lookup has found something,
 * and acts on that result.
 */
export function lookupItems(lookups: Lookups | null, go: (query: SymbolQuery) => void, peek: ((query: SymbolQuery) => void) | null): MenuItem[] {
  const found = (query: Promise<SymbolQuery | null> | undefined) => (query ? query.then((q) => Boolean(q?.matches.length)) : undefined);
  const use = (query: Promise<SymbolQuery | null> | undefined, act: (query: SymbolQuery) => void) => () => void query?.then((q) => q?.matches.length && act(q));
  const definitions = found(lookups?.definitions);
  const references = found(lookups?.references);
  const items: MenuItem[] = [
    { label: "Go to Definition", icon: "code", hint: LOOKUP_KEYS.definitions, disabled: !lookups, enabled: definitions, action: use(lookups?.definitions, go) },
    { label: "Go to References", icon: "references", hint: LOOKUP_KEYS.references, disabled: !lookups, enabled: references, action: use(lookups?.references, go) },
  ];
  if (peek) {
    items.push({
      label: "Peek",
      icon: "peek",
      disabled: !lookups,
      enabled: definitions && references && Promise.all([definitions, references]).then(([a, b]) => a || b),
      submenu: [
        { label: "Peek Definition", icon: "code", hint: LOOKUP_KEYS.peekDefinitions, enabled: definitions, action: use(lookups?.definitions, peek) },
        { label: "Peek References", icon: "references", hint: LOOKUP_KEYS.peekReferences, enabled: references, action: use(lookups?.references, peek) },
      ],
    });
  }
  return items;
}

/** Files read for previews, per query: a peek or a "go to" reads each file once. */
export class FileTexts {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly view: RepoView,
    private readonly source: BlobSource,
  ) {}

  get(path: string): Promise<string | null> {
    let text = this.cache.get(path);
    if (!text) {
      text = api.fileText(this.view.id, this.source, path);
      this.cache.set(path, text);
      // A failure shouldn't stick: the next look tries again.
      text.catch(() => this.cache.delete(path));
    }
    return text;
  }
}

/**
 * Lines `first`..`last` of a file (1-based, inclusive) with line numbers;
 * `line` is marked, with the symbol's occurrences on it.
 */
export function fileLines(text: string, path: string, line: number, symbol: string, first = 1, last = Number.POSITIVE_INFINITY): { node: HTMLElement; target: HTMLElement | null } {
  const lang = languageFor(path);
  const all = text.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const node = el("div", "file-lines");
  let target: HTMLElement | null = null;
  const end = Math.min(all.length, last);
  for (let n = Math.max(1, first); n <= end; n++) {
    const content = all[n - 1];
    const hit = n === line;
    const row = el("div", `line${hit ? " target" : ""}`, el("span", "ln", String(n)), codeLine(content, lang, hit ? symbolRanges(content, symbol) : [], "symbol-hit"));
    if (hit) target = row;
    node.append(row);
  }
  return { node, target };
}

/** A match's line, trimmed, with the symbol marked: for result lists. */
export function matchText(match: SymbolMatch, symbol: string): HTMLElement {
  const text = match.text.trim();
  const node = el("span", "match-text mono");
  let pos = 0;
  for (const [start, end] of symbolRanges(text, symbol)) {
    node.append(text.slice(pos, start), el("mark", "symbol-hit", text.slice(start, end)));
    pos = end;
  }
  node.append(text.slice(pos));
  return node;
}

/**
 * Definitions or references shown inline under a line of a diff, as an
 * editor's peek does: a preview of the chosen match beside the list of
 * them. ↑/↓ choose, Enter opens the match, Esc closes.
 */
export class SymbolPeek {
  readonly root: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly texts: FileTexts;
  private index = 0;
  private token = 0;

  constructor(
    view: RepoView,
    readonly query: SymbolQuery,
    private readonly actions: { close(): void; open(index: number): void },
  ) {
    this.texts = new FileTexts(view, query.source);
    const open = el("button", "button-secondary small", "Open");
    open.type = "button";
    open.title = "Show the whole file (Enter)";
    open.disabled = !query.matches.length;
    open.addEventListener("click", () => actions.open(this.index));
    const header = el(
      "div",
      "peek-header",
      icon("peek", 14),
      el("span", "peek-title", ...describeQuery(query)),
      open,
      iconButton("close", "Close (Esc)", () => actions.close(), "icon-button small"),
    );
    this.preview = el("div", "peek-preview");
    this.list = el("div", "peek-list");
    this.root = el("div", "peek", header, el("div", "peek-body", this.preview, this.list));
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        void this.select(Math.min(Math.max(this.index + step, 0), query.matches.length - 1));
      } else if (event.key === "Enter" && query.matches.length) {
        event.preventDefault();
        event.stopPropagation();
        actions.open(this.index);
      }
    });

    if (!query.matches.length) {
      this.root.classList.add("empty");
      this.preview.append(el("div", "diff-notice", query.search === "definitions" ? "No definition found. Only whole-word matches that look like declarations count." : "No other mentions found."));
      return;
    }
    this.renderList();
    void this.select(0);
  }

  private renderList(): void {
    let path = "";
    for (const [i, match] of this.query.matches.entries()) {
      if (match.path !== path) {
        path = match.path;
        const { dir, name } = splitPath(path);
        this.list.append(el("div", "peek-file", el("span", "file-name", name), el("span", "file-dir", dir)));
      }
      const row = el("div", "peek-row", el("span", "peek-line mono", String(match.line)), matchText(match, this.query.symbol));
      if (match.definition && this.query.search === "references") row.classList.add("definition");
      row.title = `${match.path}:${match.line}`;
      row.addEventListener("click", () => void this.select(i));
      row.addEventListener("dblclick", () => this.actions.open(i));
      this.rows.push(row);
      this.list.append(row);
    }
    if (this.query.truncated) this.list.append(el("div", "peek-more", "Only the first matches are listed."));
  }

  private async select(index: number): Promise<void> {
    const match = this.query.matches[index];
    if (!match) return;
    this.index = index;
    for (const [i, row] of this.rows.entries()) row.classList.toggle("selected", i === index);
    this.rows[index]?.scrollIntoView({ block: "nearest" });
    const token = ++this.token;
    let text: string | null;
    try {
      text = await this.texts.get(match.path);
    } catch (error) {
      if (token === this.token) this.preview.replaceChildren(el("div", "diff-notice", errorMessage(error)));
      return;
    }
    if (token !== this.token) return;
    if (text === null) {
      this.preview.replaceChildren(el("div", "diff-notice", `${match.path} isn't there anymore.`));
      return;
    }
    const { node, target } = fileLines(text, match.path, match.line, this.query.symbol, match.line - PEEK_AROUND, match.line + PEEK_AROUND);
    this.preview.replaceChildren(el("div", "peek-path mono", `${match.path}:${match.line}`), node);
    if (target) this.preview.scrollTop = Math.max(0, target.offsetTop - this.preview.clientHeight / 3);
  }
}
