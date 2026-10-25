// The diff of one file, over the graph. Uncommitted diffs can be staged,
// unstaged or discarded per file, per hunk, per selected lines, or per line
// from the button in its gutter. Right-click looks symbols up and acts on
// the selection.
import { type BlobSource, type DiffTarget, type FileDiff, type Hunk, type Line, type LineAction, type SymbolSearch, api, errorMessage } from "../api";
import { codeLine } from "../code/render";
import { languageFor } from "../code/syntax";
import { type Range, pairChangedLines, wordRanges } from "../code/word-diff";
import { confirmAction } from "../dialogs";
import { el } from "../dom";
import { CHANGE_LABELS, plural, shortSha, splitPath } from "../format";
import { type IconName, icon, iconButton } from "../icons";
import { type MenuItem, showMenu } from "../menu";
import { comboLabel, shortcutLabel } from "../platform";
import { notify } from "../toast";
import { CHANGE_ICONS } from "./detail-panel";
import { compactLayout, compactParts, hunkGap } from "./diff-render";
import type { DiffRequest, RepoView } from "./repo-view";
import { SymbolPeek, type SymbolQuery, findSymbol, lookupItems, lookupKey, sourceOf, startLookups, symbolAt } from "./symbols";

const MAX_LINES = 20_000;
/** Context that shows the whole file as one hunk. */
const FULL_FILE = 100_000;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

type Layout = "compact" | "unified" | "split";
/** Line indexes per hunk. */
type Lines = Map<number, Set<number>>;

const LAYOUTS: { value: Layout; label: string; title: string }[] = [
  { value: "compact", label: "Compact", title: "Each line once: a changed line shows its removed and added words inline" },
  { value: "unified", label: "Detailed", title: "Removed and added lines on rows of their own, with old and new line numbers" },
  { value: "split", label: "Split", title: "Old and new side by side" },
];
const VERBS: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };

export class DiffView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private request: DiffRequest | null = null;
  private diff: FileDiff | null = null;
  /** Selected line indexes, per hunk. */
  private selection: Lines = new Map();
  /** Where a ⇧-click range starts. */
  private anchor: { hunk: number; line: number } | null = null;
  private token = 0;
  /** Shows every line of the file, not just the changes. */
  private fullFile = false;
  /** An open peek, and the row (`hunk:line`) it sits under. */
  private peek: { widget: SymbolPeek; row: string | null } | null = null;
  /** The last word clicked, and its row, for F12. */
  private lastWord: { symbol: string; row: string | null } | null = null;
  /** Text selected before a right-click, which on macOS selects the word under the pointer. */
  private selectedBeforeMenu: string | null = null;

  constructor(private readonly view: RepoView) {
    this.header = el("header", "diff-header");
    this.body = el("div", "diff-body");
    this.root = el("div", "diff-view", this.header, this.body);
    this.root.hidden = true;
    this.root.tabIndex = -1;
    // Escape comes through main.ts (escape()), which sees every key first.
    this.root.addEventListener("keydown", (event) => {
      const key = lookupKey(event);
      if (key) {
        event.preventDefault();
        this.lookUpFromKeyboard(key.search, key.peek);
      }
    });
    this.body.addEventListener("contextmenu", (event) => this.contextMenu(event));
    this.body.addEventListener(
      "mousedown",
      (event) => {
        if (event.button === 2) this.selectedBeforeMenu = this.selectedText();
      },
      true,
    );
    this.body.addEventListener("mouseup", (event) => {
      if (event.button !== 0 || (event.target as Element).closest(".peek")) return;
      const symbol = symbolAt(event, this.body, this.selectedText());
      if (symbol) this.lastWord = { symbol, row: rowKey(event.target as Element) };
    });
  }

  isOpen(): boolean {
    return this.request !== null;
  }

  openFile(): DiffRequest | null {
    return this.request;
  }

  /**
   * `scroll` restores a scroll position, for coming back from "go to".
   * `focus: false` leaves the keyboard where it is, for the file lists' ↑/↓.
   */
  async open(request: DiffRequest, scroll?: number, focus = true): Promise<void> {
    const same = this.request && sameRequest(this.request, request);
    this.view.showCenter("diff");
    this.request = request;
    if (!same) {
      this.clearSelection();
      this.closePeek();
    }
    if (focus) this.root.focus({ preventScroll: true });
    await this.load(scroll ?? (same ? "keep" : "top"));
  }

  close(): void {
    if (!this.request) return;
    this.view.showCenter("graph");
  }

  /** Esc: closes the peek if one is open, otherwise the diff. */
  escape(): void {
    if (this.peek) this.closePeek();
    else this.view.closeDiff();
  }

  /** Forgets the open file; the repository view decides what shows instead. */
  reset(): void {
    this.request = null;
    this.diff = null;
    this.peek = null;
  }

  /** The working tree changed: reload, following a file that moved between staged and unstaged. */
  async refresh(): Promise<void> {
    const request = this.request;
    const status = this.view.snapshot?.status;
    if (!request || !status || (request.target.kind !== "unstaged" && request.target.kind !== "staged")) return;
    const inList = (list: typeof status.staged) => list.find((f) => f.path === request.file.path);
    const unstaged = inList(status.unstaged) ?? inList(status.conflicted);
    const staged = inList(status.staged);
    if (request.target.kind === "unstaged" && !unstaged) {
      if (staged) this.request = { target: { kind: "staged" }, file: staged };
      else return this.view.closeDiff();
    } else if (request.target.kind === "staged" && !staged) {
      if (unstaged) this.request = { target: { kind: "unstaged" }, file: unstaged };
      else return this.view.closeDiff();
    } else {
      this.request = { target: request.target, file: (request.target.kind === "staged" ? staged : unstaged)! };
    }
    this.view.detail.markOpenFile(this.request);
    await this.load("keep");
  }

  private async load(scroll: "top" | "keep" | number): Promise<void> {
    const request = this.request;
    if (!request) return;
    const token = ++this.token;
    if (request.file.kind === "conflicted") {
      // Conflicts belong to the merge tool.
      void this.view.merge.open(request.file.path);
      return;
    }
    this.renderHeader();
    try {
      const diff = await api.fileDiff(this.view.id, request.target, request.file.path, request.file.oldPath ?? null, this.context(), this.view.settings().ignoreWhitespace);
      if (token !== this.token) return;
      this.diff = diff;
      // A selection from an older version of the diff no longer applies.
      if ([...this.selection.keys()].some((h) => h >= diff.hunks.length)) this.clearSelection();
      const kept = this.body.scrollTop;
      this.renderBody();
      this.body.scrollTop = scroll === "top" ? 0 : scroll === "keep" ? kept : scroll;
    } catch (error) {
      if (token === this.token) this.body.replaceChildren(el("div", "diff-notice", errorMessage(error)));
    }
  }

  private context(): number {
    return this.fullFile ? FULL_FILE : this.view.settings().diffContext;
  }

  private layout(): Layout {
    return this.view.settings().diffLayout;
  }

  /** Hunk and line actions. Off while whitespace is ignored: such patches don't apply. */
  private editable(): LineAction[] {
    if (this.view.settings().ignoreWhitespace) return [];
    const kind = this.request?.target.kind;
    return kind === "unstaged" ? ["discard", "stage"] : kind === "staged" ? ["unstage"] : [];
  }

  /** What a line's gutter button does: stage in unstaged changes, unstage in staged ones. */
  private lineAction(): LineAction | null {
    const actions = this.editable();
    return actions.includes("stage") ? "stage" : actions.includes("unstage") ? "unstage" : null;
  }

  private async setOption(change: { layout?: Layout; ignoreWhitespace?: boolean; fullFile?: boolean }): Promise<void> {
    if (change.fullFile !== undefined) this.fullFile = change.fullFile;
    const settings = this.view.settings();
    if (change.layout || change.ignoreWhitespace !== undefined) {
      await this.view.shell.saveSettings({
        ...settings,
        diffLayout: change.layout ?? settings.diffLayout,
        ignoreWhitespace: change.ignoreWhitespace ?? settings.ignoreWhitespace,
      });
    }
    this.clearSelection();
    this.closePeek();
    await this.load("keep");
  }

  /** Compact/detailed/split, full file and ignore whitespace. */
  private viewOptions(): HTMLElement {
    const settings = this.view.settings();
    const layout = el("div", "segmented-tabs");
    for (const option of LAYOUTS) {
      const b = el("button", `seg${settings.diffLayout === option.value ? " on" : ""}`, option.label);
      b.type = "button";
      b.title = option.title;
      b.addEventListener("click", () => void this.setOption({ layout: option.value }));
      layout.append(b);
    }
    const toggle = (label: string, on: boolean, title: string, flip: () => void) => {
      const b = el("button", `toggle${on ? " on" : ""}`, label);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", flip);
      return b;
    };
    return el(
      "div",
      "diff-options",
      layout,
      toggle("Full file", this.fullFile, "Show every line, not just the changes", () => void this.setOption({ fullFile: !this.fullFile })),
      toggle("Ignore whitespace", settings.ignoreWhitespace, "Hide changes that only touch whitespace. Staging hunks and lines is off meanwhile.", () => void this.setOption({ ignoreWhitespace: !settings.ignoreWhitespace })),
    );
  }

  private renderHeader(): void {
    const request = this.request!;
    const file = request.file;
    const { dir, name } = splitPath(file.path);
    const where = targetLabel(request.target);
    const title = el(
      "div",
      `diff-title kind-${file.kind}`,
      icon(CHANGE_ICONS[file.kind], 15),
      el("span", "file-path", el("span", "file-dir", file.oldPath ? `${file.oldPath} → ${dir}` : dir), el("span", "file-name", name)),
      el("span", "diff-where", `${CHANGE_LABELS[file.kind]} · ${where}`),
    );
    const actions = el("div", "diff-actions");
    const target = request.target.kind;
    if (target === "unstaged" && file.kind !== "conflicted") {
      actions.append(
        this.fileButton("Discard file", "trash", true, async () => {
          const ok = await confirmAction({ title: `Discard changes to ${name}?`, message: file.kind === "untracked" ? "The new file is deleted." : "The file goes back to its staged version.", confirmLabel: "Discard", danger: true });
          if (ok) await this.view.attempt("Discard", () => api.discard(this.view.id, [file.path]), { graph: false });
        }),
        this.fileButton("Stage file", "plus", false, () => this.view.attempt("Stage", () => api.stage(this.view.id, [file.path]), { graph: false })),
      );
    } else if (target === "staged") {
      actions.append(this.fileButton("Unstage file", "minus", false, () => this.view.attempt("Unstage", () => api.unstage(this.view.id, [file.path]), { graph: false })));
    }
    if (file.kind !== "untracked" && file.kind !== "added") {
      const history = el("button", "button-secondary small", icon("tree", 13), "History");
      history.type = "button";
      history.title = "Every commit that changed this file";
      history.addEventListener("click", () => void this.view.history.open(file.path, "diff"));
      const blame = el("button", "button-secondary small", "Blame");
      blame.type = "button";
      blame.title = "Who last changed each line";
      blame.addEventListener("click", () => void this.view.history.open(file.path, "blame"));
      actions.append(history, blame);
    }
    if (file.kind !== "deleted") actions.append(iconButton("fileModified", "Open in editor", () => void this.view.actions.openInEditor(file.path)));
    actions.append(iconButton("merge", "Open in the external diff tool (git difftool)", () => void this.view.actions.openDifftool(request.target, file.path)));
    actions.append(iconButton("close", "Close (Esc)", () => this.view.closeDiff()));
    this.header.replaceChildren(title, this.viewOptions(), actions);
  }

  private fileButton(label: string, name: "trash" | "plus" | "minus", danger: boolean, action: () => unknown): HTMLButtonElement {
    const b = el("button", `button-secondary small${danger ? " danger" : ""}`, icon(name, 13), label);
    b.type = "button";
    b.addEventListener("click", () => void action());
    return b;
  }

  private renderBody(): void {
    const diff = this.diff!;
    const request = this.request!;
    const nodes: HTMLElement[] = [];
    const bar = this.selectionBar();
    if (bar) nodes.push(bar);
    if (IMAGE.test(request.file.path)) nodes.push(this.imageComparison());
    if (diff.tooLarge) nodes.push(el("div", "diff-notice", "This diff is too large to show."));
    else if (diff.binary) {
      if (!IMAGE.test(request.file.path)) nodes.push(el("div", "diff-notice", "Binary file: no text diff to show."));
    } else if (!diff.hunks.length) {
      nodes.push(el("div", "diff-notice", diff.newFile ? "Empty file." : this.view.settings().ignoreWhitespace ? "Only whitespace changed." : "No content changes (the mode or the file name may have changed)."));
    } else {
      if (this.view.settings().ignoreWhitespace && this.request?.target.kind !== "commit" && this.request?.target.kind !== "range") {
        nodes.push(el("div", "diff-hint", "Whitespace is ignored, so only whole files can be staged or discarded."));
      }
      const lang = languageFor(request.file.path);
      const layout = this.layout();
      // One file, one card: its hunks stay apart inside it, each under a
      // band with the unchanged lines skipped and its Stage and Discard.
      const card = el("div", "hunks");
      let budget = MAX_LINES;
      diff.hunks.forEach((hunk, index) => {
        if (budget <= 0) return;
        const gap = hunkGap(hunk, diff.hunks[index - 1] ?? null, this.hunkActions(index));
        if (gap) card.append(gap);
        card.append(this.renderHunk(hunk, index, budget, lang, layout));
        budget -= hunk.lines.length;
      });
      nodes.push(card);
      if (budget <= 0) nodes.push(el("div", "diff-notice", `Only the first ${MAX_LINES.toLocaleString()} lines are shown.`));
    }
    this.body.replaceChildren(...nodes);
    this.placePeek();
  }

  /** Re-renders in place, keeping the scroll position. */
  private rerender(): void {
    const scroll = this.body.scrollTop;
    this.renderBody();
    this.body.scrollTop = scroll;
  }

  /** A hunk's Discard and Stage buttons, for the band above it; null in diffs that can't change. */
  private hunkActions(index: number): HTMLElement | null {
    const editable = this.editable();
    if (!editable.length) return null;
    const actions = el("div", "hunk-actions");
    const chosen = this.selection.get(index);
    const selected = chosen ? this.shownCount(new Map([[index, chosen]])) : 0;
    for (const action of editable) {
      const label = selected ? `${VERBS[action]} ${plural(selected, "line")}` : this.fullFile ? `${VERBS[action]} all` : `${VERBS[action]} hunk`;
      const b = el("button", `button-secondary small${action === "discard" ? " danger" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", () => void this.applyHunk(action, index));
      actions.append(b);
    }
    return actions;
  }

  private renderHunk(hunk: Hunk, index: number, budget: number, lang: string | null, layout: Layout): HTMLElement {
    const lines = hunk.lines.slice(0, budget);
    const body =
      layout === "split" ? this.splitRows(lines, index, lang, this.wordChanges(lines)) : layout === "compact" ? this.compactRows(lines, index, lang) : this.unifiedRows(lines, index, lang, this.wordChanges(lines));
    return el("div", `hunk${layout === "split" ? " split-hunk" : ""}`, body);
  }

  /** Changed-word ranges for removed lines paired with the added lines after them. */
  private wordChanges(lines: Line[]): Map<number, Range[]> {
    const out = new Map<number, Range[]>();
    const pairs = pairChangedLines(lines.map((l) => l.kind));
    for (const [i, j] of pairs) {
      if (lines[i].kind !== "removed") continue;
      const ranges = wordRanges(lines[i].text, lines[j].text);
      if (ranges) {
        out.set(i, ranges.a);
        out.set(j, ranges.b);
      }
    }
    return out;
  }

  /** One row per line, numbered once: a changed line shows its removed and added words inline. */
  private compactRows(lines: Line[], hunk: number, lang: string | null): HTMLElement {
    const box = el("div", "hunk-lines compact");
    for (const row of compactLayout(lines)) {
      const parts = compactParts(row, lines, lang);
      const indexes = row.kind === "modified" ? [row.removed, row.added] : [row.index];
      const node = el("div", `line ${parts.kind}`, this.gutter(hunk, indexes, parts.kind), el("span", "ln", parts.number === null ? "" : String(parts.number)), el("span", "sign", parts.sign), parts.code);
      node.dataset.row = `${hunk}:${indexes[indexes.length - 1]}`;
      this.makeSelectable(node, hunk, indexes);
      box.append(node);
    }
    return box;
  }

  /** Removed and added lines on rows of their own, with old and new numbers ("Detailed"). */
  private unifiedRows(lines: Line[], hunk: number, lang: string | null, words: Map<number, Range[]>): HTMLElement {
    const box = el("div", "hunk-lines");
    lines.forEach((line, i) => {
      const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "" : " ";
      const code = line.kind === "noNewline" ? el("span", "code", line.text.replace(/^\\ /, "")) : codeLine(line.text, lang, words.get(i));
      const row = el("div", `line ${line.kind}`, this.gutter(hunk, [i], line.kind), el("span", "ln", line.old === null ? "" : String(line.old)), el("span", "ln", line.new === null ? "" : String(line.new)), el("span", "sign", sign), code);
      row.dataset.row = `${hunk}:${i}`;
      this.makeSelectable(row, hunk, [i]);
      box.append(row);
    });
    return box;
  }

  /** Old on the left, new on the right; a removed run lines up with the added run after it. */
  private splitRows(lines: Line[], hunk: number, lang: string | null, words: Map<number, Range[]>): HTMLElement {
    const box = el("div", "split-lines");
    const cell = (index: number | null, side: "old" | "new") => {
      if (index === null) return el("div", "split-cell empty", this.gutter(hunk, [], "context"));
      const line = lines[index];
      const number = side === "old" ? line.old : line.new;
      const node = el("div", `split-cell line ${line.kind}`, this.gutter(hunk, [index], line.kind), el("span", "ln", number === null ? "" : String(number)), codeLine(line.text, lang, words.get(index)));
      this.makeSelectable(node, hunk, [index]);
      return node;
    };
    const row = (key: number, ...cells: HTMLElement[]) => {
      const node = el("div", "split-row", ...cells);
      node.dataset.row = `${hunk}:${key}`;
      return node;
    };
    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (line.kind === "context") {
        box.append(row(i, cell(i, "old"), cell(i, "new")));
        i++;
      } else if (line.kind === "noNewline") {
        box.append(el("div", "split-row note", el("div", "split-cell note", line.text.replace(/^\\ /, ""))));
        i++;
      } else {
        const removed: number[] = [];
        const added: number[] = [];
        while (i < lines.length && lines[i].kind === "removed") removed.push(i++);
        while (i < lines.length && lines[i].kind === "added") added.push(i++);
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
          box.append(row(added[k] ?? removed[k], cell(removed[k] ?? null, "old"), cell(added[k] ?? null, "new")));
        }
      }
    }
    return box;
  }

  /**
   * The slot left of a line's number. On a changed line, hovering shows a
   * button that stages (or unstages) just that line: + for an added line,
   * − for a removed one, ± for a changed line in the compact layout.
   */
  private gutter(hunk: number, indexes: number[], kind: string): HTMLElement | null {
    const action = this.lineAction();
    if (!action) return null;
    const slot = el("span", "line-gutter");
    const glyph: IconName | null = kind === "added" ? "plus" : kind === "removed" ? "minus" : kind === "modified" ? "change" : null;
    if (!glyph) return slot;
    const what = kind === "added" ? "this line" : kind === "removed" ? "this removal" : "this change";
    const b = el("button", "line-action", icon(glyph, 12));
    b.type = "button";
    b.title = `${VERBS[action]} ${what}`;
    b.setAttribute("aria-label", b.title);
    // The row's own mousedown picks lines; this button acts at once.
    b.addEventListener("mousedown", (event) => event.stopPropagation());
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.applyLines(action, new Map([[hunk, new Set(indexes)]]));
    });
    slot.append(b);
    return slot;
  }

  private makeSelectable(row: HTMLElement, hunk: number, indexes: number[]): void {
    const lines = this.diff!.hunks[hunk].lines;
    const changed = indexes.filter((i) => lines[i].kind === "added" || lines[i].kind === "removed");
    if (!this.editable().length || !changed.length) return;
    row.classList.add("selectable");
    row.dataset.hunk = String(hunk);
    row.dataset.lines = changed.join(",");
    const chosen = this.selection.get(hunk);
    row.classList.toggle("selected", changed.every((i) => chosen?.has(i)));
    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest(".code")) return;
      event.preventDefault();
      this.toggleLines(hunk, changed, event.shiftKey);
    });
  }

  /** Old and new versions of an image, next to each other. */
  private imageComparison(): HTMLElement {
    const request = this.request!;
    const path = request.file.path;
    const oldPath = request.file.oldPath ?? path;
    const target = request.target;
    const sources: [BlobSource, string, BlobSource, string] =
      target.kind === "unstaged"
        ? [{ kind: "index" }, oldPath, { kind: "worktree" }, path]
        : target.kind === "staged"
          ? [{ kind: "revision", rev: "HEAD" }, oldPath, { kind: "index" }, path]
          : target.kind === "commit"
            ? [{ kind: "revision", rev: `${target.oid}^` }, oldPath, { kind: "revision", rev: target.oid }, path]
            : [{ kind: "revision", rev: target.from }, oldPath, { kind: "revision", rev: target.to }, path];
    const side = (label: string, source: BlobSource, file: string) => {
      const frame = el("div", "image-frame", el("div", "diff-notice", "Loading…"));
      api.fileImage(this.view.id, source, file).then(
        (url) => {
          if (!url) return void frame.replaceChildren(el("div", "image-none", "No image"));
          const img = new Image();
          img.src = url;
          img.alt = `${label} version of ${file}`;
          img.addEventListener("load", () => frame.append(el("div", "image-size mono", `${img.naturalWidth} × ${img.naturalHeight}`)), { once: true });
          frame.replaceChildren(img);
        },
        (error) => frame.replaceChildren(el("div", "image-none", errorMessage(error))),
      );
      return el("div", "image-side", el("div", "merge-side-title", label), frame);
    };
    return el("div", "image-compare", side("Before", sources[0], sources[1]), side("After", sources[2], sources[3]));
  }

  /** Picks or unpicks a row's lines; ⇧ picks every changed line from the last pick. */
  private toggleLines(hunk: number, indexes: number[], range: boolean): void {
    const lines = this.diff!.hunks[hunk].lines;
    const chosen = this.selection.get(hunk) ?? new Set<number>();
    if (range && this.anchor?.hunk === hunk) {
      const a = Math.min(this.anchor.line, ...indexes);
      const b = Math.max(this.anchor.line, ...indexes);
      for (let i = a; i <= b; i++) {
        if (lines[i].kind === "added" || lines[i].kind === "removed") chosen.add(i);
      }
    } else if (indexes.every((i) => chosen.has(i))) {
      for (const i of indexes) chosen.delete(i);
    } else {
      for (const i of indexes) chosen.add(i);
    }
    this.anchor = { hunk, line: indexes[0] };
    if (chosen.size) this.selection.set(hunk, chosen);
    else this.selection.delete(hunk);
    this.rerender();
  }

  private clearSelection(): void {
    this.selection.clear();
    this.anchor = null;
  }

  private selectedCount(): number {
    return this.shownCount(this.selection);
  }

  /** How many lines `lines` covers as shown: in the compact layout, a changed line (a removal and an addition) counts once. */
  private shownCount(lines: Lines): number {
    const diff = this.diff;
    if (this.layout() !== "compact" || !diff) return count(lines);
    let n = 0;
    for (const [hunk, chosen] of lines) {
      for (const row of compactLayout(diff.hunks[hunk].lines)) {
        const indexes = row.kind === "modified" ? [row.removed, row.added] : [row.index];
        if (indexes.some((i) => chosen.has(i))) n++;
      }
    }
    return n;
  }

  /** Stages, unstages or discards `lines`, across hunks, in one patch. */
  private async applyLines(action: LineAction, lines: Lines): Promise<void> {
    const request = this.request;
    const diff = this.diff;
    const total = this.shownCount(lines);
    if (!request || !diff || !total) return;
    if (action === "discard") {
      const ok = await confirmAction({ title: `Discard ${plural(total, "line")}?`, message: "These changes are removed from the working tree.", confirmLabel: "Discard", danger: true });
      if (!ok) return;
    }
    const selections = [...lines.entries()].map(([hunk, chosen]) => ({ hunk, header: diff.hunks[hunk].header, lines: [...chosen].sort((a, b) => a - b) }));
    // The diff reloads afterwards, and old line numbers wouldn't match it.
    this.clearSelection();
    await this.view.attempt(VERBS[action], () => api.applySelection(this.view.id, action, request.file.path, selections, this.context()), { graph: false });
  }

  /** "N lines selected" with buttons, above the hunks, when lines are selected. */
  private selectionBar(): HTMLElement | null {
    const total = this.selectedCount();
    if (!total || !this.editable().length) return null;
    const hunks = this.selection.size;
    const bar = el("div", "selection-bar", el("span", "", `${plural(total, "line")} selected${hunks > 1 ? ` in ${hunks} hunks` : ""}`));
    for (const action of this.editable()) {
      const b = el("button", `button-${action === "discard" ? "secondary danger" : "primary"} small`, `${VERBS[action]} ${plural(total, "line")}`);
      b.type = "button";
      b.addEventListener("click", () => void this.applyLines(action, copyLines(this.selection)));
      bar.append(b);
    }
    const clear = el("button", "button-secondary small", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => {
      this.clearSelection();
      this.renderBody();
    });
    bar.append(clear);
    return bar;
  }

  private async applyHunk(action: LineAction, index: number): Promise<void> {
    const request = this.request;
    const diff = this.diff;
    if (!request || !diff) return;
    const chosen = this.selection.get(index);
    const lines = chosen?.size ? [...chosen].sort((a, b) => a - b) : null;
    if (action === "discard") {
      const ok = await confirmAction({
        title: chosen?.size ? `Discard ${plural(this.shownCount(new Map([[index, chosen]])), "line")}?` : "Discard this hunk?",
        message: "These changes are removed from the working tree.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    // The diff reloads afterwards, and old line numbers wouldn't match it.
    this.clearSelection();
    await this.view.attempt(VERBS[action], () => api.applyLines(this.view.id, action, request.file.path, index, diff.hunks[index].header, lines, this.context()), { graph: false });
  }

  // The context menu, lookups and the peek

  private contextMenu(event: MouseEvent): void {
    const target = event.target as Element;
    // The peek's lines aren't the diff's.
    if (!this.diff || target.closest(".peek")) return;
    event.preventDefault();
    const row = rowKey(target);
    const typed = this.selectedBeforeMenu ?? this.selectedText();
    this.selectedBeforeMenu = null;
    const symbol = symbolAt(event, this.body, typed);
    const request = this.request;
    const lookups = symbol && request ? startLookups(this.view, sourceOf(request.target), symbol, request.file.path) : null;
    const clicked = target.closest<HTMLElement>(".line");
    const clickedText = clicked ? shownCode(clicked) : "";
    const lines = this.linesFor(target);
    const text = this.copyText(typed, clickedText);
    const total = this.shownCount(lines);
    const items: MenuItem[] = lookupItems(
      lookups,
      (query) => this.goTo(query),
      (query) => this.showPeek(query, row),
    );
    const actions = this.editable();
    if (actions.length) {
      const hint = total ? plural(total, "line") : undefined;
      items.push({ separator: true });
      if (actions.includes("discard")) items.push({ label: "Discard Selection", icon: "trash", danger: true, hint, disabled: !total, action: () => void this.applyLines("discard", lines) });
      const stage = actions.includes("stage") ? "stage" : "unstage";
      items.push({ label: `${VERBS[stage]} Selection`, icon: stage === "stage" ? "plus" : "minus", hint, disabled: !total, action: () => void this.applyLines(stage, lines) });
    }
    items.push(
      { separator: true },
      { label: "Copy", icon: "copy", hint: comboLabel("mod+c"), disabled: !text, action: () => void this.view.actions.copy(text, text.includes("\n") ? "the lines" : "the text") },
      { separator: true },
      { label: "Command Palette", icon: "command", hint: shortcutLabel("palette"), action: () => this.view.shell.openPalette() },
    );
    showMenu(items, { x: event.clientX, y: event.clientY });
  }

  /**
   * The lines a menu action applies to: the changed lines a text selection
   * spans, else the picked lines, else the changed line clicked (which then
   * shows as picked).
   */
  private linesFor(target: Element): Lines {
    const spanned = this.spannedLines();
    if (spanned) return spanned;
    const node = target.closest<HTMLElement>("[data-lines]");
    const clicked = node ? { hunk: Number(node.dataset.hunk), lines: node.dataset.lines!.split(",").map(Number) } : null;
    const picked = clicked && clicked.lines.every((i) => this.selection.get(clicked.hunk)?.has(i));
    if (this.selection.size && (!clicked || picked)) return copyLines(this.selection);
    if (!clicked) return new Map();
    this.selection = new Map([[clicked.hunk, new Set(clicked.lines)]]);
    this.anchor = { hunk: clicked.hunk, line: clicked.lines[0] };
    this.rerender();
    return copyLines(this.selection);
  }

  /** Changed lines under a text selection that spans several rows. */
  private spannedLines(): Lines | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !this.body.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    const rows = [...this.body.querySelectorAll<HTMLElement>("[data-row]")].filter((r) => range.intersectsNode(r));
    if (rows.length < 2) return null;
    const out: Lines = new Map();
    for (const node of this.body.querySelectorAll<HTMLElement>("[data-lines]")) {
      if (!range.intersectsNode(node)) continue;
      const hunk = Number(node.dataset.hunk);
      const chosen = out.get(hunk) ?? new Set<number>();
      for (const i of node.dataset.lines!.split(",")) chosen.add(Number(i));
      out.set(hunk, chosen);
    }
    return out;
  }

  /** Text selected in the diff, or "". */
  private selectedText(): string {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && this.body.contains(selection.anchorNode) ? selection.toString() : "";
  }

  /** What Copy copies: text the user selected, else the picked lines as shown, else the line clicked. */
  private copyText(typed: string, clicked: string): string {
    if (typed.trim()) return typed;
    const picked = [...this.body.querySelectorAll<HTMLElement>(".line.selected")];
    return picked.length ? picked.map(shownCode).join("\n") : clicked;
  }

  private lookUpFromKeyboard(search: SymbolSearch, peek: boolean): void {
    const selected = window.getSelection()?.toString().trim();
    const fromSelection = selected && IDENTIFIER.test(selected) ? selected : null;
    const symbol = fromSelection ?? this.lastWord?.symbol;
    if (!symbol) {
      notify.info("Click a name in the code first", "Go to Definition and Go to References look up the word you clicked or selected.");
      return;
    }
    const row = fromSelection ? rowKey(window.getSelection()!.anchorNode?.parentElement ?? null) : (this.lastWord?.row ?? null);
    void this.lookUp(search, symbol, row, peek);
  }

  /** "Go to" opens the results over the diff; a peek shows them under the line. */
  private async lookUp(search: SymbolSearch, symbol: string, row: string | null, peek: boolean): Promise<void> {
    const request = this.request;
    if (!request) return;
    const query = await findSymbol(this.view, sourceOf(request.target), symbol, search, request.file.path);
    if (!query || !this.request || !sameRequest(this.request, request)) return;
    if (peek) {
      this.showPeek(query, row);
      return;
    }
    if (!query.matches.length) {
      notify.info(search === "definitions" ? `No definition of ${symbol} found` : `No references to ${symbol} found`);
      return;
    }
    this.goTo(query);
  }

  /** Opens the results over the diff; Back returns here. */
  private goTo(query: SymbolQuery): void {
    const request = this.request;
    if (request) void this.view.code.open(query, 0, { request, scroll: this.body.scrollTop });
  }

  private showPeek(query: SymbolQuery, row: string | null): void {
    this.closePeek();
    const widget = new SymbolPeek(this.view, query, {
      close: () => this.closePeek(),
      open: (index) => {
        const request = this.request;
        if (request) void this.view.code.open(query, index, { request, scroll: this.body.scrollTop });
      },
    });
    this.peek = { widget, row };
    this.placePeek();
    widget.root.scrollIntoView({ block: "nearest" });
    widget.root.focus({ preventScroll: true });
  }

  /** Puts the peek under its row again after a render; it closes when the row is gone. */
  private placePeek(): void {
    const peek = this.peek;
    if (!peek) return;
    const row = peek.row ? this.body.querySelector<HTMLElement>(`[data-row="${peek.row}"]`) : null;
    if (peek.row && !row) {
      this.peek = null;
      return;
    }
    if (row) row.after(peek.widget.root);
    else this.body.prepend(peek.widget.root);
    const hunk = peek.widget.root.closest<HTMLElement>(".hunk");
    peek.widget.root.style.width = `${(hunk ?? this.body).clientWidth - (hunk ? 0 : 20)}px`;
  }

  private closePeek(): void {
    if (!this.peek) return;
    this.peek.widget.root.remove();
    this.peek = null;
    if (!this.root.hidden) this.root.focus({ preventScroll: true });
  }
}

/** The row an element belongs to, as `hunk:line`. */
function rowKey(node: Element | null): string | null {
  return node?.closest<HTMLElement>("[data-row]")?.dataset.row ?? null;
}

/** A row's code as shown, without the removed words of a compact row. */
function shownCode(row: HTMLElement): string {
  const code = row.querySelector(".code")?.cloneNode(true) as HTMLElement | undefined;
  if (!code) return "";
  for (const removed of code.querySelectorAll(".word-removed")) removed.remove();
  return code.textContent ?? "";
}

function count(lines: Lines): number {
  return [...lines.values()].reduce((n, set) => n + set.size, 0);
}

function copyLines(lines: Lines): Lines {
  return new Map([...lines].map(([hunk, set]) => [hunk, new Set(set)]));
}

function targetLabel(target: DiffTarget): string {
  switch (target.kind) {
    case "unstaged":
      return "Unstaged";
    case "staged":
      return "Staged";
    case "commit":
      return `Commit ${shortSha(target.oid)}`;
    case "range":
      return `${shortSha(target.from)}…${shortSha(target.to)}`;
  }
}

function sameRequest(a: DiffRequest, b: DiffRequest): boolean {
  return a.file.path === b.file.path && JSON.stringify(a.target) === JSON.stringify(b.target);
}
