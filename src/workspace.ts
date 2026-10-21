// Tabs: each is a repository or a new-tab page. The workspace is also the
// Shell repository views use for settings, the palette and preferences.
import { type AppData, type AppInfo, type RepoChanged, type Settings, api, errorMessage } from "./api";
import { form } from "./dialogs";
import { el } from "./dom";
import { icon } from "./icons";
import { type PaletteItem, openPalette } from "./palette";
import { type ShortcutId, shortcutLabel } from "./platform";
import { RepoView, type Shell } from "./repo/repo-view";
import { notify } from "./toast";
import { type RepoOpener, WelcomeView, browseForRepo, cloneRepoFlow, initRepoFlow } from "./welcome";

type Tab = { key: number; kind: "welcome"; view: WelcomeView } | { key: number; kind: "repo"; view: RepoView };

export class Workspace implements Shell {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private closed: string[] = [];
  private nextKey = 1;
  private readonly tabStrip: HTMLElement;
  private readonly bodies: HTMLElement;

  constructor(
    private data: AppData,
    readonly info: AppInfo,
  ) {
    this.tabStrip = document.querySelector<HTMLElement>("#tabs")!;
    this.bodies = document.querySelector<HTMLElement>("#tab-bodies")!;
    document.querySelector("#new-tab")!.addEventListener("click", () => this.newTab());
  }

  async restore(): Promise<void> {
    const paths = this.data.tabs;
    const active = this.data.activeTab;
    for (const path of paths) {
      await this.openRepo(path, { quiet: true, activate: false });
    }
    const target = this.tabs.find((t) => t.kind === "repo" && t.view.info.root === active) ?? this.tabs[0];
    if (target) this.activate(target);
    else this.newTab();
  }

  settings(): Settings {
    return this.data.settings;
  }

  async saveSettings(settings: Settings): Promise<void> {
    const changed = JSON.stringify(settings) !== JSON.stringify(this.data.settings);
    this.data = await api.saveSettings(settings);
    if (!changed) return;
    for (const tab of this.tabs) if (tab.kind === "repo") tab.view.settingsChanged();
  }

  activeRepo(): RepoView | null {
    return this.active?.kind === "repo" ? this.active.view : null;
  }

  newTab(): void {
    const view = new WelcomeView({
      info: this.info,
      recent: () => this.data.recent,
      openRepo: (path) => this.openRepo(path),
      setFavorite: async (path, favorite) => {
        this.data = await api.setFavorite(path, favorite);
      },
      forget: async (path) => {
        this.data = await api.forgetRecent(path);
      },
    });
    const tab: Tab = { key: this.nextKey++, kind: "welcome", view };
    this.tabs.push(tab);
    this.bodies.append(view.root);
    this.activate(tab);
  }

  /** Opens a repository in a tab, reusing its tab when it is already open. */
  async openRepo(path: string, options: { quiet?: boolean; activate?: boolean } = {}): Promise<void> {
    const existing = this.tabs.find((t) => t.kind === "repo" && (t.view.info.root === path || t.view.info.id === path));
    if (existing) {
      this.activate(existing);
      return;
    }
    let info;
    try {
      info = await api.openRepo(path);
    } catch (error) {
      if (!options.quiet) notify.error("Couldn't open the repository", errorMessage(error));
      return;
    }
    const again = this.tabs.find((t) => t.kind === "repo" && t.view.info.id === info.id);
    if (again) {
      this.activate(again);
      return;
    }
    this.data = await api.loadAppData();
    const view = new RepoView(info, this);
    const tab: Tab = { key: this.nextKey++, kind: "repo", view };
    // A repository opened from a new-tab page takes that tab's place.
    const replacing = this.active?.kind === "welcome" && options.activate !== false ? this.active : null;
    if (replacing) {
      const index = this.tabs.indexOf(replacing);
      this.tabs.splice(index, 1, tab);
      replacing.view.root.remove();
    } else {
      this.tabs.push(tab);
    }
    this.bodies.append(view.root);
    view.setVisible(false);
    if (options.activate !== false) this.activate(tab);
    await view.refresh();
    this.save();
  }

  private activate(tab: Tab): void {
    this.active = tab;
    for (const t of this.tabs) {
      if (t.kind === "repo") t.view.setVisible(t === tab);
      else t.view.root.hidden = t !== tab;
    }
    if (tab.kind === "welcome") tab.view.render();
    if (tab.kind === "repo") tab.view.graphView.focus();
    this.renderTabs();
    this.save();
  }

  closeTab(tab: Tab | null = this.active): void {
    if (!tab) return;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    if (tab.kind === "repo") {
      this.closed.push(tab.view.info.root);
      void api.closeRepo(tab.view.id);
      tab.view.dispose();
    } else {
      tab.view.root.remove();
    }
    if (this.active === tab) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) this.activate(next);
      else this.newTab();
    } else {
      this.renderTabs();
      this.save();
    }
  }

  reopenClosed(): void {
    const path = this.closed.pop();
    if (path) void this.openRepo(path);
  }

  cycle(step: 1 | -1): void {
    if (!this.active || this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  selectTab(index: number): void {
    const tab = index === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[index - 1];
    if (tab) this.activate(tab);
  }

  repoChanged(change: RepoChanged): void {
    for (const tab of this.tabs) {
      if (tab.kind === "repo" && tab.view.id === change.id && !tab.view.isBusy()) {
        void tab.view.refresh({ graph: change.refs });
      }
    }
  }

  private save(): void {
    const tabs = this.tabs.filter((t) => t.kind === "repo").map((t) => (t as { view: RepoView }).view.info.root);
    const active = this.active?.kind === "repo" ? this.active.view.info.root : null;
    if (JSON.stringify(tabs) === JSON.stringify(this.data.tabs) && active === this.data.activeTab) return;
    api.saveTabs(tabs, active).then(
      (data) => (this.data = data),
      () => undefined,
    );
  }

  private renderTabs(): void {
    this.tabStrip.replaceChildren();
    for (const tab of this.tabs) {
      const name = tab.kind === "repo" ? tab.view.info.name : "New tab";
      const close = el("button", "tab-close", icon("close", 12));
      close.type = "button";
      close.title = `Close (${shortcutLabel("closeTab")})`;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeTab(tab);
      });
      const node = el("div", `tab${tab === this.active ? " active" : ""}`, icon(tab.kind === "repo" ? "repo" : "plus", 14), el("span", "tab-name", name), close);
      node.title = tab.kind === "repo" ? tab.view.info.root : "New tab";
      node.setAttribute("role", "tab");
      node.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          this.closeTab(tab);
        }
      });
      node.addEventListener("click", () => this.activate(tab));
      this.tabStrip.append(node);
    }
  }

  // Palette and preferences

  openPalette(): void {
    const items: PaletteItem[] = [];
    const repo = this.activeRepo();
    const command = (id: ShortcutId | null, label: string, iconName: PaletteItem["icon"], action: () => void, group = "Commands") =>
      items.push({ label, icon: iconName, hint: id ? shortcutLabel(id) : undefined, group, action });

    if (repo) {
      const a = repo.actions;
      command("fetch", "Fetch all remotes", "refresh", () => a.fetch());
      command("pull", "Pull", "pull", () => a.pull("merge"));
      command(null, "Pull (fast-forward only)", "pull", () => a.pull("fastForwardOnly"));
      command(null, "Pull (rebase)", "pull", () => a.pull("rebase"));
      command("push", "Push", "push", () => a.push());
      command("createBranch", "Create branch", "branchPlus", () => a.createBranch());
      command("stash", "Stash changes", "stash", () => a.stash());
      command(null, "Stash changes with a message", "stash", () => a.stashWithMessage());
      command("pop", "Pop stash", "pop", () => a.pop());
      command("stageAll", "Stage all changes", "plus", () => a.stageAll());
      command("unstageAll", "Unstage all changes", "minus", () => a.unstageAll());
      command(null, "Discard all unstaged changes", "trash", () => a.discardAll());
      command("search", "Find commits", "search", () => repo.graphView.openSearch());
      command(null, "Add a remote", "cloud", () => a.addRemote());
      command(null, "Open in Terminal", "terminal", () => void api.openTerminal(repo.info.root));
      command(null, "Show in file manager", "folderOpen", () => void api.reveal(repo.info.root));
      for (const ref of repo.snapshot?.refs ?? []) {
        if (ref.kind === "tag" || ref.isHead) continue;
        items.push({
          label: ref.short,
          detail: ref.kind === "remote" ? "remote branch" : "branch",
          icon: ref.kind === "remote" ? "cloud" : "branch",
          group: "Check out",
          action: () => repo.actions.checkoutRef(ref.name),
        });
      }
    }
    command("openRepo", "Open a repository", "folderOpen", () => this.browse(), "App");
    command(null, "Clone a repository", "clone", () => this.clone(), "App");
    command(null, "Start a new repository", "folderPlus", () => this.init(), "App");
    command("newTab", "New tab", "plus", () => this.newTab(), "App");
    command("settings", "Preferences", "settings", () => this.openPreferences(), "App");
    for (const recent of this.data.recent) {
      items.push({ label: recent.name, detail: recent.path, icon: "repo", group: "Open recent", action: () => void this.openRepo(recent.path) });
    }
    openPalette(items);
  }

  /**
   * Open, clone and create work from any tab: the repository gets a tab of
   * its own, as with + and then picking it. A new-tab page in front is
   * reused, and cancelling leaves the tabs alone.
   */
  browse(): void {
    void browseForRepo(this.opener());
  }

  openRepoPicker(): void {
    this.browse();
  }

  clone(): void {
    void cloneRepoFlow(this.opener());
  }

  init(): void {
    void initRepoFlow(this.opener());
  }

  private opener(): RepoOpener {
    return { info: this.info, openRepo: (path) => this.openRepo(path) };
  }

  async openPreferences(): Promise<void> {
    const s = this.settings();
    const result = await form({
      title: "Preferences",
      fields: [
        { name: "commitLimit", label: "Commits to load in the graph", type: "text", value: String(s.commitLimit), mono: true },
        {
          name: "autoFetchMinutes",
          label: "Fetch automatically every",
          type: "select",
          value: String(s.autoFetchMinutes),
          options: [
            { value: "0", label: "Never" },
            { value: "1", label: "1 minute" },
            { value: "5", label: "5 minutes" },
            { value: "15", label: "15 minutes" },
            { value: "30", label: "30 minutes" },
          ],
        },
        {
          name: "diffContext",
          label: "Context lines around changes",
          type: "select",
          value: String(s.diffContext),
          options: ["0", "1", "3", "5", "10", "25"].map((v) => ({ value: v, label: v })),
        },
        {
          name: "dateFormat",
          label: "Commit dates",
          type: "select",
          value: s.dateFormat,
          options: [
            { value: "relative", label: "Relative (2 hours ago)" },
            { value: "absolute", label: "Absolute (Oct 20, 2026, 9:41 PM)" },
          ],
        },
        { name: "showAvatars", label: "Show author initials in the graph", type: "checkbox", value: s.showAvatars },
      ],
      confirmLabel: "Save",
      validate: (v) => {
        const n = Number(v.commitLimit);
        return Number.isInteger(n) && n >= 50 && n <= 100_000 ? null : "Load between 50 and 100,000 commits.";
      },
    });
    if (!result) return;
    await this.saveSettings({
      ...s,
      commitLimit: Number(result.commitLimit),
      autoFetchMinutes: Number(result.autoFetchMinutes),
      diffContext: Number(result.diffContext),
      dateFormat: result.dateFormat === "absolute" ? "absolute" : "relative",
      showAvatars: Boolean(result.showAvatars),
    });
  }
}
