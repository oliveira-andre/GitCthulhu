// The diff of one file, over the graph. Uncommitted diffs can be staged,
// unstaged or discarded per file, per hunk, or per selected lines.
import { type DiffTarget, type FileDiff, type Hunk, type LineAction, api, errorMessage } from "../api";
import { confirmAction } from "../dialogs";
import { el } from "../dom";
import { CHANGE_LABELS, plural, shortSha, splitPath } from "../format";
import { icon, iconButton } from "../icons";
import { CHANGE_ICONS } from "./detail-panel";
import type { DiffRequest, RepoView } from "./repo-view";

const MAX_LINES = 20_000;

export class DiffView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private request: DiffRequest | null = null;
  private diff: FileDiff | null = null;
  /** Selected line indexes, all within `selectedHunk`. */
  private selection = new Set<number>();
  private selectedHunk = -1;
  private anchor = -1;
  private token = 0;

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

  async open(request: DiffRequest): Promise<void> {
    const same = this.request && sameRequest(this.request, request);
    this.request = request;
    if (!same) this.clearSelection();
    this.root.hidden = false;
    this.view.graphView.root.hidden = true;
    this.root.focus({ preventScroll: true });
    await this.load(!same);
  }

  close(): void {
    if (!this.request) return;
    this.request = null;
    this.diff = null;
    this.root.hidden = true;
    this.view.graphView.root.hidden = false;
    this.view.graphView.focus();
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
    this.renderHeader();
    if (request.file.kind === "conflicted") {
      this.renderConflict();
      return;
    }
    try {
      const diff = await api.fileDiff(this.view.id, request.target, request.file.path, request.file.oldPath ?? null, this.view.settings().diffContext);
      if (token !== this.token) return;
      this.diff = diff;
      // A selection from an older version of the diff no longer applies.
      if (this.selectedHunk >= diff.hunks.length) this.clearSelection();
      const scroll = this.body.scrollTop;
      this.renderBody();
      this.body.scrollTop = scrollTop ? 0 : scroll;
    } catch (error) {
      if (token === this.token) this.body.replaceChildren(el("div", "diff-notice", errorMessage(error)));
    }
  }

  private editable(): LineAction[] {
    const kind = this.request?.target.kind;
    return kind === "unstaged" ? ["discard", "stage"] : kind === "staged" ? ["unstage"] : [];
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
    actions.append(iconButton("close", "Close (Esc)", () => this.view.closeDiff()));
    this.header.replaceChildren(title, actions);
  }

  private fileButton(label: string, name: "trash" | "plus" | "minus", danger: boolean, action: () => unknown): HTMLButtonElement {
    const b = el("button", `button-secondary small${danger ? " danger" : ""}`, icon(name, 13), label);
    b.type = "button";
    b.addEventListener("click", () => void action());
    return b;
  }

  private renderBody(): void {
    const diff = this.diff!;
    if (diff.tooLarge) return void this.body.replaceChildren(el("div", "diff-notice", "This diff is too large to show."));
    if (diff.binary) return void this.body.replaceChildren(el("div", "diff-notice", "Binary file: no text diff to show."));
    if (!diff.hunks.length) {
      return void this.body.replaceChildren(el("div", "diff-notice", diff.newFile ? "Empty file." : "No content changes (the mode or the file name may have changed)."));
    }
    let budget = MAX_LINES;
    const hunks: HTMLElement[] = [];
    diff.hunks.forEach((hunk, index) => {
      if (budget <= 0) return;
      hunks.push(this.renderHunk(hunk, index, budget));
      budget -= hunk.lines.length;
    });
    if (budget <= 0) hunks.push(el("div", "diff-notice", `Only the first ${MAX_LINES.toLocaleString()} lines are shown.`));
    this.body.replaceChildren(...hunks);
  }

  private renderHunk(hunk: Hunk, index: number, budget: number): HTMLElement {
    const context = hunk.header.replace(/^@@[^@]*@@\s?/, "");
    const actions = el("span", "hunk-actions");
    const selected = this.selectedHunk === index ? this.selection.size : 0;
    for (const action of this.editable()) {
      const words: Record<LineAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard" };
      const label = selected ? `${words[action]} ${plural(selected, "line")}` : `${words[action]} hunk`;
      const b = el("button", `button-secondary small${action === "discard" ? " danger" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", () => void this.applyHunk(action, index));
      actions.append(b);
    }
    const head = el("div", "hunk-header", el("span", "hunk-range mono", `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), el("span", "hunk-context mono", context), actions);
    const lines = el("div", "hunk-lines");
    const canSelect = this.editable().length > 0;
    hunk.lines.slice(0, budget).forEach((line, i) => {
      const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "" : " ";
      const row = el(
        "div",
        `line ${line.kind}`,
        el("span", "ln", line.old === null ? "" : String(line.old)),
        el("span", "ln", line.new === null ? "" : String(line.new)),
        el("span", "sign", sign),
        el("span", "code", line.kind === "noNewline" ? line.text.replace(/^\\ /, "") : line.text),
      );
      const changed = line.kind === "added" || line.kind === "removed";
      if (canSelect && changed) {
        row.classList.add("selectable");
        row.classList.toggle("selected", this.selectedHunk === index && this.selection.has(i));
        row.addEventListener("mousedown", (event) => {
          if (event.button !== 0 || (event.target as Element).closest(".code")) return;
          event.preventDefault();
          this.toggleLine(index, i, event.shiftKey);
        });
      }
      lines.append(row);
    });
    return el("div", "hunk", head, lines);
  }

  private toggleLine(hunk: number, line: number, range: boolean): void {
    if (this.selectedHunk !== hunk) {
      this.selection.clear();
      this.selectedHunk = hunk;
      this.anchor = -1;
    }
    const lines = this.diff!.hunks[hunk].lines;
    if (range && this.anchor >= 0) {
      const [a, b] = this.anchor < line ? [this.anchor, line] : [line, this.anchor];
      for (let i = a; i <= b; i++) {
        if (lines[i].kind === "added" || lines[i].kind === "removed") this.selection.add(i);
      }
    } else if (this.selection.has(line)) {
      this.selection.delete(line);
    } else {
      this.selection.add(line);
    }
    this.anchor = line;
    if (!this.selection.size) this.selectedHunk = -1;
    const scroll = this.body.scrollTop;
    this.renderBody();
    this.body.scrollTop = scroll;
  }

  private clearSelection(): void {
    this.selection.clear();
    this.selectedHunk = -1;
    this.anchor = -1;
  }

  private async applyHunk(action: LineAction, index: number): Promise<void> {
    const request = this.request;
    const diff = this.diff;
    if (!request || !diff) return;
    const lines = this.selectedHunk === index && this.selection.size ? [...this.selection].sort((a, b) => a - b) : null;
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
      () => api.applyLines(this.view.id, action, request.file.path, index, diff.hunks[index].header, lines),
      { graph: false },
    );
  }

  /** Conflicted files show as they are, markers and all, with a way out. */
  private async renderConflict(): Promise<void> {
    const file = this.request!.file;
    const token = this.token;
    const help = el(
      "div",
      "conflict-help",
      el("p", "", "This file has conflicts. Edit it in your editor and remove the conflict markers, or take one side whole. Then mark it resolved."),
    );
    const buttons = el("div", "conflict-buttons");
    const take = (side: "ours" | "theirs", label: string) => {
      const b = el("button", "button-secondary small", label);
      b.type = "button";
      b.addEventListener("click", () => void this.view.attempt(label, () => api.resolveWith(this.view.id, [file.path], side), { graph: false }));
      return b;
    };
    const resolved = el("button", "button-primary small", icon("check", 13), "Mark resolved");
    resolved.type = "button";
    resolved.addEventListener("click", () => void this.view.attempt("Mark resolved", () => api.stage(this.view.id, [file.path]), { graph: false }));
    buttons.append(take("ours", "Take ours"), take("theirs", "Take theirs"), resolved);
    help.append(buttons);
    try {
      const text = await api.worktreeFile(this.view.id, file.path);
      if (token !== this.token) return;
      const lines = el("div", "hunk-lines conflict-lines");
      let side: "" | "ours" | "theirs" = "";
      text.split("\n").forEach((line, i) => {
        let kind: string = side;
        if (line.startsWith("<<<<<<<")) {
          side = "ours";
          kind = "marker";
        } else if (line.startsWith("=======") && side) {
          side = "theirs";
          kind = "marker";
        } else if (line.startsWith(">>>>>>>") && side) {
          side = "";
          kind = "marker";
        }
        lines.append(el("div", `line ${kind}`, el("span", "ln", String(i + 1)), el("span", "code", line)));
      });
      this.body.replaceChildren(help, el("div", "hunk", lines));
    } catch (error) {
      this.body.replaceChildren(help, el("div", "diff-notice", errorMessage(error)));
    }
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
