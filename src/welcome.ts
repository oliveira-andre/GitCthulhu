// A new tab: open, clone or create a repository, or pick a recent one.
import { open } from "@tauri-apps/plugin-dialog";
import { type AppInfo, type RecentRepo, api, errorMessage } from "./api";
import { brandMark } from "./brand";
import { form } from "./dialogs";
import { el } from "./dom";
import { relativeTime } from "./format";
import { type IconName, icon, iconButton } from "./icons";
import { shortcutLabel } from "./platform";
import { toast } from "./toast";

/** Where a new or picked repository goes: a tab, opened by the workspace. */
export interface RepoOpener {
  info: AppInfo;
  openRepo(path: string): Promise<void>;
}

export interface WelcomeHost extends RepoOpener {
  recent(): RecentRepo[];
  setFavorite(path: string, favorite: boolean): Promise<void>;
  forget(path: string): Promise<void>;
}

export class WelcomeView {
  readonly root: HTMLElement;
  private readonly recentList: HTMLElement;

  constructor(private readonly host: WelcomeHost) {
    const card = (name: IconName, title: string, text: string, action: () => void) => {
      const b = el("button", "welcome-card", icon(name, 22), el("span", "welcome-card-title", title), el("span", "welcome-card-text", text));
      b.type = "button";
      b.addEventListener("click", action);
      return b;
    };
    const gitLine = host.info.gitVersion
      ? el("p", "welcome-git mono", host.info.gitVersion)
      : el("p", "welcome-git error", host.info.gitError ?? "Git wasn't found.");
    this.recentList = el("div", "recent-list");
    this.root = el(
      "section",
      "welcome",
      el(
        "div",
        "welcome-inner",
        el("div", "welcome-brand", brandMark(72), el("div", "", el("h1", "", "GitCthulhu"), el("p", "welcome-tagline", "Tentacles in every branch."))),
        el(
          "div",
          "welcome-cards",
          card("folderOpen", "Open a repository", `Browse to a folder (${shortcutLabel("openRepo")})`, () => void this.browse()),
          card("clone", "Clone a repository", "From a URL or a path", () => void this.clone()),
          card("folderPlus", "Start a new repository", "git init in a folder", () => void this.init()),
        ),
        el("h2", "welcome-heading", "Recent repositories"),
        this.recentList,
        gitLine,
      ),
    );
    this.render();
  }

  render(): void {
    const recent = [...this.host.recent()].sort((a, b) => Number(b.favorite) - Number(a.favorite));
    this.recentList.replaceChildren();
    if (!recent.length) {
      this.recentList.append(el("p", "recent-empty", "Repositories you open show up here."));
      return;
    }
    for (const repo of recent) {
      const star = iconButton("star", repo.favorite ? "Unfavorite" : "Favorite", (event) => {
        event.stopPropagation();
        void this.host.setFavorite(repo.path, !repo.favorite).then(() => this.render());
      }, `icon-button small star${repo.favorite ? " on" : ""}`);
      const forget = iconButton("close", "Remove from the list", (event) => {
        event.stopPropagation();
        void this.host.forget(repo.path).then(() => this.render());
      }, "icon-button small");
      const row = el(
        "div",
        "recent-row",
        icon("repo", 16),
        el("span", "recent-text", el("span", "recent-name", repo.name), el("span", "recent-path mono", repo.path)),
        el("span", "recent-when", relativeTime(repo.openedAt)),
        star,
        forget,
      );
      row.tabIndex = 0;
      row.addEventListener("click", () => void this.host.openRepo(repo.path));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.host.openRepo(repo.path);
      });
      this.recentList.append(row);
    }
  }

  browse(): Promise<void> {
    return browseForRepo(this.host);
  }

  clone(): Promise<void> {
    return cloneRepoFlow(this.host);
  }

  init(): Promise<void> {
    return initRepoFlow(this.host);
  }
}

/** Picks a folder and opens it, like the File menu's Open Repository. */
export async function browseForRepo(host: RepoOpener): Promise<void> {
  const path = await open({ directory: true, title: "Open a repository" });
  if (typeof path === "string") await host.openRepo(path);
}

export async function cloneRepoFlow(host: RepoOpener): Promise<void> {
  const home = host.info.home ?? "";
  let parent = home;
  const result = await form({
    title: "Clone a repository",
    fields: [
      { name: "url", label: "Repository URL", type: "text", placeholder: "https://github.com/owner/repo.git", mono: true },
      { name: "parent", label: "Clone into this folder", type: "text", value: parent, mono: true, hint: "A new folder named after the repository is made inside it." },
      { name: "name", label: "Folder name", type: "text", placeholder: "Taken from the URL", mono: true },
    ],
    confirmLabel: "Clone",
    extra: [{ label: "Browse…", value: "browse" }],
    validate: (v) => (!String(v.url).trim() ? "Enter the repository's URL." : !String(v.parent).trim() ? "Choose where to put it." : null),
  });
  if (!result) return;
  if (result.button === "browse") {
    const picked = await open({ directory: true, title: "Clone into" });
    if (typeof picked === "string") parent = picked;
    // Ask again with the chosen folder.
    return cloneWith(host, String(result.url), parent, String(result.name));
  }
  await runClone(host, String(result.url), String(result.parent), String(result.name));
}

async function cloneWith(host: RepoOpener, url: string, parent: string, name: string): Promise<void> {
  const result = await form({
    title: "Clone a repository",
    fields: [
      { name: "url", label: "Repository URL", type: "text", value: url, mono: true },
      { name: "parent", label: "Clone into this folder", type: "text", value: parent, mono: true },
      { name: "name", label: "Folder name", type: "text", value: name, placeholder: "Taken from the URL", mono: true },
    ],
    confirmLabel: "Clone",
    validate: (v) => (!String(v.url).trim() ? "Enter the repository's URL." : null),
  });
  if (result) await runClone(host, String(result.url), String(result.parent), String(result.name));
}

async function runClone(host: RepoOpener, url: string, parent: string, name: string): Promise<void> {
  const folder = name.trim() || repoNameFromUrl(url);
  const dest = `${parent.replace(/[\\/]+$/, "")}/${folder}`;
  const notice = toast("progress", `Cloning ${folder}`);
  try {
    const repo = await api.cloneRepo(url.trim(), dest, (line) => notice.update(line));
    notice.done("success", `Cloned ${repo.name}`);
    await host.openRepo(repo.root);
  } catch (error) {
    notice.done("error", "Clone failed", errorMessage(error));
  }
}

export async function initRepoFlow(host: RepoOpener): Promise<void> {
  const picked = await open({ directory: true, title: "Create the repository in" });
  if (typeof picked !== "string") return;
  const result = await form({
    title: "Start a new repository",
    message: picked,
    fields: [{ name: "branch", label: "Initial branch", type: "text", value: "main", mono: true }],
    confirmLabel: "Create",
  });
  if (!result) return;
  try {
    const repo = await api.initRepo(picked, String(result.branch).trim() || null);
    await host.openRepo(repo.root);
  } catch (error) {
    toast("error", "Couldn't create the repository", errorMessage(error));
  }
}

export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "repository";
  return last.replace(/\.git$/, "") || "repository";
}
