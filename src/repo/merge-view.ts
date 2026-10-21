// The three-way merge tool, over the graph. Each conflict shows our and
// their lines side by side; tick the lines to keep, see the result below,
// or edit the whole output by hand. Saving writes the file and stages it.
import { type ConflictFile, api, errorMessage } from "../api";
import { confirmAction } from "../dialogs";
import { el } from "../dom";
import { plural, shortSha, splitPath } from "../format";
import { icon } from "../icons";
import { isMac } from "../platform";
import { notify } from "../toast";
import type { RepoView } from "./repo-view";

interface Chunk {
  ours: string[];
  base: string[];
  theirs: string[];
  takeOurs: Set<number>;
  takeTheirs: Set<number>;
  /** The user chose something, even "neither". */
  decided: boolean;
}

type Part = { kind: "stable"; lines: string[]; open: boolean } | { kind: "conflict"; chunk: Chunk };

/** Unchanged runs longer than this fold to their edges. */
const FOLD = 10;

export class MergeView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private path = "";
  private file: ConflictFile | null = null;
  private parts: Part[] = [];
  /** Hand-edited output; once set it replaces the choices. */
  private edited: string | null = null;
  private editing = false;
  private token = 0;

  constructor(private readonly view: RepoView) {
    this.header = el("header", "merge-header");
    this.body = el("div", "merge-body");
    this.root = el("div", "merge-view", this.header, this.body);
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (event) => {
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.save();
      }
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(path: string): Promise<void> {
    const token = ++this.token;
    let file: ConflictFile;
    try {
      file = await api.conflictFile(this.view.id, path);
    } catch (error) {
      notify.error(`Can't open ${splitPath(path).name} in the merge tool`, errorMessage(error));
      return;
    }
    if (token !== this.token) return;
    this.path = path;
    this.file = file;
    this.edited = null;
    this.editing = false;
    this.parts = file.segments.map((s) =>
      s.kind === "stable"
        ? { kind: "stable", lines: s.lines, open: false }
        : { kind: "conflict", chunk: { ours: s.ours, base: s.base, theirs: s.theirs, takeOurs: new Set(), takeTheirs: new Set(), decided: false } },
    );
    this.view.showCenter("merge");
    this.render();
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    if (this.isOpen()) this.view.showCenter("graph");
  }

  private chunks(): Chunk[] {
    return this.parts.flatMap((p) => (p.kind === "conflict" ? [p.chunk] : []));
  }

  private output(): string {
    if (this.edited !== null) return this.edited;
    const lines = this.parts.flatMap((p) => (p.kind === "stable" ? p.lines : chosen(p.chunk)));
    const text = lines.join("\n");
    return this.file?.trailingNewline && lines.length ? `${text}\n` : text;
  }

  private sideLabels(): { ours: string; theirs: string } {
    const state = this.view.snapshot?.state;
    const branch = this.view.snapshot?.head.branch;
    if (state?.kind === "merging") {
      return { ours: `Ours · ${branch ?? "HEAD"}`, theirs: `Theirs · ${state.head ? shortSha(state.head) : "incoming"}` };
    }
    if (state?.kind === "rebasing") {
      return { ours: `Ours · ${state.onto ? `onto ${shortSha(state.onto)}` : "upstream"}`, theirs: "Theirs · the commit being rebased" };
    }
    return { ours: `Ours · ${branch ?? "HEAD"}`, theirs: "Theirs · incoming" };
  }

  private render(): void {
    const file = this.file!;
    const chunks = this.chunks();
    const left = chunks.filter((c) => !c.decided).length;
    const { dir, name } = splitPath(this.path);

    const actions = el("div", "merge-actions");
    const button = (label: string, action: () => void, className = "button-secondary small") => {
      const b = el("button", className, label);
      b.type = "button";
      b.addEventListener("click", action);
      actions.append(b);
      return b;
    };
    const mergeable = !file.binary && !file.deletedInOurs && !file.deletedInTheirs;
    if (mergeable && chunks.length) {
      button("Take all ours", () => this.takeAll("ours"));
      button("Take all theirs", () => this.takeAll("theirs"));
      button(this.editing ? "Back to choices" : "Edit output", () => this.toggleEditing());
    }
    button("Cancel", () => this.close());
    if (mergeable) {
      const save = button("Save and mark resolved", () => void this.save(), "button-primary small");
      save.title = `Write the result and stage it (${isMac ? "⌘S" : "Ctrl+S"})`;
    }
    const status = !mergeable
      ? "Can't be merged line by line"
      : chunks.length === 0
        ? "No conflicting lines left"
        : this.edited !== null
          ? "Output edited by hand"
          : left
            ? `${plural(chunks.length, "conflict")}, ${left} still to decide`
            : `${plural(chunks.length, "conflict")}, all decided`;
    this.header.replaceChildren(
      icon("merge", 16),
      el("div", "merge-title", el("span", "file-path", el("span", "file-dir", dir), el("span", "file-name", name)), el("span", "merge-status", status)),
      actions,
    );

    if (!mergeable) {
      this.body.replaceChildren(this.wholeFileChoice(file));
      return;
    }
    if (this.editing) {
      const text = el("textarea", "merge-output-editor");
      text.value = this.output();
      text.spellcheck = false;
      text.addEventListener("input", () => {
        this.edited = text.value;
        this.header.querySelector(".merge-status")!.textContent = "Output edited by hand";
      });
      const hint = el("p", "merge-hint", "Edit the merged file directly. Saving writes exactly this text.");
      if (this.edited !== null) {
        const discard = el("button", "button-secondary small", "Discard edits");
        discard.type = "button";
        discard.addEventListener("click", () => {
          this.edited = null;
          this.render();
        });
        hint.append(" ", discard);
      }
      this.body.replaceChildren(hint, text);
      text.focus();
      return;
    }
    const scroll = this.body.scrollTop;
    const labels = this.sideLabels();
    let n = 0;
    this.body.replaceChildren(
      ...this.parts.map((part) => (part.kind === "stable" ? this.renderStable(part) : this.renderChunk(part.chunk, ++n, chunks.length, labels))),
    );
    this.body.scrollTop = scroll;
  }

  private wholeFileChoice(file: ConflictFile): HTMLElement {
    const box = el("div", "conflict-help");
    const add = (label: string, run: () => Promise<void>, primary = false) => {
      const b = el("button", primary ? "button-primary small" : "button-secondary small", label);
      b.type = "button";
      b.addEventListener("click", () => void this.finish(label, run));
      return b;
    };
    const buttons = el("div", "conflict-buttons");
    if (file.binary) {
      box.append(el("p", "", "This is a binary file, so its versions can't be combined line by line. Keep one of them whole."));
      buttons.append(
        add("Take ours", () => api.resolveWith(this.view.id, [this.path], "ours")),
        add("Take theirs", () => api.resolveWith(this.view.id, [this.path], "theirs")),
      );
    } else {
      const deletedBy = file.deletedInOurs ? "our side (HEAD)" : "their side (incoming)";
      const keptBy = file.deletedInOurs ? "theirs" : "ours";
      box.append(el("p", "", `The file was deleted on ${deletedBy} and changed on the other. Keep the changed file, or delete it.`));
      buttons.append(
        add("Keep the file", () => api.resolveWith(this.view.id, [this.path], keptBy), true),
        add("Delete the file", () => api.resolveDeleted(this.view.id, this.path)),
      );
    }
    box.append(buttons);
    return box;
  }

  private renderStable(part: Extract<Part, { kind: "stable" }>): HTMLElement {
    const node = el("div", "merge-stable");
    const line = (text: string) => el("div", "merge-line", el("span", "code", text));
    if (part.open || part.lines.length <= FOLD) {
      node.append(...part.lines.map(line));
      return node;
    }
    const expand = el("button", "merge-fold", `⋯ ${part.lines.length - 6} unchanged lines`);
    expand.type = "button";
    expand.addEventListener("click", () => {
      part.open = true;
      this.render();
    });
    node.append(...part.lines.slice(0, 3).map(line), expand, ...part.lines.slice(-3).map(line));
    return node;
  }

  private renderChunk(chunk: Chunk, n: number, total: number, labels: { ours: string; theirs: string }): HTMLElement {
    const quick = el("span", "chunk-quick");
    const choose = (label: string, ours: boolean, theirs: boolean) => {
      const b = el("button", "button-secondary small", label);
      b.type = "button";
      b.addEventListener("click", () => {
        chunk.takeOurs = ours ? new Set(chunk.ours.keys()) : new Set();
        chunk.takeTheirs = theirs ? new Set(chunk.theirs.keys()) : new Set();
        chunk.decided = true;
        this.render();
      });
      quick.append(b);
    };
    choose("Ours", true, false);
    choose("Theirs", false, true);
    choose("Both", true, true);
    choose("Neither", false, false);

    const side = (title: string, lines: string[], taken: Set<number>, kind: "ours" | "theirs") => {
      const box = el("div", `merge-side ${kind}`, el("div", "merge-side-title", title));
      if (!lines.length) box.append(el("div", "merge-empty", "(no lines)"));
      lines.forEach((text, i) => {
        const check = el("input");
        check.type = "checkbox";
        check.checked = taken.has(i);
        check.tabIndex = -1;
        const row = el("label", `merge-line selectable${taken.has(i) ? " taken" : ""}`, check, el("span", "code", text));
        check.addEventListener("change", () => {
          if (check.checked) taken.add(i);
          else taken.delete(i);
          chunk.decided = true;
          this.render();
        });
        box.append(row);
      });
      return box;
    };

    const result = el("div", "merge-result", el("div", "merge-side-title", "Result"));
    const picked = chosen(chunk);
    if (!chunk.decided) result.append(el("div", "merge-empty", "Tick the lines to keep, or pick a side."));
    else if (!picked.length) result.append(el("div", "merge-empty", "(nothing: both sides left out)"));
    else result.append(...picked.map((text) => el("div", "merge-line", el("span", "code", text))));

    return el(
      "section",
      `merge-chunk${chunk.decided ? " decided" : ""}`,
      el("div", "chunk-header", el("span", "chunk-title", `Conflict ${n} of ${total}`), quick),
      el("div", "merge-sides", side(labels.ours, chunk.ours, chunk.takeOurs, "ours"), side(labels.theirs, chunk.theirs, chunk.takeTheirs, "theirs")),
      result,
    );
  }

  private takeAll(side: "ours" | "theirs"): void {
    for (const chunk of this.chunks()) {
      chunk.takeOurs = side === "ours" ? new Set(chunk.ours.keys()) : new Set();
      chunk.takeTheirs = side === "theirs" ? new Set(chunk.theirs.keys()) : new Set();
      chunk.decided = true;
    }
    this.edited = null;
    this.render();
  }

  private toggleEditing(): void {
    if (!this.editing && this.edited === null) this.edited = null;
    this.editing = !this.editing;
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.file || this.file.binary || this.file.deletedInOurs || this.file.deletedInTheirs) return;
    const left = this.chunks().filter((c) => !c.decided).length;
    if (left && this.edited === null) {
      const ok = await confirmAction({
        title: `${plural(left, "conflict")} still undecided`,
        message: "Their lines are left out of the result. Save anyway?",
        confirmLabel: "Save",
      });
      if (!ok) return;
    }
    const contents = this.output();
    await this.finish("Resolve", () => api.resolveFile(this.view.id, this.path, contents));
  }

  /** Runs a resolution, then moves on to the next conflicted file, if any. */
  private async finish(label: string, run: () => Promise<void>): Promise<void> {
    const path = this.path;
    try {
      await this.view.run(label, run, { graph: false });
    } catch {
      return;
    }
    const next = this.view.snapshot?.status.conflicted.find((f) => f.path !== path);
    if (next) void this.open(next.path);
    else {
      this.close();
      notify.success("All conflicts are resolved", "Continue from the panel on the right.");
    }
  }
}

function chosen(chunk: Chunk): string[] {
  const ours = chunk.ours.filter((_, i) => chunk.takeOurs.has(i));
  const theirs = chunk.theirs.filter((_, i) => chunk.takeTheirs.has(i));
  return [...ours, ...theirs];
}
