// "Go to" for definitions and references: the matches on the left, the
// chosen one's file on the right, scrolled to its line. It replaces the graph
// like the other center views. Looking a symbol up from here stacks the new
// results; Back (Esc) steps back through them, then to the diff.
import { type SymbolSearch, errorMessage } from "../api";
import { el } from "../dom";
import { splitPath } from "../format";
import { icon, iconButton } from "../icons";
import { type MenuItem, showMenu } from "../menu";
import { comboLabel, shortcutLabel } from "../platform";
import { notify } from "../toast";
import type { DiffRequest, RepoView } from "./repo-view";
import { FileTexts, type SymbolQuery, describeQuery, fileLines, findSymbol, lookupItems, lookupKey, matchText, startLookups, symbolAt } from "./symbols";

/** Lines shown on each side of the match in a long file. */
const AROUND = 10_000;

export interface DiffPlace {
  request: DiffRequest;
  scroll: number;
}

export class CodeView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private readonly content: HTMLElement;
  private query: SymbolQuery | null = null;
  private texts: FileTexts | null = null;
  private index = 0;
  private rows: HTMLElement[] = [];
  /** Earlier results, for Back. */
  private stack: { query: SymbolQuery; index: number }[] = [];
  /** The diff the first lookup came from. */
  private back: DiffPlace | null = null;
  private token = 0;
  /** The last word clicked in the file, for F12. */
  private lastWord: string | null = null;
  /** Text selected before a right-click, which on macOS selects the word under the pointer. */
  private selectedBeforeMenu: string | null = null;

  constructor(private readonly view: RepoView) {
    this.header = el("header", "history-header");
    this.list = el("nav", "history-list code-list");
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
      if (step === undefined || !this.query) return;
      event.preventDefault();
      void this.select(Math.min(Math.max(this.index + step, 0), this.query.matches.length - 1));
    });
    this.content = el("div", "diff-body code-content");
    this.content.addEventListener("contextmenu", (event) => this.contextMenu(event));
    this.content.addEventListener(
      "mousedown",
      (event) => {
        if (event.button === 2) this.selectedBeforeMenu = this.selectedText();
      },
      true,
    );
    this.content.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.lastWord = symbolAt(event, this.content, this.selectedText());
    });
    this.root = el("div", "history-view code-view", this.header, el("div", "history-body", this.list, this.content));
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (event) => {
      const key = lookupKey(event);
      if (!key) return;
      event.preventDefault();
      const selected = window.getSelection()?.toString().trim();
      const symbol = selected && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(selected) ? selected : this.lastWord;
      if (symbol) void this.lookUp(key.search, symbol);
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Shows results from a diff (`back`) or from nowhere in particular. */
  async open(query: SymbolQuery, index: number, back: DiffPlace | null): Promise<void> {
    this.stack = [];
    this.back = back;
    await this.show(query, index);
  }

  /** Back to the previous results, or to the diff. */
  close(): void {
    if (!this.isOpen()) return;
    const previous = this.stack.pop();
    if (previous) {
      void this.show(previous.query, previous.index);
      return;
    }
    const back = this.back;
    this.back = null;
    this.query = null;
    if (back) this.view.openDiff(back.request, back.scroll);
    else this.view.showCenter("graph");
  }

  private async show(query: SymbolQuery, index: number): Promise<void> {
    this.query = query;
    this.texts = new FileTexts(this.view, query.source);
    this.view.showCenter("code");
    this.root.classList.toggle("single", query.matches.length < 2);
    this.renderHeader();
    this.renderList();
    await this.select(index);
    (query.matches.length > 1 ? this.list : this.root).focus({ preventScroll: true });
  }

  private renderHeader(): void {
    const query = this.query!;
    const nodes: Element[] = [];
    if (this.stack.length || this.back) {
      const back = el("button", "button-secondary small", icon("back", 13), this.stack.length ? "Back" : "Back to diff");
      back.type = "button";
      back.title = "Back (Esc)";
      back.addEventListener("click", () => this.close());
      nodes.push(back);
    }
    nodes.push(icon(query.search === "definitions" ? "code" : "references", 16), el("div", "history-title", el("span", "", ...describeQuery(query))));
    nodes.push(iconButton("close", "Close (Esc)", () => this.close()));
    this.header.replaceChildren(...nodes);
  }

  private renderList(): void {
    const query = this.query!;
    this.rows = [];
    this.list.replaceChildren();
    let path = "";
    for (const [i, match] of query.matches.entries()) {
      if (match.path !== path) {
        path = match.path;
        const { dir, name } = splitPath(path);
        this.list.append(el("div", "code-file", icon("file", 13), el("span", "file-path", el("span", "file-dir", dir), el("span", "file-name", name))));
      }
      const row = el("div", "code-row", el("span", "peek-line mono", String(match.line)), matchText(match, query.symbol));
      if (match.definition && query.search === "references") {
        row.classList.add("definition");
        row.title = "Looks like the definition";
      }
      row.addEventListener("click", () => void this.select(i));
      this.rows.push(row);
      this.list.append(row);
    }
    if (query.truncated) this.list.append(el("div", "peek-more", "Only the first matches are listed."));
  }

  private async select(index: number): Promise<void> {
    const query = this.query;
    const match = query?.matches[index];
    if (!query || !match || !this.texts) return;
    this.index = index;
    for (const [i, row] of this.rows.entries()) row.classList.toggle("selected", i === index);
    this.rows[index]?.scrollIntoView({ block: "nearest" });
    const token = ++this.token;
    const bar = el("div", "history-commit", el("span", "mono", `${match.path}:${match.line}`));
    if (query.source.kind === "worktree") {
      const edit = el("button", "button-secondary small", icon("fileModified", 13), "Open in editor");
      edit.type = "button";
      edit.addEventListener("click", () => void this.view.actions.openInEditor(match.path));
      bar.append(edit);
    }
    let text: string | null;
    try {
      text = await this.texts.get(match.path);
    } catch (error) {
      if (token === this.token) this.content.replaceChildren(bar, el("div", "diff-notice", errorMessage(error)));
      return;
    }
    if (token !== this.token) return;
    if (text === null) {
      this.content.replaceChildren(bar, el("div", "diff-notice", `${match.path} isn't there anymore.`));
      return;
    }
    const { node, target } = fileLines(text, match.path, match.line, query.symbol, match.line - AROUND, match.line + AROUND);
    this.content.replaceChildren(bar, node);
    if (target) this.content.scrollTop = Math.max(0, target.offsetTop - this.content.clientHeight / 2);
  }

  /** Looks a symbol up from the file shown; its results stack on these. */
  private async lookUp(search: SymbolSearch, symbol: string): Promise<void> {
    const query = this.query;
    if (!query) return;
    const found = await findSymbol(this.view, query.source, symbol, search, query.matches[this.index]?.path ?? null);
    if (!found || this.query !== query) return;
    if (!found.matches.length) {
      notify.info(search === "definitions" ? `No definition of ${symbol} found` : `No references to ${symbol} found`);
      return;
    }
    await this.follow(found);
  }

  /** Shows new results over these; Back returns here. */
  private async follow(found: SymbolQuery): Promise<void> {
    const query = this.query;
    if (!query) return;
    this.stack.push({ query, index: this.index });
    await this.show(found, 0);
  }

  /** Text selected in the file, or "". */
  private selectedText(): string {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && this.content.contains(selection.anchorNode) ? selection.toString() : "";
  }

  private contextMenu(event: MouseEvent): void {
    event.preventDefault();
    const selected = this.selectedBeforeMenu ?? this.selectedText();
    this.selectedBeforeMenu = null;
    const symbol = symbolAt(event, this.content, selected);
    const query = this.query;
    const lookups = symbol && query ? startLookups(this.view, query.source, symbol, query.matches[this.index]?.path ?? null) : null;
    const line = (event.target as Element).closest(".line")?.querySelector(".code")?.textContent ?? "";
    const text = selected.trim() ? selected : line;
    const items: MenuItem[] = [
      ...lookupItems(lookups, (found) => void this.follow(found), null),
      { separator: true },
      { label: "Copy", icon: "copy", hint: comboLabel("mod+c"), disabled: !text, action: () => void this.view.actions.copy(text, selected.trim() ? "the selection" : "the line") },
      { separator: true },
      { label: "Command Palette", icon: "command", hint: shortcutLabel("palette"), action: () => this.view.shell.openPalette() },
    ];
    showMenu(items, { x: event.clientX, y: event.clientY });
  }
}
