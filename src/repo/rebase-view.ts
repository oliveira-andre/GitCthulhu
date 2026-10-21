// The interactive rebase panel, over the graph. Commits are listed newest
// first like the graph; drag them to reorder and choose what happens to each.
import { type PlanCommit, type RebaseAction, type RebaseStep, api, errorKind, errorMessage } from "../api";
import { el } from "../dom";
import { avatar, plural, relativeTime, shortSha } from "../format";
import { icon } from "../icons";
import { notify } from "../toast";
import type { RepoView } from "./repo-view";

interface Row {
  commit: PlanCommit;
  action: RebaseAction;
  message: string;
}

const ACTIONS: { action: RebaseAction; label: string; key: string; hint: string }[] = [
  { action: "pick", label: "Pick", key: "p", hint: "Keep the commit" },
  { action: "reword", label: "Reword", key: "r", hint: "Keep it, change its message" },
  { action: "squash", label: "Squash", key: "s", hint: "Meld into the commit below, keeping both messages" },
  { action: "fixup", label: "Fixup", key: "f", hint: "Meld into the commit below, dropping this message" },
  { action: "drop", label: "Drop", key: "d", hint: "Remove the commit" },
];

export class RebaseView {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly problem: HTMLElement;
  private readonly list: HTMLElement;
  private readonly start: HTMLButtonElement;
  private rows: Row[] = [];
  private initial: Row[] = [];
  private onto: string | null = null;
  private selected = 0;
  /** The untouched plan's steps, to tell whether anything changed. */
  private initialKey = "";

  constructor(private readonly view: RepoView) {
    this.title = el("div", "rebase-title");
    const reset = el("button", "button-secondary small", "Reset");
    reset.type = "button";
    reset.title = "Undo the changes to this plan";
    reset.addEventListener("click", () => {
      this.rows = this.initial.map((r) => ({ ...r }));
      this.render();
    });
    const cancel = el("button", "button-secondary small", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    this.start = el("button", "button-primary small", "Start rebase");
    this.start.type = "button";
    this.start.addEventListener("click", () => void this.run());
    this.summary = el("div", "rebase-summary");
    this.problem = el("div", "rebase-problem");
    const keys = el(
      "div",
      "rebase-keys",
      "Drag to reorder, or ⌥↑ ⌥↓. ",
      ...ACTIONS.flatMap((a) => [el("kbd", "", a.key.toUpperCase()), ` ${a.label.toLowerCase()}  `]),
    );
    this.list = el("div", "rebase-list");
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (event) => this.onKey(event));
    this.root = el(
      "div",
      "rebase-view",
      el("header", "rebase-header", icon("rebase", 16), this.title, el("div", "rebase-actions", reset, cancel, this.start)),
      el("div", "rebase-info", this.summary, keys),
      this.problem,
      this.list,
    );
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Plans a rebase of the current branch onto `onto` (null: the whole history). */
  async open(onto: string | null, label: string): Promise<void> {
    let plan: PlanCommit[];
    try {
      plan = await api.rebasePlan(this.view.id, onto);
    } catch (error) {
      notify.error("Can't rebase interactively", errorMessage(error));
      return;
    }
    if (!plan.length) {
      notify.info("Nothing to rebase", `There are no commits on the branch after ${label}.`);
      return;
    }
    this.onto = onto;
    // Newest first, as in the graph.
    this.initial = plan.reverse().map((commit) => ({ commit, action: "pick", message: commit.message }));
    this.rows = this.initial.map((r) => ({ ...r }));
    this.initialKey = JSON.stringify(this.steps());
    this.selected = 0;
    const branch = this.view.snapshot?.head.branch ?? "HEAD";
    this.title.replaceChildren(el("strong", "", "Interactive rebase"), ` ${branch} onto `, el("span", "mono", label));
    this.view.showCenter("rebase");
    this.render();
    this.list.focus();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.view.showCenter("graph");
  }

  /** Steps oldest first, for git. */
  private steps(): RebaseStep[] {
    return [...this.rows].reverse().map((r) => ({
      oid: r.commit.oid,
      action: r.action,
      message: r.action === "reword" ? r.message : undefined,
    }));
  }

  private validate(): string | null {
    const kept = [...this.rows].reverse().filter((r) => r.action !== "drop");
    if (kept[0] && (kept[0].action === "squash" || kept[0].action === "fixup")) {
      return "The oldest kept commit has nothing below it to squash into.";
    }
    if (this.rows.some((r) => r.action === "reword" && !r.message.trim())) {
      return "A reworded commit needs a message.";
    }
    if (!kept.length && this.onto === null) return "Dropping every commit would leave the branch empty.";
    return null;
  }

  private render(): void {
    const counts = new Map<RebaseAction, number>();
    for (const r of this.rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
    const changed = JSON.stringify(this.steps()) !== this.initialKey;
    this.summary.textContent = `${plural(this.rows.length, "commit")}: ${ACTIONS.filter((a) => counts.get(a.action)).map((a) => `${counts.get(a.action)} ${a.label.toLowerCase()}`).join(", ")}`;
    const problem = this.validate();
    this.problem.textContent = problem ?? "";
    this.problem.hidden = !problem;
    this.start.disabled = Boolean(problem) || !changed || this.view.isBusy();
    this.start.title = changed ? "Rewrite the branch with this plan" : "Change something first";

    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...this.rows.map((row, i) => this.renderRow(row, i)));
    const base = this.view.graph?.commits.find((c) => c.oid === this.onto);
    this.list.append(
      el(
        "div",
        "rebase-base",
        icon("commit", 14),
        el("span", "mono", this.onto ? shortSha(this.onto) : "root"),
        el("span", "", this.onto ? `onto ${base?.subject ?? "this commit"}` : "the start of history"),
      ),
    );
    this.list.scrollTop = scroll;
  }

  private renderRow(row: Row, index: number): HTMLElement {
    const handle = el("span", "rebase-handle", "⋮⋮");
    handle.title = "Drag to reorder";
    const segmented = el("div", "rebase-segmented");
    for (const a of ACTIONS) {
      const b = el("button", `seg ${a.action}${row.action === a.action ? " on" : ""}`, a.label);
      b.type = "button";
      b.title = `${a.hint} (${a.key.toUpperCase()})`;
      b.addEventListener("click", () => this.setAction(index, a.action));
      segmented.append(b);
    }
    const body = el("div", "rebase-body");
    if (row.action === "reword") {
      const text = el("textarea", "rebase-message");
      text.value = row.message;
      text.rows = Math.min(Math.max(row.message.split("\n").length, 2), 6);
      text.spellcheck = true;
      text.addEventListener("input", () => {
        row.message = text.value;
        const problem = this.validate();
        this.problem.textContent = problem ?? "";
        this.problem.hidden = !problem;
        this.start.disabled = Boolean(problem) || this.view.isBusy();
      });
      text.addEventListener("keydown", (event) => event.stopPropagation());
      body.append(text);
    } else {
      body.append(el("span", "rebase-subject", row.commit.summary || "(no message)"));
      if (row.action === "squash" || row.action === "fixup") {
        body.append(el("span", "rebase-note", row.action === "squash" ? "↳ melds into the commit below" : "↳ melds into the commit below, message dropped"));
      }
    }
    const node = el(
      "div",
      `rebase-row action-${row.action}${index === this.selected ? " selected" : ""}`,
      handle,
      segmented,
      el("span", "rebase-sha mono", shortSha(row.commit.oid)),
      body,
      el("span", "rebase-author", avatar(row.commit.author, row.commit.email, 18), row.commit.author),
      el("span", "rebase-date mono", relativeTime(row.commit.authorTime)),
    );
    node.addEventListener("mousedown", (event) => {
      if ((event.target as Element).closest("button, textarea")) return;
      this.selected = index;
      for (const [i, r] of [...this.list.querySelectorAll(".rebase-row")].entries()) r.classList.toggle("selected", i === index);
    });
    handle.addEventListener("pointerdown", (event) => this.drag(event, index));
    return node;
  }

  private setAction(index: number, action: RebaseAction): void {
    this.rows[index].action = action;
    this.selected = index;
    this.render();
    if (action === "reword") this.list.querySelectorAll<HTMLTextAreaElement>(".rebase-row")[index]?.querySelector("textarea")?.focus();
  }

  private move(index: number, to: number): void {
    if (to < 0 || to >= this.rows.length || to === index) return;
    const [row] = this.rows.splice(index, 1);
    this.rows.splice(to, 0, row);
    this.selected = to;
    this.render();
  }

  /** Pointer drag on the handle: the row follows the pointer, reordering live. */
  private drag(event: PointerEvent, index: number): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    let current = index;
    document.body.classList.add("dragging");
    const move = (e: PointerEvent) => {
      const rows = [...this.list.querySelectorAll<HTMLElement>(".rebase-row")];
      const target = rows.findIndex((r) => {
        const rect = r.getBoundingClientRect();
        return e.clientY >= rect.top && e.clientY < rect.bottom;
      });
      if (target >= 0 && target !== current) {
        this.move(current, target);
        current = target;
        // The re-render replaced the handle; keep receiving the pointer.
        this.list.querySelectorAll<HTMLElement>(".rebase-handle")[current]?.setPointerCapture(e.pointerId);
      }
    };
    const up = () => {
      document.body.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey) return;
    const action = ACTIONS.find((a) => a.key === event.key.toLowerCase());
    if (action && !event.altKey) {
      event.preventDefault();
      this.setAction(this.selected, action.action);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (event.altKey) {
        this.move(this.selected, this.selected + step);
      } else {
        this.selected = Math.min(Math.max(this.selected + step, 0), this.rows.length - 1);
        this.render();
      }
      this.list.querySelectorAll(".rebase-row")[this.selected]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  private async run(): Promise<void> {
    const problem = this.validate();
    if (problem) return;
    const steps = this.steps();
    try {
      await this.view.run("Rebase", () => api.interactiveRebase(this.view.id, this.onto, steps), { success: "Rebased" });
      this.close();
    } catch (error) {
      // Conflicts leave a rebase in progress; the commit panel takes it from here.
      if (errorKind(error) === "conflicts") this.close();
    }
  }
}
