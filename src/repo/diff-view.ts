// The diff of one file, over the graph. Uncommitted diffs can be staged,
// unstaged or discarded per file, per hunk, or per selected lines.
import { type BlobSource, type DiffTarget, type FileDiff, type Hunk, type Line, type LineAction, api, errorMessage } from "../api";
import { codeLine } from "../code/render";
import { languageFor } from "../code/syntax";
import { type Range, pairChangedLines, wordRanges } from "../code/word-diff";
import { confirmAction } from "../dialogs";
import { el } from "../dom";
import { CHANGE_LABELS, plural, shortSha, splitPath } from "../format";
import { icon, iconButton } from "../icons";
import { CHANGE_ICONS } from "./detail-panel";
import type { DiffRequest, RepoView } from "./repo-view";

const MAX_LINES = 20_000;
/** Context that shows the whole file as one hunk. */
const FULL_FILE = 100_000;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

export class DiffView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private request: DiffRequest | null = null;
  private diff: FileDiff | null = null;
  /** Selected line indexes, per hunk. */
  private selection = new Map<number, Set<number>>();
  /** Where a ⇧-click range starts. */
  private anchor: { hunk: number; line: number } | null = null;
  private token = 0;
  /** Shows every line of the file, not just the changes. */
  private fullFile = false;

  constructor(private readonly view: RepoView) {
    this.header = el("header", "diff-header");
    this.body = el("div", "diff-body");
    this.root = el("div", "diff-view", this.header, this.body);
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.view.closeDiff();
      }
    });
  }

  isOpen(): boolean {
    return this.request !== null;
  }

  openFile(): DiffRequest | null {
    return this.request;
  }

  async open(request: DiffRequest): Promise<void> {
    const same = this.request && sameRequest(this.request, request);
    this.view.showCenter("diff");
    this.request = request;
    if (!same) this.clearSelection();
    this.root.focus({ preventScroll: true });
    await this.load(!same);
  }

  close(): void {
    if (!this.request) return;
    this.view.showCenter("graph");
  }

  /** Forgets the open file; the repository view decides what shows instead. */
  reset(): void {
    this.request = null;
    this.diff = null;
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
    await this.load(false);
  }

  private async load(scrollTop: boolean): Promise<void> {
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
      const scroll = this.body.scrollTop;
      this.renderBody();
      this.body.scrollTop = scrollTop ? 0 : scroll;
    } catch (error) {
      if (token === this.token) this.body.replaceChildren(el("div", "diff-notice", errorMessage(error)));
    }
  }

  private context(): number {
    return this.fullFile ? FULL_FILE : this.view.settings().diffContext;
  }

  /** Hunk and line actions. Off while whitespace is ignored: such patches don't apply. */
  private editable(): LineAction[] {
    if (this.view.settings().ignoreWhitespace) return [];
    const kind = this.request?.target.kind;
    return kind === "unstaged" ? ["discard", "stage"] : kind === "staged" ? ["unstage"] : [];
  }

  private async setOption(change: { layout?: "unified" | "split"; ignoreWhitespace?: boolean; fullFile?: boolean }): Promise<void> {
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
    await this.load(false);
  }

  /** Unified/split, full file and ignore whitespace. */
  private viewOptions(): HTMLElement {
    const settings = this.view.settings();
    const layout = el("div", "segmented-tabs");
    for (const value of ["unified", "split"] as const) {
      const b = el("button", `seg${settings.diffLayout === value ? " on" : ""}`, value === "unified" ? "Unified" : "Split");
      b.type = "button";
      b.title = value === "unified" ? "Changes in one column" : "Old and new side by side";
      b.addEventListener("click", () => void this.setOption({ layout: value }));
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
      const split = this.view.settings().diffLayout === "split";
      let budget = MAX_LINES;
      diff.hunks.forEach((hunk, index) => {
        if (budget <= 0) return;
        nodes.push(this.renderHunk(hunk, index, budget, lang, split));
        budget -= hunk.lines.length;
      });
      if (budget <= 0) nodes.push(el("div", "diff-notice", `Only the first ${MAX_LINES.toLocaleString()} lines are shown.`));
    }
    this.body.replaceChildren(...nodes);
  }

  private renderHunk(hunk: Hunk, index: number, budget: number, lang: string | null, split: boolean): HTMLElement {
    const context = hunk.header.replace(/^@@[^@]*@@\s?/, "");
    const actions = el("span", "hunk-actions");
    const selected = this.selection.get(index)?.size ?? 0;
    for (const action of this.editable()) {
      const words: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };
      const label = selected ? `${words[action]} ${plural(selected, "line")}` : this.fullFile ? `${words[action]} all` : `${words[action]} hunk`;
      const b = el("button", `button-secondary small${action === "discard" ? " danger" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", () => void this.applyHunk(action, index));
      actions.append(b);
    }
    const head = el("div", "hunk-header", el("span", "hunk-range mono", `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), el("span", "hunk-context mono", context), actions);
    const lines = hunk.lines.slice(0, budget);
    const words = this.wordChanges(lines);
    const body = split ? this.splitRows(lines, index, lang, words) : this.unifiedRows(lines, index, lang, words);
    return el("div", `hunk${split ? " split-hunk" : ""}`, head, body);
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

  private unifiedRows(lines: Line[], hunk: number, lang: string | null, words: Map<number, Range[]>): HTMLElement {
    const box = el("div", "hunk-lines");
    lines.forEach((line, i) => {
      const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "" : " ";
      const code = line.kind === "noNewline" ? el("span", "code", line.text.replace(/^\\ /, "")) : codeLine(line.text, lang, words.get(i));
      const row = el("div", `line ${line.kind}`, el("span", "ln", line.old === null ? "" : String(line.old)), el("span", "ln", line.new === null ? "" : String(line.new)), el("span", "sign", sign), code);
      this.makeSelectable(row, hunk, i, line);
      box.append(row);
    });
    return box;
  }

  /** Old on the left, new on the right; a removed run lines up with the added run after it. */
  private splitRows(lines: Line[], hunk: number, lang: string | null, words: Map<number, Range[]>): HTMLElement {
    const box = el("div", "split-lines");
    const cell = (index: number | null, side: "old" | "new") => {
      if (index === null) return el("div", "split-cell empty");
      const line = lines[index];
      const number = side === "old" ? line.old : line.new;
      const node = el("div", `split-cell line ${line.kind}`, el("span", "ln", number === null ? "" : String(number)), codeLine(line.text, lang, words.get(index)));
      this.makeSelectable(node, hunk, index, line);
      return node;
    };
    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (line.kind === "context") {
        box.append(el("div", "split-row", cell(i, "old"), cell(i, "new")));
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
          box.append(el("div", "split-row", cell(removed[k] ?? null, "old"), cell(added[k] ?? null, "new")));
        }
      }
    }
    return box;
  }

  private makeSelectable(row: HTMLElement, hunk: number, index: number, line: Line): void {
    if (!this.editable().length || (line.kind !== "added" && line.kind !== "removed")) return;
    row.classList.add("selectable");
    row.classList.toggle("selected", this.selection.get(hunk)?.has(index) ?? false);
    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest(".code")) return;
      event.preventDefault();
      this.toggleLine(hunk, index, event.shiftKey);
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

  private toggleLine(hunk: number, line: number, range: boolean): void {
    const lines = this.diff!.hunks[hunk].lines;
    const chosen = this.selection.get(hunk) ?? new Set<number>();
    if (range && this.anchor?.hunk === hunk) {
      const [a, b] = this.anchor.line < line ? [this.anchor.line, line] : [line, this.anchor.line];
      for (let i = a; i <= b; i++) {
        if (lines[i].kind === "added" || lines[i].kind === "removed") chosen.add(i);
      }
    } else if (chosen.has(line)) {
      chosen.delete(line);
    } else {
      chosen.add(line);
    }
    this.anchor = { hunk, line };
    if (chosen.size) this.selection.set(hunk, chosen);
    else this.selection.delete(hunk);
    const scroll = this.body.scrollTop;
    this.renderBody();
    this.body.scrollTop = scroll;
  }

  private clearSelection(): void {
    this.selection.clear();
    this.anchor = null;
  }

  private selectedCount(): number {
    return [...this.selection.values()].reduce((n, set) => n + set.size, 0);
  }

  /** Acts on every selected line, across hunks, in one patch. */
  private async applySelected(action: LineAction): Promise<void> {
    const request = this.request;
    const diff = this.diff;
    if (!request || !diff || !this.selection.size) return;
    const count = this.selectedCount();
    if (action === "discard") {
      const ok = await confirmAction({ title: `Discard ${plural(count, "line")}?`, message: "These changes are removed from the working tree.", confirmLabel: "Discard", danger: true });
      if (!ok) return;
    }
    const selections = [...this.selection.entries()].map(([hunk, lines]) => ({ hunk, header: diff.hunks[hunk].header, lines: [...lines].sort((a, b) => a - b) }));
    const labels: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };
    // The diff reloads afterwards, and old line numbers wouldn't match it.
    this.clearSelection();
    await this.view.attempt(labels[action], () => api.applySelection(this.view.id, action, request.file.path, selections, this.context()), { graph: false });
  }

  /** "N lines selected" with buttons, above the hunks, when lines are selected. */
  private selectionBar(): HTMLElement | null {
    const count = this.selectedCount();
    if (!count || !this.editable().length) return null;
    const hunks = this.selection.size;
    const bar = el("div", "selection-bar", el("span", "", `${plural(count, "line")} selected${hunks > 1 ? ` in ${hunks} hunks` : ""}`));
    const words: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };
    for (const action of this.editable()) {
      const b = el("button", `button-${action === "discard" ? "secondary danger" : "primary"} small`, `${words[action]} ${plural(count, "line")}`);
      b.type = "button";
      b.addEventListener("click", () => void this.applySelected(action));
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
        title: lines ? `Discard ${plural(lines.length, "line")}?` : "Discard this hunk?",
        message: "These changes are removed from the working tree.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    const labels: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };
    // The diff reloads afterwards, and old line numbers wouldn't match it.
    this.clearSelection();
    await this.view.attempt(
      labels[action],
      () => api.applyLines(this.view.id, action, request.file.path, index, diff.hunks[index].header, lines, this.context()),
      { graph: false },
    );
  }
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
