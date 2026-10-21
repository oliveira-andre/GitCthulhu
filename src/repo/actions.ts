// Git operations behind the toolbar, menus, shortcuts and the palette, with
// their confirmations and follow-up questions.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type GraphCommit, type PullMode, type Ref, type ResetMode, api, errorMessage } from "../api";
import { confirmAction, form, promptText, refNameProblem } from "../dialogs";
import { shortSha } from "../format";
import { type MenuItem, showMenu } from "../menu";
import { notify } from "../toast";
import type { RepoView } from "./repo-view";

type Point = { x: number; y: number };

export class Actions {
  constructor(private readonly view: RepoView) {}

  private get id(): string {
    return this.view.id;
  }

  private refs(): Ref[] {
    return this.view.snapshot?.refs ?? [];
  }

  findRef(fullName: string): Ref | undefined {
    return this.refs().find((r) => r.name === fullName);
  }

  currentBranch(): string | null {
    return this.view.snapshot?.head.branch ?? null;
  }

  private headRef(): Ref | undefined {
    return this.refs().find((r) => r.kind === "local" && r.isHead);
  }

  async copy(text: string, what: string): Promise<void> {
    try {
      await writeText(text);
      notify.success(`Copied ${what}`, text.length > 60 ? undefined : text);
    } catch (error) {
      notify.error("Couldn't copy", errorMessage(error));
    }
  }

  // Checkout

  /** Checks out a branch (remote ones get a local tracking branch) or a tag. */
  async checkoutRef(fullName: string): Promise<void> {
    const ref = this.findRef(fullName);
    if (!ref || (ref.kind === "local" && ref.isHead)) return;
    if (ref.kind === "tag") {
      const ok = await confirmAction({
        title: `Check out ${ref.short}?`,
        message: "Checking out a tag leaves you on a detached HEAD: new commits won't be on any branch until you create one.",
        confirmLabel: "Check out",
      });
      if (ok) await this.withAutoStash(`Check out ${ref.short}`, () => api.checkoutCommit(this.id, ref.oid));
      return;
    }
    if (ref.kind === "remote") {
      await this.withAutoStash(`Check out ${ref.short}`, () => api.checkoutRemoteBranch(this.id, ref.short));
    } else {
      await this.withAutoStash(`Check out ${ref.short}`, () => api.checkoutBranch(this.id, ref.short));
    }
  }

  async checkoutCommit(commit: GraphCommit): Promise<void> {
    const ok = await confirmAction({
      title: `Check out ${shortSha(commit.oid)}?`,
      message: "You'll be on a detached HEAD. Create a branch from it if you want to keep new commits.",
      confirmLabel: "Check out",
    });
    if (ok) await this.withAutoStash(`Check out ${shortSha(commit.oid)}`, () => api.checkoutCommit(this.id, commit.oid));
  }

  /** Runs a checkout; if local changes are in the way, offers to stash them first. */
  private async withAutoStash(label: string, checkout: () => Promise<unknown>): Promise<void> {
    try {
      await this.view.run(label, checkout);
    } catch (error) {
      const message = errorMessage(error);
      if (!/local changes|would be overwritten|untracked working tree files/i.test(message)) return;
      const ok = await confirmAction({
        title: "Stash your changes first?",
        message: "Your uncommitted changes conflict with the checkout. Stash them, then check out? You can pop the stash afterwards.",
        confirmLabel: "Stash and check out",
      });
      if (!ok) return;
      await this.view.attempt(label, async () => {
        await api.stashPush(this.id, `Auto stash before ${label.toLowerCase()}`, true);
        await checkout();
      });
    }
  }

  // Branches

  async createBranch(at: string | null = null): Promise<void> {
    const result = await form({
      title: at ? `Create a branch at ${shortSha(at)}` : "Create a branch",
      fields: [
        { name: "name", label: "Branch name", type: "text", placeholder: "feature/my-change", mono: true },
        { name: "checkout", label: "Check it out", type: "checkbox", value: true },
      ],
      confirmLabel: "Create branch",
      validate: (v) => refNameProblem(String(v.name)) ?? (this.refs().some((r) => r.kind === "local" && r.short === String(v.name).trim()) ? "A branch with that name already exists." : null),
    });
    if (!result) return;
    const name = String(result.name).trim();
    await this.view.attempt(`Create ${name}`, () => api.createBranch(this.id, name, at, Boolean(result.checkout)));
  }

  async renameBranch(ref: Ref): Promise<void> {
    const name = await promptText({
      title: `Rename ${ref.short}`,
      label: "New name",
      value: ref.short,
      confirmLabel: "Rename",
      validate: refNameProblem,
    });
    if (name && name.trim() !== ref.short) {
      await this.view.attempt("Rename branch", () => api.renameBranch(this.id, ref.short, name.trim()));
    }
  }

  async deleteBranch(ref: Ref): Promise<void> {
    if (ref.kind === "remote") return this.deleteRemoteBranch(ref);
    const ok = await confirmAction({
      title: `Delete ${ref.short}?`,
      message: "The branch is removed from this repository. Its commits stay reachable from other branches that contain them.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await this.view.run(`Delete ${ref.short}`, () => api.deleteBranch(this.id, ref.short, false), { success: `Deleted ${ref.short}` });
    } catch (error) {
      if (!/not fully merged/i.test(errorMessage(error))) return;
      const force = await confirmAction({
        title: `${ref.short} isn't merged`,
        message: "It has commits that no other branch contains. Deleting it anyway can lose them (they stay in the reflog for a while).",
        confirmLabel: "Delete anyway",
        danger: true,
      });
      if (force) await this.view.attempt(`Delete ${ref.short}`, () => api.deleteBranch(this.id, ref.short, true));
    }
  }

  async deleteRemoteBranch(ref: Ref): Promise<void> {
    if (!ref.remote) return;
    const remote = ref.remote;
    const branch = ref.short.slice(remote.length + 1);
    const ok = await confirmAction({
      title: `Delete ${ref.short} on ${remote}?`,
      message: "This deletes the branch on the remote for everyone who uses it.",
      confirmLabel: "Delete from remote",
      danger: true,
    });
    if (ok) {
      await this.view.attempt(`Delete ${ref.short}`, (p) => api.deleteRemoteRef(this.id, remote, `refs/heads/${branch}`, p), {
        progress: true,
        success: `Deleted ${ref.short}`,
      });
    }
  }

  async merge(ref: Ref): Promise<void> {
    const current = this.currentBranch();
    if (!current) return void notify.error("Check out a branch first", "Merging needs a branch to merge into.");
    await this.view.attempt(`Merge ${ref.short} into ${current}`, () => api.merge(this.id, ref.short, "default"), {
      success: `Merged ${ref.short} into ${current}`,
    });
  }

  async rebaseOnto(target: string, label: string): Promise<void> {
    const current = this.currentBranch();
    if (!current) return;
    const ok = await confirmAction({
      title: `Rebase ${current} onto ${label}?`,
      message: `The commits on ${current} that aren't on ${label} are replayed on top of it, which rewrites them. Avoid this for commits others already have.`,
      confirmLabel: "Rebase",
    });
    if (ok) await this.view.attempt(`Rebase ${current}`, () => api.rebase(this.id, target), { success: `Rebased ${current} onto ${label}` });
  }

  async fastForward(ref: Ref): Promise<void> {
    if (!ref.upstream) return;
    if (ref.isHead) {
      await this.pull("fastForwardOnly");
    } else {
      await this.view.attempt(`Fast-forward ${ref.short}`, () => api.fastForwardBranch(this.id, ref.short, ref.upstream!), {
        success: `${ref.short} is up to date with ${ref.upstream}`,
      });
    }
  }

  // Commits

  async cherryPick(commit: GraphCommit): Promise<void> {
    await this.view.attempt(`Cherry-pick ${shortSha(commit.oid)}`, () => api.cherryPick(this.id, [commit.oid]), {
      success: `Cherry-picked ${shortSha(commit.oid)}`,
    });
  }

  async revert(commit: GraphCommit): Promise<void> {
    const ok = await confirmAction({
      title: `Revert ${shortSha(commit.oid)}?`,
      message: `A new commit will undo "${commit.subject}".`,
      confirmLabel: "Revert",
    });
    if (ok) await this.view.attempt(`Revert ${shortSha(commit.oid)}`, () => api.revert(this.id, commit.oid), { success: "Reverted" });
  }

  async reset(commit: GraphCommit, mode: ResetMode): Promise<void> {
    const branch = this.currentBranch() ?? "HEAD";
    const explanations: Record<ResetMode, string> = {
      soft: "Changes from the commits after it are kept, staged.",
      mixed: "Changes from the commits after it are kept in the working tree, unstaged.",
      hard: "All uncommitted changes and the commits after it are thrown away.",
    };
    const ok = await confirmAction({
      title: `Reset ${branch} to ${shortSha(commit.oid)} (${mode})?`,
      message: explanations[mode],
      confirmLabel: `${mode[0].toUpperCase()}${mode.slice(1)} reset`,
      danger: mode === "hard",
    });
    if (ok) await this.view.attempt(`Reset ${branch}`, () => api.reset(this.id, commit.oid, mode));
  }

  async createTag(at: string, annotated: boolean): Promise<void> {
    const fields: Parameters<typeof form>[0]["fields"] = [{ name: "name", label: "Tag name", type: "text", placeholder: "v1.0.0", mono: true }];
    if (annotated) fields.push({ name: "message", label: "Message", type: "textarea", rows: 3 });
    const result = await form({
      title: `${annotated ? "Create an annotated tag" : "Create a tag"} at ${shortSha(at)}`,
      fields,
      confirmLabel: "Create tag",
      validate: (v) => refNameProblem(String(v.name)) ?? (annotated && !String(v.message).trim() ? "Annotated tags need a message." : null),
    });
    if (!result) return;
    const name = String(result.name).trim();
    await this.view.attempt(`Tag ${name}`, () => api.createTag(this.id, name, at, annotated ? String(result.message) : null));
  }

  async deleteTag(ref: Ref): Promise<void> {
    const ok = await confirmAction({ title: `Delete tag ${ref.short}?`, message: "The tag is removed from this repository only.", confirmLabel: "Delete", danger: true });
    if (ok) await this.view.attempt(`Delete ${ref.short}`, () => api.deleteTag(this.id, ref.short));
  }

  async pushTag(ref: Ref): Promise<void> {
    const remote = await this.pickRemote(`Push ${ref.short} to`);
    if (remote) {
      await this.view.attempt(`Push ${ref.short}`, (p) => api.pushTag(this.id, remote, ref.short, p), { progress: true, success: `Pushed ${ref.short} to ${remote}` });
    }
  }

  async deleteRemoteTag(ref: Ref): Promise<void> {
    const remote = await this.pickRemote(`Delete ${ref.short} from`);
    if (!remote) return;
    const ok = await confirmAction({ title: `Delete ${ref.short} from ${remote}?`, message: "Others may already have fetched it.", confirmLabel: "Delete from remote", danger: true });
    if (ok) {
      await this.view.attempt(`Delete ${ref.short}`, (p) => api.deleteRemoteRef(this.id, remote, `refs/tags/${ref.short}`, p), { progress: true, success: `Deleted ${ref.short} from ${remote}` });
    }
  }

  // Working tree and stashes

  async stash(): Promise<void> {
    await this.view.attempt("Stash", () => api.stashPush(this.id, null, true), { success: "Stashed your changes" });
  }

  async stashWithMessage(): Promise<void> {
    const message = await promptText({ title: "Stash changes", label: "Message", placeholder: "Optional", confirmLabel: "Stash" });
    if (message !== null) {
      await this.view.attempt("Stash", () => api.stashPush(this.id, message || null, true), { success: "Stashed your changes" });
    }
  }

  async pop(stash = "stash@{0}"): Promise<void> {
    if (!this.view.snapshot?.stashes.length) return void notify.info("There are no stashes");
    await this.view.attempt("Pop stash", () => api.stashApply(this.id, stash, true), { success: "Popped the stash" });
  }

  async applyStash(stash: string): Promise<void> {
    await this.view.attempt("Apply stash", () => api.stashApply(this.id, stash, false), { success: "Applied the stash" });
  }

  async dropStash(stash: string): Promise<void> {
    const ok = await confirmAction({ title: `Delete ${stash}?`, message: "Its changes are gone for good.", confirmLabel: "Delete", danger: true });
    if (ok) await this.view.attempt("Delete stash", () => api.stashDrop(this.id, stash));
  }

  async stageAll(): Promise<void> {
    await this.view.attempt("Stage all", () => api.stageAll(this.id), { graph: false });
  }

  async unstageAll(): Promise<void> {
    await this.view.attempt("Unstage all", () => api.unstageAll(this.id), { graph: false });
  }

  async discardAll(): Promise<void> {
    const status = this.view.snapshot?.status;
    if (!status) return;
    const paths = status.unstaged.map((f) => f.path);
    if (!paths.length) return;
    const ok = await confirmAction({
      title: "Discard all unstaged changes?",
      message: "Unstaged edits are thrown away and new files are deleted. Staged changes stay.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) await this.view.attempt("Discard", () => api.discard(this.id, paths), { graph: false });
  }

  // Remotes

  async fetch(): Promise<void> {
    if (!this.view.snapshot?.remotes.length) return void notify.info("This repository has no remotes");
    await this.view.attempt("Fetch", (p) => api.fetch(this.id, null, p), { progress: true, success: "Fetched all remotes" });
  }

  async pull(mode: PullMode): Promise<void> {
    const head = this.headRef();
    if (!head) return void notify.error("Check out a branch to pull");
    if (!head.upstream) return void notify.error(`${head.short} has no upstream`, "Push it first, or set its upstream, to pull.");
    const labels: Record<PullMode, string> = { merge: "Pull", fastForwardOnly: "Pull (fast-forward only)", rebase: "Pull (rebase)" };
    await this.view.attempt(labels[mode], (p) => api.pull(this.id, mode, p), { progress: true, success: `${head.short} is up to date` });
  }

  async push(): Promise<void> {
    const head = this.headRef();
    if (!head) return void notify.error("Check out a branch to push", "You're on a detached HEAD.");
    let remote = head.upstream ? this.refs().find((r) => r.kind === "remote" && r.short === head.upstream)?.remote ?? head.upstream.split("/")[0] : null;
    const setUpstream = !head.upstream;
    if (!remote) {
      remote = await this.pickRemote(`Push ${head.short} to`, true);
      if (!remote) return;
    }
    const target = remote;
    try {
      await this.view.run(`Push ${head.short}`, (p) => api.push(this.id, target, head.short, setUpstream, false, p), {
        progress: true,
        success: `Pushed ${head.short} to ${target}`,
      });
    } catch (error) {
      if (!/rejected|non-fast-forward|fetch first/i.test(errorMessage(error))) return;
      const choice = await form({
        title: `${target} has commits you don't`,
        message: `The push was rejected because ${target}/${head.short} moved on. Pull first to combine the histories, or force push to replace what's on the remote.`,
        fields: [],
        confirmLabel: "Pull",
        extra: [{ label: "Force push", value: "force", danger: true }],
      });
      if (!choice) return;
      if (choice.button === "force") {
        await this.view.attempt(`Force push ${head.short}`, (p) => api.push(this.id, target, head.short, setUpstream, true, p), {
          progress: true,
          success: `Force pushed ${head.short}`,
        });
      } else {
        await this.pull("merge");
      }
    }
  }

  /** Asks which remote to use; skips the question when there's only one. */
  private async pickRemote(title: string, offerDefault = false): Promise<string | null> {
    const remotes = this.view.snapshot?.remotes ?? [];
    if (remotes.length === 0) {
      notify.error("This repository has no remotes", "Add one from the Remote section on the left.");
      return null;
    }
    if (remotes.length === 1 && !offerDefault) return remotes[0];
    const fallback = (await api.defaultRemote(this.id)) ?? remotes[0];
    if (remotes.length === 1) return fallback;
    const result = await form({
      title,
      fields: [{ name: "remote", label: "Remote", type: "select", value: fallback, options: remotes.map((r) => ({ value: r, label: r })) }],
      confirmLabel: "Continue",
    });
    return result ? String(result.remote) : null;
  }

  async addRemote(): Promise<void> {
    const result = await form({
      title: "Add a remote",
      fields: [
        { name: "name", label: "Name", type: "text", value: this.view.snapshot?.remotes.length ? "" : "origin", mono: true },
        { name: "url", label: "URL", type: "text", placeholder: "git@github.com:you/repo.git", mono: true },
      ],
      confirmLabel: "Add remote",
      validate: (v) => (!String(v.name).trim() ? "Enter a name." : !String(v.url).trim() ? "Enter the remote's URL." : null),
    });
    if (!result) return;
    const name = String(result.name).trim();
    await this.view.attempt("Add remote", async (p) => {
      await api.addRemote(this.id, name, String(result.url).trim());
      await api.fetch(this.id, name, p);
    }, { progress: true, success: `Added ${name}` });
  }

  async removeRemote(name: string): Promise<void> {
    const ok = await confirmAction({ title: `Remove ${name}?`, message: "Its remote branches disappear from this repository. Nothing changes on the server.", confirmLabel: "Remove", danger: true });
    if (ok) await this.view.attempt(`Remove ${name}`, () => api.removeRemote(this.id, name));
  }

  // Menus

  refMenu(fullName: string, at: Point | HTMLElement): void {
    const ref = this.findRef(fullName);
    if (!ref) return;
    const current = this.currentBranch();
    const items: MenuItem[] = [];
    if (ref.kind === "local") {
      if (!ref.isHead) items.push({ label: `Check out ${ref.short}`, icon: "check", action: () => this.checkoutRef(ref.name) });
      if (ref.upstream && ref.behind > 0) {
        items.push({ label: `Fast-forward ${ref.short} to ${ref.upstream}`, icon: "pull", action: () => this.fastForward(ref) });
      }
      if (ref.isHead) {
        items.push({ label: "Pull", icon: "pull", action: () => this.pull("merge") }, { label: "Push", icon: "push", action: () => this.push() });
      }
      if (current && !ref.isHead) {
        items.push(
          { separator: true },
          { label: `Merge ${ref.short} into ${current}`, icon: "merge", action: () => this.merge(ref) },
          { label: `Rebase ${current} onto ${ref.short}`, icon: "rebase", action: () => this.rebaseOnto(ref.short, ref.short) },
        );
      }
      items.push(
        { separator: true },
        { label: "Create branch here", icon: "branchPlus", action: () => this.createBranch(ref.oid) },
        { label: "Create tag here", icon: "tag", action: () => this.createTag(ref.oid, false) },
        { separator: true },
        { label: `Rename ${ref.short}…`, action: () => this.renameBranch(ref) },
        { label: "Copy branch name", icon: "copy", action: () => this.copy(ref.short, "the branch name") },
      );
      if (!ref.isHead) items.push({ separator: true }, { label: `Delete ${ref.short}`, icon: "trash", danger: true, action: () => this.deleteBranch(ref) });
    } else if (ref.kind === "remote") {
      items.push({ label: `Check out ${ref.short}`, icon: "check", action: () => this.checkoutRef(ref.name) });
      if (current) {
        items.push(
          { separator: true },
          { label: `Merge ${ref.short} into ${current}`, icon: "merge", action: () => this.merge(ref) },
          { label: `Rebase ${current} onto ${ref.short}`, icon: "rebase", action: () => this.rebaseOnto(ref.short, ref.short) },
        );
      }
      items.push(
        { separator: true },
        { label: "Create branch here", icon: "branchPlus", action: () => this.createBranch(ref.oid) },
        { label: "Copy branch name", icon: "copy", action: () => this.copy(ref.short, "the branch name") },
        { separator: true },
        { label: `Delete ${ref.short} from ${ref.remote}`, icon: "trash", danger: true, action: () => this.deleteRemoteBranch(ref) },
      );
    } else {
      items.push(
        { label: `Check out ${ref.short}`, icon: "check", action: () => this.checkoutRef(ref.name) },
        { label: "Create branch here", icon: "branchPlus", action: () => this.createBranch(ref.oid) },
        { separator: true },
        { label: `Push ${ref.short} to remote`, icon: "push", action: () => this.pushTag(ref) },
        { label: "Copy tag name", icon: "copy", action: () => this.copy(ref.short, "the tag name") },
        { separator: true },
        { label: `Delete ${ref.short}`, icon: "trash", danger: true, action: () => this.deleteTag(ref) },
        { label: `Delete ${ref.short} from remote`, icon: "trash", danger: true, action: () => this.deleteRemoteTag(ref) },
      );
    }
    showMenu(items, at);
  }

  commitMenu(commit: GraphCommit, at: Point): void {
    if (commit.kind === "workInProgress") {
      const status = this.view.snapshot?.status;
      showMenu(
        [
          { label: "Stash all changes", icon: "stash", action: () => this.stash() },
          { label: "Stash with a message…", icon: "stash", action: () => this.stashWithMessage() },
          { separator: true },
          { label: "Stage all changes", icon: "plus", disabled: !status?.unstaged.length, action: () => this.stageAll() },
          { label: "Unstage all changes", icon: "minus", disabled: !status?.staged.length, action: () => this.unstageAll() },
          { separator: true },
          { label: "Discard all unstaged changes", icon: "trash", danger: true, disabled: !status?.unstaged.length, action: () => this.discardAll() },
        ],
        at,
      );
      return;
    }
    if (commit.kind === "stash" && commit.stash) {
      const stash = commit.stash;
      showMenu(
        [
          { label: "Apply stash", icon: "pop", action: () => this.applyStash(stash) },
          { label: "Pop stash", icon: "pop", action: () => this.pop(stash) },
          { separator: true },
          { label: "Delete stash", icon: "trash", danger: true, action: () => this.dropStash(stash) },
        ],
        at,
      );
      return;
    }
    const current = this.currentBranch();
    const isHead = commit.oid === this.view.snapshot?.head.oid;
    const items: MenuItem[] = [
      { label: "Create branch here", icon: "branchPlus", hint: "⌘B", action: () => this.createBranch(commit.oid) },
      { label: "Check out this commit", icon: "check", disabled: isHead, action: () => this.checkoutCommit(commit) },
      { separator: true },
      { label: "Cherry-pick commit", icon: "commit", disabled: isHead, action: () => this.cherryPick(commit) },
      { label: "Revert commit", icon: "undo", action: () => this.revert(commit) },
    ];
    if (current && !isHead) {
      items.push(
        { label: `Rebase ${current} onto this commit`, icon: "rebase", action: () => this.rebaseOnto(commit.oid, shortSha(commit.oid)) },
        { heading: `Reset ${current} to this commit` },
        { label: "Soft: keep changes staged", action: () => this.reset(commit, "soft") },
        { label: "Mixed: keep changes unstaged", action: () => this.reset(commit, "mixed") },
        { label: "Hard: discard all changes", danger: true, action: () => this.reset(commit, "hard") },
      );
    }
    items.push(
      { separator: true },
      { label: "Create tag here", icon: "tag", action: () => this.createTag(commit.oid, false) },
      { label: "Create annotated tag here", icon: "tag", action: () => this.createTag(commit.oid, true) },
      { separator: true },
      { label: "Copy commit SHA", icon: "copy", action: () => this.copy(commit.oid, "the commit SHA") },
      { label: "Copy commit message", icon: "copy", action: () => this.copy(commit.subject, "the message") },
    );
    showMenu(items, at);
  }
}
