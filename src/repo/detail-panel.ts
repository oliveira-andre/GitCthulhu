// The right panel. For uncommitted changes it is the staging area and the
// commit composer; for a commit or stash it shows the details and files.
import { type CommitDetails, type DiffTarget, type FileChange, type Identity, WORK_IN_PROGRESS, api, errorKind, errorMessage } from "../api";
import { confirmAction, form } from "../dialogs";
import { el } from "../dom";
import { CHANGE_LABELS, absoluteTime, avatar, plural, relativeTime, shortSha, splitPath } from "../format";
import { type IconName, icon, iconButton } from "../icons";
import { type MenuItem, showMenu } from "../menu";
import { isMac, shortcutLabel } from "../platform";
import { notify } from "../toast";
import type { DiffRequest, RepoView } from "./repo-view";

const SUMMARY_LIMIT = 72;
/** `shown` while several commits are selected. */
const MANY = "several-commits";
const TREE_KEY = "gitcthulhu.fileView";

function loadTreeView(): boolean {
  try {
    return localStorage.getItem(TREE_KEY) === "tree";
  } catch {
    return false;
  }
}

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
  private readonly signOff: HTMLInputElement;
  private readonly noVerify: HTMLInputElement;
  private readonly identityLine: HTMLButtonElement;
  private identity: Identity | null = null;
  /** Files picked for bulk actions, within one section. */
  private picked = new Set<string>();
  private pickedSection: string | null = null;
  private pickAnchor: string | null = null;
  /** The row (`data-key`) last opened from the lists, for ↑/↓ when its diff isn't the one showing. */
  private cursor: string | null = null;
  /** What each file row shows, for ↑/↓. */
  private rowFiles = new WeakMap<HTMLElement, { target: DiffTarget; file: FileChange }>();
  private treeView = loadTreeView();
  private collapsedFolders = new Set<string>();
  /** Uncommitted-changes sections (by title) folded down to their header. */
  private collapsedSections = new Set<string>();
  /** The commit template was offered once; after that the box stays as the user leaves it. */
  private templateOffered = false;
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
    this.signOff = el("input");
    this.signOff.type = "checkbox";
    this.noVerify = el("input");
    this.noVerify.type = "checkbox";
    const signOffLabel = el("label", "checkbox small", this.signOff, "Sign off");
    signOffLabel.title = "Add a Signed-off-by line (--signoff)";
    const noVerifyLabel = el("label", "checkbox small", this.noVerify, "Skip hooks");
    noVerifyLabel.title = "Don't run the pre-commit and commit-msg hooks (--no-verify)";
    this.identityLine = el("button", "composer-identity");
    this.identityLine.type = "button";
    this.identityLine.title = "Change who commits are made as";
    this.identityLine.addEventListener("click", () => void this.editIdentity());
    this.composer = el(
      "div",
      "composer",
      el("div", "composer-head", el("label", "checkbox", this.amend, "Amend previous commit"), this.counter),
      this.summary,
      this.description,
      el("div", "composer-options", signOffLabel, noVerifyLabel, this.identityLine),
      this.commitButton,
    );
    this.content = el("div", "detail-content");
    // Focused after a file is opened from it, so ↑/↓ walk the files.
    this.content.tabIndex = -1;
    this.content.addEventListener("keydown", (event) => {
      if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      this.step(event.key === "ArrowDown" ? 1 : -1);
    });
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
    this.content.classList.toggle("staging", oid === WORK_IN_PROGRESS);
    if (!oid) {
      this.content.replaceChildren(el("div", "detail-empty", "Nothing selected"));
      return;
    }
    if (oid === WORK_IN_PROGRESS) {
      this.renderWip();
      void this.loadComposerContext();
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

  /** Several commits: act on them together, or compare two. */
  async showMany(oids: string[]): Promise<void> {
    this.shown = MANY;
    const token = ++this.token;
    this.composer.hidden = true;
    this.content.classList.remove("staging");
    const commits = oids.map((oid) => this.view.graph?.commits.find((c) => c.oid === oid)).filter((c) => c !== undefined);
    const n = plural(oids.length, "commit");

    const actions = el("div", "stash-actions");
    const add = (label: string, iconName: IconName, action: () => void, primary = false) => {
      const b = el("button", primary ? "button-primary small" : "button-secondary small", icon(iconName, 13), label);
      b.type = "button";
      b.addEventListener("click", action);
      actions.append(b);
    };
    add(`Cherry-pick ${n}`, "commit", () => this.view.actions.cherryPickMany(oids), true);
    add(`Revert ${n}`, "undo", () => this.view.actions.revertMany(oids));
    add("Copy SHAs", "copy", () => this.view.actions.copy(oids.join("\n"), `${oids.length} SHAs`));

    const list = el("div", "file-list");
    for (const c of commits) {
      const row = el("div", "file-row", icon("commit", 14), el("span", "mono sha-inline", shortSha(c.oid)), el("span", "file-path", el("span", "file-name", c.subject)));
      row.addEventListener("click", () => this.view.selectCommit(c.oid, { scroll: "nearest" }));
      list.append(row);
    }
    const nodes: HTMLElement[] = [
      el("div", "commit-head", el("h2", "commit-title", `${n} selected`), el("div", "person-meta", `${isMac ? "⌘" : "Ctrl"}-click adds or removes a commit, ⇧-click selects a range.`)),
      actions,
      el("section", "file-section", el("div", "file-section-header", el("span", "file-section-title", "Selected commits")), list),
    ];
    this.content.replaceChildren(...nodes);

    if (oids.length !== 2) return;
    // Graph order is newest first: compare the older one to the newer one.
    const [to, from] = oids;
    const section = el("section", "file-section", el("div", "file-section-header", el("span", "file-section-title", `Changes from ${shortSha(from)} to ${shortSha(to)}`)));
    const files = el("div", "file-list", el("div", "file-empty", "Loading…"));
    section.append(files);
    this.content.append(section);
    try {
      const changed = await api.compareFiles(this.view.id, from, to);
      if (token !== this.token) return;
      const target: DiffTarget = { kind: "range", from, to };
      files.replaceChildren(...changed.map((file) => this.fileRow(file, target, [])));
      if (!changed.length) files.append(el("div", "file-empty", "No differences"));
      this.markOpenFile(this.openFile);
    } catch (error) {
      if (token === this.token) files.replaceChildren(el("div", "file-empty", errorMessage(error)));
    }
  }

  /** New status or refs arrived. */
  async refresh(): Promise<void> {
    if (this.shown === MANY) {
      const oids = this.view.selection();
      if (oids.length > 1) await this.showMany(oids);
      else await this.show(oids[0] ?? null);
      return;
    }
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
    // Each list scrolls on its own: keep it where it was across re-renders.
    const scrolled = new Map([...this.content.querySelectorAll<HTMLElement>(".file-list[data-list]")].map((list) => [list.dataset.list, list.scrollTop]));
    this.content.replaceChildren(...nodes);
    for (const list of this.content.querySelectorAll<HTMLElement>(".file-list[data-list]")) list.scrollTop = scrolled.get(list.dataset.list) ?? 0;
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
      applyingPatches: "Applying patches",
      bisecting: "Bisect in progress",
    };
    let detail = conflicted ? `${plural(conflicted, "file")} still conflicted.` : "All conflicts are resolved.";
    if ((state.kind === "rebasing" || state.kind === "applyingPatches") && state.step && state.total) detail = `${state.kind === "rebasing" ? "Commit" : "Patch"} ${state.step} of ${state.total}. ${detail}`;
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
    if (state.kind === "rebasing" || state.kind === "cherryPicking" || state.kind === "reverting" || state.kind === "applyingPatches") {
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
    const section = target.kind;
    const picked = this.pickedSection === section ? files.filter((f) => this.picked.has(f.path)) : [];
    const open = !this.collapsedSections.has(title);
    const header = el("div", "file-section-header collapsible", el("span", "file-section-title", icon(open ? "chevronDown" : "chevronRight", 12), `${title} (${files.length})`));
    header.addEventListener("click", (event) => {
      if ((event.target as Element).closest("button")) return;
      if (open) this.collapsedSections.add(title);
      else this.collapsedSections.delete(title);
      this.renderWip();
    });
    const tools = el("span", "file-section-tools");
    if (picked.length > 1 && (section === "unstaged" || section === "staged")) {
      for (const [label, run] of this.pickedActions(section, picked.map((f) => f.path))) {
        const b = el("button", label.startsWith("Discard") ? "button-secondary small danger" : "button-secondary small", label);
        b.type = "button";
        b.addEventListener("click", run);
        tools.append(b);
      }
    } else if (bulk && files.length) {
      const b = el("button", "button-secondary small", bulk.label);
      b.type = "button";
      b.title = `${bulk.label} (${bulk.shortcut})`;
      b.addEventListener("click", bulk.action);
      tools.append(b);
    }
    if (files.length) {
      tools.append(iconButton(this.treeView ? "file" : "tree", this.treeView ? "Show as a list of paths" : "Show as a folder tree", () => this.setTreeView(!this.treeView), "icon-button small"));
    }
    header.append(tools);
    if (!open) return el("section", "file-section collapsed", header);
    const list = el("div", "file-list");
    list.dataset.list = title;
    if (this.treeView) this.renderTree(list, files, target, buttons);
    else for (const file of files) list.append(this.fileRow(file, target, buttons(file), files));
    if (!files.length) list.append(el("div", "file-empty", "None"));
    return el("section", "file-section", header, list);
  }

  /** Bulk actions for several picked files in one section. */
  private pickedActions(section: "unstaged" | "staged", paths: string[]): [string, () => void][] {
    const n = paths.length;
    const done = () => this.clearPicked();
    const run = (label: string, operation: () => Promise<unknown>) => () =>
      void this.view.attempt(label, operation, { graph: false }).then(done);
    if (section === "staged") {
      return [
        [`Unstage ${n}`, run("Unstage", () => api.unstage(this.view.id, paths))],
        [`Stash ${n}`, run("Stash", () => api.stashPush(this.view.id, null, true, paths))],
      ];
    }
    return [
      [`Stage ${n}`, run("Stage", () => api.stage(this.view.id, paths))],
      [`Stash ${n}`, run("Stash", () => api.stashPush(this.view.id, null, true, paths))],
      [
        `Discard ${n}`,
        () =>
          void confirmAction({ title: `Discard changes to ${plural(n, "file")}?`, message: "Unstaged edits are thrown away and new files are deleted. Undo can bring them back.", confirmLabel: "Discard", danger: true }).then(
            (ok) => ok && run("Discard", () => api.discard(this.view.id, paths))(),
          ),
      ],
    ];
  }

  private setTreeView(tree: boolean): void {
    this.treeView = tree;
    try {
      localStorage.setItem(TREE_KEY, tree ? "tree" : "path");
    } catch {
      // Not remembered this time.
    }
    void this.refresh();
  }

  /** Files grouped into folders, each collapsible; a folder's menu acts on everything in it. */
  private renderTree(list: HTMLElement, files: FileChange[], target: DiffTarget, buttons: (file: FileChange) => HTMLElement[]): void {
    interface Folder { name: string; path: string; folders: Map<string, Folder>; files: FileChange[] }
    const root: Folder = { name: "", path: "", folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        const path = node.path ? `${node.path}/${part}` : part;
        let next = node.folders.get(part);
        if (!next) node.folders.set(part, (next = { name: part, path, folders: new Map(), files: [] }));
        node = next;
      }
      node.files.push(file);
    }
    const all = (folder: Folder): FileChange[] => [...folder.files, ...[...folder.folders.values()].flatMap(all)];
    const walk = (folder: Folder, depth: number) => {
      for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        // A chain of single folders reads better as one row: src/app/ui.
        let shown = child;
        let label = child.name;
        while (shown.folders.size === 1 && !shown.files.length) {
          shown = [...shown.folders.values()][0];
          label += `/${shown.name}`;
        }
        const key = `${target.kind}:${shown.path}`;
        const open = !this.collapsedFolders.has(key);
        const row = el("div", "file-row folder-row", icon(open ? "chevronDown" : "chevronRight", 12), icon("folder", 14), el("span", "file-path", el("span", "file-name", label)));
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.addEventListener("click", () => {
          if (open) this.collapsedFolders.add(key);
          else this.collapsedFolders.delete(key);
          void this.refresh();
        });
        const paths = all(shown).map((f) => f.path);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const items =
            target.kind === "unstaged" || target.kind === "staged"
              ? this.pickedActions(target.kind, paths).map(([label, action]) => ({ label: `${label} in ${label.startsWith("Discard") ? "" : ""}${shown.path}`.replace(/ in $/, ""), action }))
              : [];
          showMenu([{ heading: `${shown.path}/ (${plural(paths.length, "file")})` }, ...items, { label: "Copy folder path", icon: "copy", action: () => this.view.actions.copy(shown.path, "the path") }], { x: event.clientX, y: event.clientY });
        });
        list.append(row);
        if (open) walk(shown, depth + 1);
      }
      for (const file of folder.files) {
        const row = this.fileRow(file, target, buttons(file), files, true);
        row.style.paddingLeft = `${24 + depth * 14}px`;
        list.append(row);
      }
    };
    walk(root, 0);
  }

  private fileRow(file: FileChange, target: DiffTarget, buttons: HTMLElement[], siblings: FileChange[] = [], nameOnly = false): HTMLElement {
    const { dir, name } = splitPath(file.path);
    const row = el(
      "div",
      `file-row kind-${file.kind}`,
      icon(CHANGE_ICONS[file.kind], 14),
      el("span", "file-path", nameOnly ? null : el("span", "file-dir", dir), el("span", "file-name", name)),
      el("span", "file-actions", ...buttons),
    );
    row.dataset.key = keyOf(target, file.path);
    this.rowFiles.set(row, { target, file });
    row.classList.toggle("picked", this.pickedSection === target.kind && this.picked.has(file.path));
    row.title = `${CHANGE_LABELS[file.kind]}: ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
    row.addEventListener("click", (event) => {
      if ((event.target as Element).closest(".file-actions")) return;
      const toggle = isMac ? event.metaKey : event.ctrlKey;
      if (toggle || event.shiftKey) {
        this.pick(target.kind, file.path, siblings.map((f) => f.path), event.shiftKey ? "range" : "toggle");
        return;
      }
      this.pick(target.kind, file.path, [], "single");
      this.cursor = row.dataset.key!;
      this.view.openDiff({ target, file }, undefined, false);
      // Conflicts open the merge tool, which takes the keyboard itself.
      if (file.kind !== "conflicted") this.content.focus({ preventScroll: true });
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const section = target.kind;
      const several = this.pickedSection === section && this.picked.size > 1 && this.picked.has(file.path);
      if (several && (section === "unstaged" || section === "staged")) {
        const paths = siblings.map((f) => f.path).filter((p) => this.picked.has(p));
        showMenu(
          [
            { heading: plural(paths.length, "file") },
            ...this.pickedActions(section, paths).map(([label, action]) => ({ label, action, danger: label.startsWith("Discard") })),
            { separator: true },
            { label: "Copy paths", icon: "copy", action: () => this.view.actions.copy(paths.join("\n"), `${paths.length} paths`) },
          ],
          { x: event.clientX, y: event.clientY },
        );
        return;
      }
      const singleActions: MenuItem[] =
        section === "unstaged" && file.kind !== "conflicted"
          ? [{ label: "Stash this file", icon: "stash", action: () => void this.view.attempt("Stash", () => api.stashPush(this.view.id, null, true, [file.path]), { graph: false }) }, { separator: true }]
          : [];
      showMenu(
        [
          ...singleActions,
          { label: "File history", icon: "tree", disabled: file.kind === "untracked", action: () => void this.view.history.open(file.path, "diff") },
          { label: "Blame", icon: "file", disabled: file.kind === "untracked" || file.kind === "deleted", action: () => void this.view.history.open(file.path, "blame") },
          { separator: true },
          { label: "Open in editor", icon: "fileModified", disabled: file.kind === "deleted", action: () => void this.view.actions.openInEditor(file.path) },
          { label: "Copy file path", icon: "copy", action: () => this.view.actions.copy(file.path, "the path") },
          { label: "Show in file manager", icon: "folderOpen", action: () => void api.reveal(`${this.view.info.root}/${dir}`) },
        ],
        { x: event.clientX, y: event.clientY },
      );
    });
    return row;
  }

  /** File selection for bulk actions: ⌘/Ctrl-click toggles, ⇧-click selects a range, in one section at a time. */
  private pick(section: string, path: string, order: string[], mode: "single" | "toggle" | "range"): void {
    if (this.pickedSection !== section) {
      this.picked.clear();
      this.pickedSection = section;
      this.pickAnchor = null;
    }
    if (mode === "single") {
      this.picked = new Set([path]);
      this.pickAnchor = path;
    } else if (mode === "toggle") {
      if (this.picked.has(path)) this.picked.delete(path);
      else this.picked.add(path);
      this.pickAnchor = path;
    } else {
      const a = order.indexOf(this.pickAnchor ?? path);
      const b = order.indexOf(path);
      const [from, to] = a < b ? [a, b] : [b, a];
      for (const p of order.slice(Math.max(from, 0), to + 1)) this.picked.add(p);
    }
    void this.refresh();
  }

  /**
   * ↑/↓: opens the next or previous file, top to bottom through the
   * unstaged files and then the staged ones (or a commit's files), and round
   * again from either end. Conflicted files belong to the merge tool and are
   * skipped; files in collapsed sections or folders aren't on screen and are
   * skipped too.
   */
  private step(direction: 1 | -1): void {
    const rows = [...this.content.querySelectorAll<HTMLElement>(".file-row[data-key]:not(.kind-conflicted)")];
    if (!rows.length) return;
    let at = rows.findIndex((row) => row.classList.contains("open"));
    if (at < 0) at = rows.findIndex((row) => row.dataset.key === this.cursor);
    const next = rows[at < 0 ? (direction > 0 ? 0 : rows.length - 1) : (at + direction + rows.length) % rows.length];
    const shown = this.rowFiles.get(next);
    if (!shown) return;
    const key = next.dataset.key!;
    this.cursor = key;
    this.pick(shown.target.kind, shown.file.path, [], "single");
    this.view.openDiff(shown, undefined, false);
    // Picking re-rendered the list: find the row again to keep it in view.
    this.content.querySelector<HTMLElement>(`.file-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private clearPicked(): void {
    this.picked.clear();
    this.pickedSection = null;
    this.pickAnchor = null;
  }

  /** The `s` key: stage the picked unstaged files, or the one whose diff is open. */
  stageKey(): void {
    const status = this.view.snapshot?.status;
    if (!status) return;
    const paths = this.pickedSection === "unstaged" ? status.unstaged.filter((f) => this.picked.has(f.path)).map((f) => f.path) : [];
    const open = this.view.diff.openFile();
    if (!paths.length && open?.target.kind === "unstaged") paths.push(open.file.path);
    if (paths.length) void this.view.attempt("Stage", () => api.stage(this.view.id, paths), { graph: false }).then(() => this.clearPicked());
  }

  /** The `u` key: unstage the picked staged files, or the one whose diff is open. */
  unstageKey(): void {
    const status = this.view.snapshot?.status;
    if (!status) return;
    const paths = this.pickedSection === "staged" ? status.staged.filter((f) => this.picked.has(f.path)).map((f) => f.path) : [];
    const open = this.view.diff.openFile();
    if (!paths.length && open?.target.kind === "staged") paths.push(open.file.path);
    if (paths.length) void this.view.attempt("Unstage", () => api.unstage(this.view.id, paths), { graph: false }).then(() => this.clearPicked());
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
    const run = () =>
      this.view.run(amend ? "Amend" : "Commit", async () => {
        if (everything) await api.stageAll(this.view.id);
        return api.commit(this.view.id, message, amend, this.signOff.checked, this.noVerify.checked);
      });
    let done: string | undefined;
    try {
      done = await run();
    } catch (error) {
      // git doesn't know who's committing: ask, then try again.
      if (errorKind(error) === "identityUnknown" && (await this.editIdentity(true))) {
        done = await run().catch(() => undefined);
      }
    }
    if (done !== undefined) {
      this.summary.value = "";
      this.description.value = "";
      this.amend.checked = false;
      this.draft = null;
      this.updateComposer();
    }
  }

  /** The global name and email changed, from the title bar or another repository. */
  identityChanged(): void {
    if (this.shown === WORK_IN_PROGRESS) void this.loadComposerContext();
  }

  /** Shows who commits are made as; fills the message from `commit.template` once. */
  private async loadComposerContext(): Promise<void> {
    try {
      this.identity = await api.identity(this.view.id);
    } catch {
      this.identity = null;
    }
    const who = this.identity;
    this.identityLine.textContent = who?.name || who?.email ? `as ${who.name ?? "?"}${who.email ? ` <${who.email}>` : ""}` : "Set your name and email";
    this.identityLine.classList.toggle("missing", !who?.name || !who?.email);
    if (!this.templateOffered) {
      this.templateOffered = true;
      const template = await api.commitTemplate(this.view.id).catch(() => null);
      if (template && !this.summary.value && !this.description.value) {
        const [first, ...rest] = template.split("\n");
        this.summary.value = first;
        this.description.value = rest.join("\n").trim();
        this.updateComposer();
      }
    }
  }

  /** Asks for the commit name and email; resolves to whether they were saved. */
  private async editIdentity(missing = false): Promise<boolean> {
    const who = this.identity;
    const result = await form({
      title: missing ? "Who's committing?" : "Commit identity",
      message: missing ? "Git needs a name and email for commits, and none is set yet." : "The name and email new commits are made with.",
      fields: [
        { name: "name", label: "Name", type: "text", value: who?.name ?? "" },
        { name: "email", label: "Email", type: "text", value: who?.email ?? "" },
        { name: "global", label: "Use it for all repositories", type: "checkbox", value: missing || !who?.local },
      ],
      confirmLabel: "Save",
      validate: (v) => (!String(v.name).trim() ? "Enter a name." : !/^\S+@\S+$/.test(String(v.email).trim()) ? "Enter an email address." : null),
    });
    if (!result) return false;
    try {
      await api.setIdentity(this.view.id, String(result.name), String(result.email), Boolean(result.global));
    } catch (error) {
      notify.error("Couldn't save the identity", errorMessage(error));
      return false;
    }
    await this.loadComposerContext();
    if (result.global) this.view.shell.identityChanged();
    return true;
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
      const rename = el("button", "button-secondary small", icon("fileModified", 13), "Rename");
      rename.type = "button";
      rename.addEventListener("click", () => this.view.actions.renameStash(stash, details.summary));
      const drop = el("button", "button-secondary small danger", icon("trash", 13), "Delete");
      drop.type = "button";
      drop.addEventListener("click", () => this.view.actions.dropStash(stash));
      actions.append(apply, pop, rename, drop);
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
    if (stash) void this.showStashUntracked(details.oid);
  }

  /** A stash's untracked files live in a commit of their own; list them under the tracked ones. */
  private async showStashUntracked(oid: string): Promise<void> {
    const token = this.token;
    const untracked = await api.stashUntracked(this.view.id, oid).catch(() => null);
    if (token !== this.token || !untracked?.commit || !untracked.files.length) return;
    const target: DiffTarget = { kind: "commit", oid: untracked.commit };
    const list = el("div", "file-list", ...untracked.files.map((file) => this.fileRow({ ...file, kind: "untracked" }, target, [])));
    this.content.append(el("section", "file-section", el("div", "file-section-header", el("span", "file-section-title", `Untracked files (${untracked.files.length})`)), list));
    this.markOpenFile(this.openFile);
  }
}

function keyOf(target: DiffTarget, path: string): string {
  return `${target.kind}:${"oid" in target ? target.oid : ""}:${path}`;
}
