// The right panel. For uncommitted changes it is the staging area and the
// commit composer; for a commit or stash it shows the details and files.
import { type CommitDetails, type DiffTarget, type FileChange, WORK_IN_PROGRESS, api, errorMessage } from "../api";
import { confirmAction } from "../dialogs";
import { el } from "../dom";
import { CHANGE_LABELS, absoluteTime, avatar, plural, relativeTime, shortSha, splitPath } from "../format";
import { type IconName, icon, iconButton } from "../icons";
import { showMenu } from "../menu";
import { shortcutLabel } from "../platform";
import { notify } from "../toast";
import type { DiffRequest, RepoView } from "./repo-view";

const SUMMARY_LIMIT = 72;

export const CHANGE_ICONS: Record<FileChange["kind"], IconName> = {
  added: "fileAdded",
  untracked: "fileAdded",
  modified: "fileModified",
  typeChanged: "fileModified",
  deleted: "fileRemoved",
  renamed: "fileRenamed",
  copied: "fileRenamed",
  conflicted: "fileConflict",
};

export class DetailPanel {
  readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly summary: HTMLInputElement;
  private readonly description: HTMLTextAreaElement;
  private readonly counter: HTMLElement;
  private readonly amend: HTMLInputElement;
  private readonly commitButton: HTMLButtonElement;
  private shown: string | null = null;
  private details = new Map<string, CommitDetails>();
  private openFile: DiffRequest | null = null;
  /** The draft kept aside while amend shows HEAD's message. */
  private draft: { summary: string; description: string } | null = null;
  private preparedFor: string | null = null;
  private token = 0;

  constructor(private readonly view: RepoView) {
    this.summary = el("input", "commit-summary-input");
    this.summary.placeholder = "Commit summary";
    this.summary.spellcheck = true;
    this.counter = el("span", "summary-counter mono");
    this.description = el("textarea", "commit-description");
    this.description.placeholder = "Description";
    this.description.rows = 4;
    this.amend = el("input");
    this.amend.type = "checkbox";
    this.commitButton = el("button", "button-primary commit-button", "Commit");
    this.commitButton.type = "button";
    this.commitButton.addEventListener("click", () => void this.commit(false));
    this.amend.addEventListener("change", () => void this.toggleAmend());
    for (const input of [this.summary, this.description]) {
      input.addEventListener("input", () => this.updateComposer());
      (input as HTMLElement).addEventListener("keydown", (event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key === "Enter") {
          event.preventDefault();
          void this.commit(event.shiftKey);
        }
      });
    }
    this.composer = el(
      "div",
      "composer",
      el("div", "composer-head", el("label", "checkbox", this.amend, "Amend previous commit"), this.counter),
      this.summary,
      this.description,
      this.commitButton,
    );
    this.content = el("div", "detail-content");
    this.root = el("aside", "detail-panel", this.content, this.composer);
    this.composer.hidden = true;
  }

  focusMessage(): void {
    if (this.shown !== WORK_IN_PROGRESS) this.view.selectCommit(WORK_IN_PROGRESS, { scroll: "nearest" });
    this.summary.focus();
  }

  async show(oid: string | null): Promise<void> {
    this.shown = oid;
    const token = ++this.token;
    this.composer.hidden = oid !== WORK_IN_PROGRESS;
    if (!oid) {
      this.content.replaceChildren(el("div", "detail-empty", "Nothing selected"));
      return;
    }
    if (oid === WORK_IN_PROGRESS) {
      this.renderWip();
      return;
    }
    let details = this.details.get(oid);
    if (!details) {
      this.content.replaceChildren(el("div", "detail-empty", "Loading…"));
      try {
        details = await api.commitDetails(this.view.id, oid);
      } catch (error) {
        if (token === this.token) this.content.replaceChildren(el("div", "detail-empty", errorMessage(error)));
        return;
      }
      this.details.set(oid, details);
      if (this.details.size > 200) this.details.delete(this.details.keys().next().value!);
    }
    if (token === this.token) this.renderCommit(details);
  }

  /** New status or refs arrived. */
  async refresh(): Promise<void> {
    if (this.shown === WORK_IN_PROGRESS) {
      this.renderWip();
    } else if (this.shown) {
      const details = this.details.get(this.shown);
      if (details) this.renderCommit(details);
    }
  }

  markOpenFile(request: DiffRequest | null): void {
    this.openFile = request;
    for (const row of this.content.querySelectorAll<HTMLElement>(".file-row")) {
      row.classList.toggle("open", Boolean(request) && row.dataset.key === keyOf(request!.target, request!.file.path));
    }
  }

  // Uncommitted changes

  private renderWip(): void {
    const snapshot = this.view.snapshot;
    if (!snapshot) return;
    const { status, state } = snapshot;
    const nodes: HTMLElement[] = [];

    if (state.kind !== "clean") nodes.push(this.stateBanner());

    if (status.conflicted.length) {
      nodes.push(
        this.fileSection(
          `Conflicted files`,
          status.conflicted,
          { kind: "unstaged" },
          null,
          (file) => [
            iconButton("laptop", "Take ours (the current branch)", () => void this.resolve(file, "ours"), "icon-button small"),
            iconButton("cloud", "Take theirs (the incoming change)", () => void this.resolve(file, "theirs"), "icon-button small"),
            iconButton("check", "Mark resolved (stage the file as it is)", () => void this.view.attempt("Mark resolved", () => api.stage(this.view.id, [file.path]), { graph: false }), "icon-button small"),
          ],
        ),
      );
    }
    nodes.push(
      this.fileSection(
        "Unstaged files",
        status.unstaged,
        { kind: "unstaged" },
        { label: "Stage all", shortcut: shortcutLabel("stageAll"), action: () => this.view.actions.stageAll() },
        (file) => [
          iconButton("trash", "Discard changes", () => void this.discard(file), "icon-button small danger"),
          iconButton("plus", "Stage file", () => void this.view.attempt("Stage", () => api.stage(this.view.id, [file.path]), { graph: false }), "icon-button small"),
        ],
      ),
      this.fileSection(
        "Staged files",
        status.staged,
        { kind: "staged" },
        { label: "Unstage all", shortcut: shortcutLabel("unstageAll"), action: () => this.view.actions.unstageAll() },
        (file) => [iconButton("minus", "Unstage file", () => void this.view.attempt("Unstage", () => api.unstage(this.view.id, [file.path]), { graph: false }), "icon-button small")],
      ),
    );
    this.content.replaceChildren(...nodes);
    this.markOpenFile(this.openFile);

    // Merges and conflicted picks come with a prepared message.
    if (snapshot.preparedMessage && this.preparedFor !== snapshot.preparedMessage && !this.summary.value && !this.description.value) {
      this.preparedFor = snapshot.preparedMessage;
      const [first, ...rest] = snapshot.preparedMessage.split("\n");
      this.summary.value = first;
      this.description.value = rest.join("\n").trim();
    }
    this.updateComposer();
  }

  private stateBanner(): HTMLElement {
    const state = this.view.snapshot!.state;
    const conflicted = this.view.snapshot!.status.conflicted.length;
    const titles: Record<string, string> = {
      merging: "Merge in progress",
      rebasing: "Rebase in progress",
      cherryPicking: "Cherry-pick in progress",
      reverting: "Revert in progress",
      bisecting: "Bisect in progress",
    };
    let detail = conflicted ? `${plural(conflicted, "file")} still conflicted.` : "All conflicts are resolved.";
    if (state.kind === "rebasing" && state.step && state.total) detail = `Commit ${state.step} of ${state.total}. ${detail}`;
    const actions = el("div", "banner-actions");
    const run = (label: string, action: "continue" | "abort" | "skip") =>
      void this.view.attempt(label, () => api.sequence(this.view.id, action));
    if (state.kind !== "bisecting") {
      const cont = el("button", "button-primary small", "Continue");
      cont.type = "button";
      cont.disabled = conflicted > 0;
      cont.addEventListener("click", () => {
        // A merge continues by committing, so it uses the composer's message.
        if (state.kind === "merging") void this.commit(false);
        else run("Continue", "continue");
      });
      actions.append(cont);
    }
    if (state.kind === "rebasing" || state.kind === "cherryPicking" || state.kind === "reverting") {
      const skip = el("button", "button-secondary small", "Skip commit");
      skip.type = "button";
      skip.addEventListener("click", () => run("Skip", "skip"));
      actions.append(skip);
    }
    const abort = el("button", "button-secondary small danger", state.kind === "bisecting" ? "End bisect" : "Abort");
    abort.type = "button";
    abort.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: `${titles[state.kind]}: abort?`,
        message: "Everything goes back to how it was before it started.",
        confirmLabel: "Abort",
        danger: true,
      });
      if (ok) run("Abort", "abort");
    });
    actions.append(abort);
    return el("div", `state-banner ${conflicted ? "conflicted" : ""}`, el("div", "banner-title", titles[state.kind] ?? ""), el("div", "banner-detail", detail), actions);
  }

  private fileSection(
    title: string,
    files: FileChange[],
    target: DiffTarget,
    bulk: { label: string; shortcut: string; action: () => void } | null,
    buttons: (file: FileChange) => HTMLElement[],
  ): HTMLElement {
    const header = el("div", "file-section-header", el("span", "file-section-title", `${title} (${files.length})`));
    if (bulk && files.length) {
      const b = el("button", "button-secondary small", bulk.label);
      b.type = "button";
      b.title = `${bulk.label} (${bulk.shortcut})`;
      b.addEventListener("click", bulk.action);
      header.append(b);
    }
    const list = el("div", "file-list");
    for (const file of files) list.append(this.fileRow(file, target, buttons(file)));
    if (!files.length) list.append(el("div", "file-empty", "None"));
    return el("section", "file-section", header, list);
  }

  private fileRow(file: FileChange, target: DiffTarget, buttons: HTMLElement[]): HTMLElement {
    const { dir, name } = splitPath(file.path);
    const row = el(
      "div",
      `file-row kind-${file.kind}`,
      icon(CHANGE_ICONS[file.kind], 14),
      el("span", "file-path", el("span", "file-dir", dir), el("span", "file-name", name)),
      el("span", "file-actions", ...buttons),
    );
    row.dataset.key = keyOf(target, file.path);
    row.title = `${CHANGE_LABELS[file.kind]}: ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
    row.addEventListener("click", (event) => {
      if ((event.target as Element).closest(".file-actions")) return;
      this.view.openDiff({ target, file });
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showMenu(
        [
          { label: "Copy file path", icon: "copy", action: () => this.view.actions.copy(file.path, "the path") },
          { label: "Show in file manager", icon: "folderOpen", action: () => void api.reveal(`${this.view.info.root}/${dir}`) },
        ],
        { x: event.clientX, y: event.clientY },
      );
    });
    return row;
  }

  private async discard(file: FileChange): Promise<void> {
    const ok = await confirmAction({
      title: `Discard changes to ${splitPath(file.path).name}?`,
      message: file.kind === "untracked" ? "The new file is deleted." : "The file goes back to its staged (or last committed) version.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) await this.view.attempt("Discard", () => api.discard(this.view.id, [file.path]), { graph: false });
  }

  private async resolve(file: FileChange, side: "ours" | "theirs"): Promise<void> {
    await this.view.attempt(side === "ours" ? "Take ours" : "Take theirs", () => api.resolveWith(this.view.id, [file.path], side), { graph: false });
  }

  private updateComposer(): void {
    const status = this.view.snapshot?.status;
    const length = [...this.summary.value].length;
    this.counter.textContent = String(SUMMARY_LIMIT - length);
    this.counter.classList.toggle("over", length > SUMMARY_LIMIT);
    const staged = status?.staged.length ?? 0;
    const merging = this.view.snapshot?.state.kind === "merging";
    const amending = this.amend.checked;
    this.commitButton.disabled = !this.summary.value.trim() || (!staged && !amending && !merging) || this.view.isBusy();
    this.commitButton.textContent = amending
      ? "Amend previous commit"
      : merging
        ? "Commit the merge"
        : staged
          ? `Commit changes to ${plural(staged, "file")}`
          : "Stage changes to commit";
    this.commitButton.title = `Commit (${shortcutLabel("commit")}). Stage everything and commit: ⇧${shortcutLabel("commit")}`;
  }

  private async toggleAmend(): Promise<void> {
    if (this.amend.checked) {
      this.draft = { summary: this.summary.value, description: this.description.value };
      try {
        const message = await api.headMessage(this.view.id);
        const [first, ...rest] = message.split("\n");
        this.summary.value = first;
        this.description.value = rest.join("\n").trim();
      } catch (error) {
        this.amend.checked = false;
        notify.error("Nothing to amend", errorMessage(error));
      }
    } else if (this.draft) {
      this.summary.value = this.draft.summary;
      this.description.value = this.draft.description;
      this.draft = null;
    }
    this.updateComposer();
  }

  /** Commits what's staged; `everything` stages all changes first. */
  async commit(everything: boolean): Promise<void> {
    const summary = this.summary.value.trim();
    if (!summary) {
      this.summary.focus();
      return;
    }
    const description = this.description.value.trim();
    const message = description ? `${summary}\n\n${description}` : summary;
    const amend = this.amend.checked;
    const done = await this.view.attempt(amend ? "Amend" : "Commit", async () => {
      if (everything) await api.stageAll(this.view.id);
      return api.commit(this.view.id, message, amend);
    });
    if (done !== undefined) {
      this.summary.value = "";
      this.description.value = "";
      this.amend.checked = false;
      this.draft = null;
      this.updateComposer();
    }
  }

  // Commits and stashes

  private renderCommit(details: CommitDetails): void {
    const commit = this.view.graph?.commits.find((c) => c.oid === details.oid);
    const stash = commit?.kind === "stash" ? commit.stash : undefined;
    const nodes: HTMLElement[] = [];

    const shaButton = el("button", "sha-button mono", shortSha(details.oid), icon("copy", 12));
    shaButton.type = "button";
    shaButton.title = "Copy the full SHA";
    shaButton.addEventListener("click", () => this.view.actions.copy(details.oid, "the commit SHA"));
    const parents = el("span", "parents");
    if (details.parents.length) {
      parents.append(details.parents.length > 1 ? "parents " : "parent ");
      details.parents.forEach((p, i) => {
        if (i) parents.append(" ");
        const link = el("button", "link mono", shortSha(p));
        link.type = "button";
        link.addEventListener("click", () => this.view.revealCommit(p));
        parents.append(link);
      });
    }
    const top = el("div", "commit-top", shaButton, parents);

    const author = el(
      "div",
      "commit-person",
      avatar(details.author, details.email, 32),
      el(
        "div",
        "person-text",
        el("div", "person-name", details.author),
        el("div", "person-meta", `authored ${relativeTime(details.authorTime)} · ${absoluteTime(details.authorTime)}`),
      ),
    );
    const head = el("div", "commit-head", top, el("h2", "commit-title", stash ? `${stash}: ${details.summary}` : details.summary), author);
    if (details.body) head.append(el("div", "commit-body", details.body));
    if (details.committer !== details.author || details.committerEmail !== details.email) {
      head.append(el("div", "person-meta", `committed by ${details.committer} ${relativeTime(details.commitTime)}`));
    }
    nodes.push(head);

    if (stash) {
      const actions = el("div", "stash-actions");
      const apply = el("button", "button-secondary small", icon("pop", 13), "Apply");
      apply.type = "button";
      apply.addEventListener("click", () => this.view.actions.applyStash(stash));
      const pop = el("button", "button-primary small", icon("pop", 13), "Pop");
      pop.type = "button";
      pop.addEventListener("click", () => this.view.actions.pop(stash));
      const drop = el("button", "button-secondary small danger", icon("trash", 13), "Delete");
      drop.type = "button";
      drop.addEventListener("click", () => this.view.actions.dropStash(stash));
      actions.append(apply, pop, drop);
      nodes.push(actions);
    }

    const target: DiffTarget = { kind: "commit", oid: details.oid };
    const list = el("div", "file-list");
    for (const file of details.files) list.append(this.fileRow(file, target, []));
    if (!details.files.length) list.append(el("div", "file-empty", details.parents.length > 1 ? "No changes compared with the first parent" : "No file changes"));
    const label = details.parents.length > 1 ? `${plural(details.files.length, "file")} changed (vs. first parent)` : `${plural(details.files.length, "file")} changed`;
    nodes.push(el("section", "file-section", el("div", "file-section-header", el("span", "file-section-title", label)), list));

    this.content.replaceChildren(...nodes);
    this.markOpenFile(this.openFile);
  }
}

function keyOf(target: DiffTarget, path: string): string {
  return `${target.kind}:${"oid" in target ? target.oid : ""}:${path}`;
}
