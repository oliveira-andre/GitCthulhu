// Actions for the left panel's submodule, worktree, LFS and Gitflow sections.
import { type FlowKind, type Worktree, api } from "../api";
import { confirmAction, form, promptText, refNameProblem } from "../dialogs";
import { notify } from "../toast";
import type { RepoView } from "./repo-view";

const KIND_NAMES: Record<FlowKind, string> = { feature: "feature", release: "release", hotfix: "hotfix" };

function join(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

export class ExtrasActions {
  constructor(private readonly view: RepoView) {}

  private get id(): string {
    return this.view.id;
  }

  // Submodules

  async addSubmodule(): Promise<void> {
    const result = await form({
      title: "Add a submodule",
      fields: [
        { name: "url", label: "Repository URL", type: "text", placeholder: "https://github.com/owner/lib.git", mono: true },
        { name: "path", label: "Folder in this repository", type: "text", placeholder: "vendor/lib", mono: true },
      ],
      confirmLabel: "Add submodule",
      validate: (v) => (!String(v.url).trim() ? "Enter the repository's URL." : !String(v.path).trim() ? "Choose a folder for it." : null),
    });
    if (!result) return;
    const path = String(result.path).trim();
    await this.view.attempt("Add submodule", (p) => api.submoduleAdd(this.id, String(result.url).trim(), path, p), {
      progress: true,
      success: `Added ${path}. Commit to record it.`,
    });
  }

  async updateSubmodule(path: string | null): Promise<void> {
    await this.view.attempt(path ? `Update ${path}` : "Update submodules", (p) => api.submoduleUpdate(this.id, path, p), {
      progress: true,
      success: path ? `${path} is up to date` : "Submodules are up to date",
    });
  }

  openSubmodule(path: string): void {
    void this.view.shell.openRepo(join(this.view.info.root, path));
  }

  // Worktrees

  async addWorktree(): Promise<void> {
    const parent = this.view.info.root.replace(/[\\/][^\\/]+[\\/]?$/, "");
    const result = await form({
      title: "Add a worktree",
      message: "A second checkout of this repository in its own folder, for working on another branch at the same time.",
      fields: [
        { name: "branch", label: "Branch", type: "text", placeholder: "feature/my-change", mono: true },
        { name: "create", label: "Create it as a new branch from the current commit", type: "checkbox", value: true },
        { name: "path", label: "Folder", type: "text", value: "", placeholder: `${parent}/${this.view.info.name}-<branch>`, mono: true },
      ],
      confirmLabel: "Add worktree",
      validate: (v) => refNameProblem(String(v.branch)),
    });
    if (!result) return;
    const branch = String(result.branch).trim();
    const path = String(result.path).trim() || `${parent}/${this.view.info.name}-${branch.replace(/[\\/]/g, "-")}`;
    const done = await this.view.attempt("Add worktree", async () => {
      await api.worktreeAdd(this.id, path, branch, Boolean(result.create), null);
      return true;
    });
    if (done) {
      const open = await confirmAction({ title: "Worktree added", message: `${branch} is checked out in ${path}. Open it in a new tab?`, confirmLabel: "Open" });
      if (open) void this.view.shell.openRepo(path);
    }
  }

  openWorktree(tree: Worktree): void {
    void this.view.shell.openRepo(tree.path);
  }

  async removeWorktree(tree: Worktree): Promise<void> {
    const ok = await confirmAction({
      title: `Remove the worktree at ${tree.path}?`,
      message: "Its folder is deleted. The branch and its commits stay in the repository.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await this.view.run("Remove worktree", () => api.worktreeRemove(this.id, tree.path, false), { success: "Worktree removed" });
    } catch {
      const force = await confirmAction({
        title: "It has uncommitted changes",
        message: "Removing it anyway throws those changes away.",
        confirmLabel: "Remove anyway",
        danger: true,
      });
      if (force) await this.view.attempt("Remove worktree", () => api.worktreeRemove(this.id, tree.path, true), { success: "Worktree removed" });
    }
  }

  async pruneWorktrees(): Promise<void> {
    await this.view.attempt("Prune worktrees", () => api.worktreePrune(this.id), { success: "Forgot worktrees whose folders are gone" });
  }

  // LFS

  async lfsTrack(): Promise<void> {
    const pattern = await promptText({
      title: "Store files in Git LFS",
      message: "Files matching this pattern are stored in LFS from now on. The pattern goes in .gitattributes, which you then commit.",
      label: "Pattern",
      placeholder: "*.psd",
      confirmLabel: "Track",
      validate: (v) => (v.trim() ? null : "Enter a pattern."),
    });
    if (pattern) await this.view.attempt("Track", () => api.lfsTrack(this.id, pattern.trim()), { success: `Tracking ${pattern.trim()} in LFS` });
  }

  async lfsUntrack(pattern: string): Promise<void> {
    await this.view.attempt("Untrack", () => api.lfsUntrack(this.id, pattern), { success: `${pattern} is no longer stored in LFS` });
  }

  async lfsPull(): Promise<void> {
    await this.view.attempt("Download LFS files", (p) => api.lfsPull(this.id, p), { progress: true, success: "LFS files are downloaded" });
  }

  async lfsPrune(): Promise<void> {
    await this.view.attempt("Prune LFS", (p) => api.lfsPrune(this.id, p), { progress: true, success: "Old LFS copies removed" });
  }

  async lfsInstall(): Promise<void> {
    await this.view.attempt("Set up LFS", () => api.lfsInstall(this.id), { success: "LFS hooks are installed in this repository" });
  }

  // Gitflow

  async gitflowInit(): Promise<void> {
    const locals = (this.view.snapshot?.refs ?? []).filter((r) => r.kind === "local").map((r) => r.short);
    const production = ["main", "master"].find((b) => locals.includes(b)) ?? locals[0] ?? "main";
    const result = await form({
      title: "Set up Gitflow",
      message: "Features branch from develop; releases and hotfixes are merged into production and tagged.",
      fields: [
        { name: "production", label: "Production branch", type: "text", value: production, mono: true },
        { name: "develop", label: "Development branch", type: "text", value: "develop", mono: true, hint: "Created from production if it doesn't exist." },
        { name: "feature", label: "Feature prefix", type: "text", value: "feature/", mono: true },
        { name: "release", label: "Release prefix", type: "text", value: "release/", mono: true },
        { name: "hotfix", label: "Hotfix prefix", type: "text", value: "hotfix/", mono: true },
        { name: "versionTag", label: "Version tag prefix", type: "text", value: "v", mono: true },
      ],
      confirmLabel: "Set up",
      validate: (v) => refNameProblem(String(v.production)) ?? refNameProblem(String(v.develop)),
    });
    if (!result) return;
    const config = {
      production: String(result.production).trim(),
      develop: String(result.develop).trim(),
      feature: String(result.feature).trim(),
      release: String(result.release).trim(),
      hotfix: String(result.hotfix).trim(),
      versionTag: String(result.versionTag).trim(),
    };
    await this.view.attempt("Set up Gitflow", () => api.gitflowInit(this.id, config), { success: "Gitflow is set up" });
  }

  async gitflowStart(kind: FlowKind): Promise<void> {
    const name = await promptText({
      title: `Start a ${KIND_NAMES[kind]}`,
      message: kind === "feature" ? "Branches from the development branch." : kind === "release" ? "Branches from the development branch; finishing it tags the release." : "Branches from production; finishing it tags the fix.",
      label: kind === "feature" ? "Feature name" : "Version",
      placeholder: kind === "feature" ? "login-form" : "1.2.0",
      confirmLabel: "Start",
      validate: (v) => (!v.trim() ? "Enter a name." : /\s/.test(v.trim()) ? "Names can't contain spaces." : null),
    });
    if (!name) return;
    await this.view.attempt(`Start ${KIND_NAMES[kind]}`, () => api.gitflowStart(this.id, kind, name.trim()), { success: `Started ${KIND_NAMES[kind]} ${name.trim()}` });
  }

  async gitflowFinish(kind: FlowKind, name: string): Promise<void> {
    const flow = this.view.extras?.gitflow;
    if (!flow) return;
    const tagged = kind !== "feature";
    const result = await form({
      title: `Finish ${KIND_NAMES[kind]} ${name}`,
      message: tagged
        ? `Merges it into ${flow.production}, tags it ${flow.versionTag}${name}, merges it into ${flow.develop}, and deletes the branch.`
        : `Merges it into ${flow.develop} and deletes the branch.`,
      fields: tagged ? [{ name: "message", label: "Tag message", type: "text", value: `${KIND_NAMES[kind] === "release" ? "Release" : "Hotfix"} ${name}` }] : [],
      confirmLabel: "Finish",
    });
    if (!result) return;
    await this.view.attempt(`Finish ${KIND_NAMES[kind]}`, () => api.gitflowFinish(this.id, kind, name, tagged ? String(result.message) : null), {
      success: `Finished ${KIND_NAMES[kind]} ${name}`,
    });
  }

  notInstalled(): void {
    notify.info("Git LFS isn't installed", "Install it from git-lfs.com, then refresh.");
  }
}
