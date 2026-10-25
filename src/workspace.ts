// Tabs: each is a repository or a new-tab page. The workspace is also the
// Shell repository views use for settings, the palette and preferences.
import { AccountControls, type AccountHost } from "./account";
import { type AppData, type AppInfo, type RepoChanged, type Settings, api, errorMessage } from "./api";
import { form } from "./dialogs";
import { el } from "./dom";
import { icon } from "./icons";
import { type PaletteItem, openPalette } from "./palette";
import { THEMES, applyTheme, applyZoom, isTheme, stepZoom } from "./appearance";
import { infoDialog } from "./dialogs";
import { SHORTCUTS, type ShortcutId, comboLabel, isMac, shortcutLabel } from "./platform";
import { RepoView, type Shell } from "./repo/repo-view";
import { notify } from "./toast";
import { type RepoOpener, WelcomeView, browseForRepo, cloneRepoFlow, initRepoFlow } from "./welcome";

type Tab = { key: number; kind: "welcome"; view: WelcomeView } | { key: number; kind: "repo"; view: RepoView };

export class Workspace implements Shell, AccountHost {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private closed: string[] = [];
  private nextKey = 1;
  private readonly tabStrip: HTMLElement;
  private readonly bodies: HTMLElement;
  private readonly account: AccountControls;

  constructor(
    private data: AppData,
    readonly info: AppInfo,
  ) {
    this.tabStrip = document.querySelector<HTMLElement>("#tabs")!;
    this.bodies = document.querySelector<HTMLElement>("#tab-bodies")!;
    document.querySelector("#new-tab")!.addEventListener("click", () => this.newTab());
    this.account = new AccountControls(this);
    document.querySelector(".titlebar")!.append(this.account.root);
    void this.account.load();
  }

  identityChanged(): void {
    void this.account.load();
    for (const tab of this.tabs) if (tab.kind === "repo") tab.view.detail.identityChanged();
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
    this.applyAppearance();
    for (const tab of this.tabs) if (tab.kind === "repo") tab.view.settingsChanged();
  }

  /** Theme and zoom from Settings; repaints the repositories now and when the system theme flips. */
  applyAppearance(): void {
    const repaint = () => {
      for (const tab of this.tabs) if (tab.kind === "repo") tab.view.themeChanged();
    };
    applyTheme(this.data.settings.theme, () => {
      repaint();
      this.account.themeChanged();
    });
    repaint();
    this.account.themeChanged();
    applyZoom(this.data.settings.zoom || 1);
  }

  zoom(direction: 1 | -1 | 0): void {
    const current = this.data.settings.zoom || 1;
    const zoom = direction === 0 ? 1 : stepZoom(current, direction);
    void this.saveSettings({ ...this.data.settings, zoom });
  }

  showShortcuts(): void {
    const list = el("dl", "shortcut-sheet");
    const seen = new Set<string>();
    for (const [id, shortcut] of Object.entries(SHORTCUTS) as [ShortcutId, (typeof SHORTCUTS)[ShortcutId]][]) {
      if (seen.has(shortcut.label)) continue;
      seen.add(shortcut.label);
      list.append(el("dt", "", shortcut.label), el("dd", "", el("kbd", "", shortcutLabel(id))));
    }
    const extras: [string, string][] = [
      ["Next / previous commit", "↓ ↑  or  J K"],
      ["Stage / unstage the selected files", "S  U"],
      ["Next / previous file in the changes list, after opening one there", "↓ ↑"],
      ["Select several commits or files", `${isMac ? "⌘" : "Ctrl"}-click, ⇧-click`],
      ["Interactive rebase: pick, reword, squash, fixup, drop", "P R S F D"],
      ["Interactive rebase: move a commit", "⌥↑  ⌥↓"],
      ["Merge tool: save and mark resolved", isMac ? "⌘S" : "Ctrl+S"],
      ["Diff: go to the definition / references of the clicked name", `${comboLabel("f12")}  ${comboLabel("shift+f12")}`],
      ["Diff: peek the definition / references", `${comboLabel("alt+f12")}  ${comboLabel("alt+shift+f12")}`],
      ["Close a diff, panel or dialog", "Esc"],
      ["Switch to tab 1–9", isMac ? "⌘1 … ⌘9" : "Ctrl+1 … Ctrl+9"],
    ];
    for (const [label, keys] of extras) list.append(el("dt", "", label), el("dd", "", el("kbd", "", keys)));
    void infoDialog("Keyboard shortcuts", list);
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
      addRecent: async (paths) => {
        this.data = await api.addRecent(paths);
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
      node.addEventListener("pointerdown", (event) => this.dragTab(event, tab, node));
      this.tabStrip.append(node);
    }
  }

  /** Drag a tab sideways to reorder; it moves live as it passes the others. */
  private dragTab(down: PointerEvent, tab: Tab, node: HTMLElement): void {
    if (down.button !== 0 || (down.target as Element).closest(".tab-close")) return;
    const startX = down.clientX;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - startX) < 5) return;
      if (!dragging) {
        dragging = true;
        node.setPointerCapture(e.pointerId);
        document.body.classList.add("dragging");
      }
      const others = [...this.tabStrip.children] as HTMLElement[];
      const over = others.findIndex((other) => {
        const r = other.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX < r.right;
      });
      const from = this.tabs.indexOf(tab);
      if (over >= 0 && over !== from) {
        this.tabs.splice(from, 1);
        this.tabs.splice(over, 0, tab);
        // Reorder the existing elements so the pointer capture stays put.
        const nodes = [...this.tabStrip.children];
        const moving = nodes[from];
        this.tabStrip.insertBefore(moving, over > from ? nodes[over].nextSibling : nodes[over]);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      document.body.classList.remove("dragging");
      // Don't let the release activate a tab, then save the new order.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      this.renderTabs();
      this.save();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Palette and preferences

  openPalette(): void {
    const items: PaletteItem[] = [];
    const repo = this.activeRepo();
    const command = (id: ShortcutId | null, label: string, iconName: PaletteItem["icon"], action: () => void, group = "Commands") =>
      items.push({ label, icon: iconName, hint: id ? shortcutLabel(id) : undefined, group, action });

    if (repo) {
      const a = repo.actions;
      command("undo", repo.snapshot?.undo.undo ? `Undo ${repo.snapshot.undo.undo.toLowerCase()}` : "Undo", "undo", () => a.undo());
      command("redo", repo.snapshot?.undo.redo ? `Redo ${repo.snapshot.undo.redo.toLowerCase()}` : "Redo", "redo", () => a.redo());
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
      command("fileHistory", "File history…", "tree", () => void this.openFileFinder(repo));
      command(null, "Add a remote", "cloud", () => a.addRemote());
      command(null, "Apply a patch", "file", () => a.applyPatch());
      command(null, "Index history (git commit-graph) to speed up the graph", "speed", () => void a.indexHistory());
      command(null, "Save uncommitted changes as a patch", "file", () => a.savePatch([]));
      command("toggleTerminal", "Toggle the terminal", "terminal", () => repo.terminal.toggle());
      command(null, "Open in the system terminal", "terminal", () => void api.openTerminal(repo.info.root));
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
    command("shortcuts", "Keyboard shortcuts", "settings", () => this.showShortcuts(), "App");
    command("zoomIn", "Zoom in", "plus", () => this.zoom(1), "App");
    command("zoomOut", "Zoom out", "minus", () => this.zoom(-1), "App");
    command("zoomReset", "Actual size", "search", () => this.zoom(0), "App");
    for (const theme of THEMES) {
      const current = this.data.settings.theme === theme.value;
      command(null, `Theme: ${theme.label}${current ? " (current)" : ""}`, "theme", () => void this.saveSettings({ ...this.data.settings, theme: theme.value }), "App");
    }
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
  /** Picks a tracked file, then shows its history. */
  async openFileFinder(repo: RepoView): Promise<void> {
    let files: string[];
    try {
      files = await api.trackedFiles(repo.id);
    } catch (error) {
      notify.error("Couldn't list the files", errorMessage(error));
      return;
    }
    openPalette(
      files.map((path) => {
        const slash = path.lastIndexOf("/");
        return {
          label: path.slice(slash + 1),
          detail: slash >= 0 ? path.slice(0, slash) : "",
          icon: "file",
          group: "Files",
          action: () => void repo.history.open(path),
        };
      }),
      "File history: type a file name",
    );
  }

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
          name: "theme",
          label: "Theme",
          type: "select",
          value: s.theme,
          options: THEMES,
        },
        { name: "editor", label: "Editor command", type: "text", value: s.editor, placeholder: "The system's default app", mono: true, hint: "Opens files and the repository, for example code, cursor, zed or subl." },
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
      theme: isTheme(result.theme) ? result.theme : "dracula",
      editor: String(result.editor).trim(),
      showAvatars: Boolean(result.showAvatars),
    });
  }
}
