// The left panel: local branches, remotes, tags and stashes. Branch names
// with slashes are grouped into folders.
import { type Extras, type FlowKind, type Ref, api } from "../api";
import { brandMark } from "../brand";
import { el } from "../dom";
import { type IconName, icon, iconButton } from "../icons";
import { showMenu } from "../menu";
import { shortcutLabel } from "../platform";
import { startRefDrag } from "./ref-drag";
import type { RepoView } from "./repo-view";

type Section = "local" | "remote" | "tags" | "stashes" | "submodules" | "worktrees" | "lfs" | "gitflow";

interface TreeNode {
  name: string;
  path: string;
  ref?: Ref;
  children: Map<string, TreeNode>;
}

export class RefPanel {
  readonly root: HTMLElement;
  readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly collapsed = new Set<string>(["section:tags", "section:lfs"]);

  constructor(private readonly view: RepoView) {
    this.filter = el("input", "search");
    this.filter.type = "search";
    this.filter.placeholder = `Filter (${shortcutLabel("filterRefs")})`;
    this.filter.spellcheck = false;
    this.filter.addEventListener("input", () => this.render());
    this.filter.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.filter.value = "";
        this.render();
        view.graphView.focus();
      }
    });
    this.list = el("nav", "ref-list");
    const brand = el("div", "sidebar-brand", brandMark(26), el("span", "brand-name", "GitCthulhu"));
    this.root = el("aside", "ref-panel", brand, el("div", "ref-filter", this.filter), this.list);
  }

  focusFilter(): void {
    this.filter.focus();
    this.filter.select();
  }

  render(): void {
    const snapshot = this.view.snapshot;
    if (!snapshot) return;
    const query = this.filter.value.trim().toLowerCase();
    const matches = (name: string) => !query || name.toLowerCase().includes(query);
    const scroll = this.list.scrollTop;
    this.list.replaceChildren();

    const locals = snapshot.refs.filter((r) => r.kind === "local" && matches(r.short));
    this.section("local", "Local", "laptop", locals.length, () => this.tree(locals, "local", (r) => r.short), {
      label: "Create branch",
      action: () => this.view.actions.createBranch(),
    });

    const remotes = snapshot.remotes;
    const remoteRefs = snapshot.refs.filter((r) => r.kind === "remote" && matches(r.short));
    this.section(
      "remote",
      "Remote",
      "cloud",
      remoteRefs.length,
      () => {
        const nodes: HTMLElement[] = [];
        for (const remote of remotes) {
          const refs = remoteRefs.filter((r) => r.remote === remote);
          if (query && refs.length === 0) continue;
          const key = `remote:${remote}`;
          const open = !this.collapsed.has(key);
          const head = this.folderRow(remote, "cloud", open, 0, () => this.toggle(key));
          head.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            showMenu(
              [
                {
                  label: this.view.filter.hidden.includes(`refs/remotes/${remote}/*`) ? `Show ${remote}'s branches in the graph` : `Hide ${remote}'s branches in the graph`,
                  icon: "eyeOff",
                  action: () => {
                    const pattern = `refs/remotes/${remote}/*`;
                    this.view.setFilter((f) => (f.hidden = f.hidden.includes(pattern) ? f.hidden.filter((h) => h !== pattern) : [...f.hidden, pattern]));
                  },
                },
                { label: `Fetch ${remote}`, icon: "refresh", action: () => void this.view.attempt(`Fetch ${remote}`, (p) => api.fetch(this.view.id, remote, p), { progress: true, success: `Fetched ${remote}` }) },
                { label: `Edit ${remote}…`, icon: "settings", action: () => void this.view.actions.editRemote(remote) },
                { separator: true },
                { label: `Remove ${remote}`, icon: "trash", danger: true, action: () => this.view.actions.removeRemote(remote) },
              ],
              { x: event.clientX, y: event.clientY },
            );
          });
          nodes.push(head);
          if (open) nodes.push(...this.tree(refs, key, (r) => r.short.slice(remote.length + 1), 1));
        }
        return nodes;
      },
      { label: "Add remote", action: () => this.view.actions.addRemote() },
    );

    const tags = snapshot.refs.filter((r) => r.kind === "tag" && matches(r.short));
    this.section("tags", "Tags", "tag", tags.length, () => this.tree(tags, "tags", (r) => r.short));
    this.headerMenu("Tags", () => {
      const hidden = this.view.filter.hidden.includes("refs/tags/*");
      return [{ label: hidden ? "Show tags in the graph" : "Hide all tags in the graph", icon: hidden ? "eye" : "eyeOff", action: () => this.view.setFilter((f) => (f.hidden = hidden ? f.hidden.filter((h) => h !== "refs/tags/*") : [...f.hidden, "refs/tags/*"])) }];
    });

    this.headerMenu("Stashes", () => {
      const hidden = this.view.filter.hideStashes;
      return [{ label: hidden ? "Show stashes in the graph" : "Hide stashes in the graph", icon: hidden ? "eye" : "eyeOff", action: () => this.view.setFilter((f) => (f.hideStashes = !hidden)) }];
    }, true);
    const stashes = snapshot.stashes.filter((s) => matches(s.message));
    this.section("stashes", "Stashes", "stash", stashes.length, () =>
      stashes.map((stash) => {
        const row = this.row(stash.message, "stash", 0, stash.oid === this.view.selectedOid());
        row.title = `${stash.name}: ${stash.message}`;
        row.addEventListener("click", () => this.view.revealCommit(stash.oid));
        row.addEventListener("dblclick", () => this.view.actions.applyStash(stash.name));
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showMenu(
            [
              { label: "Apply stash", icon: "pop", action: () => this.view.actions.applyStash(stash.name) },
              { label: "Pop stash", icon: "pop", action: () => this.view.actions.pop(stash.name) },
              { label: "Rename stash…", icon: "fileModified", action: () => this.view.actions.renameStash(stash.name, stash.message) },
              { separator: true },
              { label: "Delete stash", icon: "trash", danger: true, action: () => this.view.actions.dropStash(stash.name) },
            ],
            { x: event.clientX, y: event.clientY },
          );
        });
        return row;
      }),
    );
    this.renderExtras(matches);
    this.list.scrollTop = scroll;
  }

  private renderExtras(matches: (name: string) => boolean): void {
    const extras = this.view.extras;
    if (!extras) return;
    const x = this.view.extrasActions;
    const menuAt = (event: MouseEvent, items: Parameters<typeof showMenu>[0]) => {
      event.preventDefault();
      showMenu(items, { x: event.clientX, y: event.clientY });
    };

    const submodules = extras.submodules.filter((s) => matches(s.path));
    if (extras.submodules.length) {
      this.section("submodules", "Submodules", "folder", submodules.length, () =>
        submodules.map((sub) => {
          const row = this.row(sub.path, "repo", 0, false);
          const labels = { current: "", changed: "changed", uninitialized: "not checked out", conflicted: "conflicted" };
          if (sub.state !== "current") row.append(el("span", `ref-gone state-${sub.state}`, labels[sub.state]));
          row.title = `${sub.path}${sub.url ? ` ← ${sub.url}` : ""}`;
          row.addEventListener("dblclick", () => (sub.state === "uninitialized" ? void x.updateSubmodule(sub.path) : x.openSubmodule(sub.path)));
          row.addEventListener("contextmenu", (e) =>
            menuAt(e, [
              { label: "Open in a new tab", icon: "folderOpen", disabled: sub.state === "uninitialized", action: () => x.openSubmodule(sub.path) },
              { label: sub.state === "uninitialized" ? "Check out" : "Update to the recorded commit", icon: "refresh", action: () => void x.updateSubmodule(sub.path) },
              { separator: true },
              { label: "Copy path", icon: "copy", action: () => this.view.actions.copy(sub.path, "the path") },
            ]),
          );
          return row;
        }),
        { label: "Add submodule", action: () => void x.addSubmodule() },
      );
    }

    const linked = extras.worktrees.filter((w) => matches(w.path) || matches(w.branch ?? ""));
    if (extras.worktrees.length > 1) {
      this.section("worktrees", "Worktrees", "tree", linked.length, () =>
        linked.map((tree) => {
          const name = tree.path.split(/[\/]/).filter(Boolean).pop() ?? tree.path;
          const row = this.row(tree.branch ? `${name} · ${tree.branch}` : `${name} · detached`, tree.current ? "check" : "folder", 0, false);
          row.classList.toggle("head", tree.current);
          if (tree.main) row.append(el("span", "ref-count", "main"));
          if (tree.prunable) row.append(el("span", "ref-gone", "missing"));
          row.title = tree.path;
          row.addEventListener("dblclick", () => !tree.current && x.openWorktree(tree));
          row.addEventListener("contextmenu", (e) =>
            menuAt(e, [
              { label: "Open in a new tab", icon: "folderOpen", disabled: tree.current || tree.prunable, action: () => x.openWorktree(tree) },
              { label: "Show in file manager", icon: "folder", disabled: tree.prunable, action: () => void api.reveal(tree.path) },
              { separator: true },
              { label: "Remove worktree", icon: "trash", danger: true, disabled: tree.main || tree.current, action: () => void x.removeWorktree(tree) },
              { label: "Prune missing worktrees", icon: "refresh", action: () => void x.pruneWorktrees() },
            ]),
          );
          return row;
        }),
        { label: "Add worktree", action: () => void x.addWorktree() },
      );
    } else {
      // Even with none yet, offer to make one from the section header area.
      this.section("worktrees", "Worktrees", "tree", 0, () => [], { label: "Add worktree", action: () => void x.addWorktree() });
    }

    if (extras.lfs.version) {
      const lfs = extras.lfs;
      const missing = lfs.files.filter((f) => !f.downloaded).length;
      this.section("lfs", "LFS", "file", lfs.patterns.length, () => {
        const rows = lfs.patterns.filter(matches).map((pattern) => {
          const row = this.row(pattern, "file", 0, false);
          row.addEventListener("contextmenu", (e) => menuAt(e, [{ label: `Stop storing ${pattern} in LFS`, icon: "minus", action: () => void x.lfsUntrack(pattern) }]));
          return row;
        });
        if (lfs.files.length) {
          const summary = this.row(`${lfs.files.length} file${lfs.files.length === 1 ? "" : "s"}${missing ? `, ${missing} not downloaded` : ""}`, "dot", 0, false);
          summary.classList.add("ref-summary");
          summary.addEventListener("click", () => missing && void x.lfsPull());
          rows.push(summary);
        }
        const actions = this.row("Download, prune or set up…", "more", 0, false);
        actions.classList.add("ref-summary");
        actions.addEventListener("click", (e) =>
          menuAt(e, [
            { label: "Download LFS files", icon: "pull", action: () => void x.lfsPull() },
            { label: "Prune old LFS copies", icon: "trash", action: () => void x.lfsPrune() },
            { separator: true },
            { label: "Install LFS hooks in this repository", icon: "settings", action: () => void x.lfsInstall() },
          ]),
        );
        rows.push(actions);
        return rows;
      }, { label: "Track a pattern", action: () => void x.lfsTrack() });
    }

    const flow = extras.gitflow;
    this.section("gitflow", "Gitflow", "merge", flow ? this.flowBranches(flow).length : 0, () => {
      if (!flow) {
        const setup = this.row("Set up Gitflow…", "plus", 0, false);
        setup.classList.add("ref-summary");
        setup.addEventListener("click", () => void x.gitflowInit());
        return [setup];
      }
      const rows: HTMLElement[] = [];
      const kinds: [FlowKind, string, string][] = [
        ["feature", "Features", flow.feature],
        ["release", "Releases", flow.release],
        ["hotfix", "Hotfixes", flow.hotfix],
      ];
      for (const [kind, title, prefix] of kinds) {
        const head = this.folderRow(title, "folder", true, 0, () => undefined);
        const start = iconButton("plus", `Start a ${kind}`, (event) => {
          event.stopPropagation();
          void x.gitflowStart(kind);
        }, "icon-button small");
        head.append(start);
        rows.push(head);
        for (const ref of this.flowBranches(flow).filter((r) => r.short.startsWith(prefix) && matches(r.short))) {
          const name = ref.short.slice(prefix.length);
          const row = this.refRow(ref, name, 1);
          row.addEventListener("contextmenu", (e) => {
            e.stopImmediatePropagation();
            menuAt(e, [
              { label: `Finish ${kind} ${name}`, icon: "merge", action: () => void x.gitflowFinish(kind, name) },
              { separator: true },
              { label: `Check out ${ref.short}`, icon: "check", disabled: ref.isHead, action: () => void this.view.actions.checkoutRef(ref.name) },
            ]);
          }, { capture: true });
          rows.push(row);
        }
      }
      return rows;
    });
  }

  private flowBranches(flow: NonNullable<Extras["gitflow"]>): Ref[] {
    const prefixes = [flow.feature, flow.release, flow.hotfix];
    return (this.view.snapshot?.refs ?? []).filter((r) => r.kind === "local" && prefixes.some((p) => r.short.startsWith(p)));
  }

  /** A right-click menu on the section header titled `title`; `deferred` waits for a section rendered next. */
  private headerMenu(title: string, items: () => Parameters<typeof showMenu>[0], deferred = false): void {
    const attach = () => {
      const header = [...this.list.querySelectorAll<HTMLElement>(".ref-section-header")].find((h) => h.querySelector(".ref-section-title")?.textContent === title);
      header?.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showMenu(items(), { x: event.clientX, y: event.clientY });
      });
    };
    if (deferred) queueMicrotask(attach);
    else attach();
  }

  private toggle(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.render();
  }

  private section(
    id: Section,
    title: string,
    iconName: IconName,
    count: number,
    body: () => HTMLElement[],
    add?: { label: string; action: () => void },
  ): void {
    const key = `section:${id}`;
    const filtering = Boolean(this.filter.value.trim());
    const open = filtering || !this.collapsed.has(key);
    const header = el(
      "div",
      "ref-section-header",
      icon(open ? "chevronDown" : "chevronRight", 12),
      icon(iconName, 14),
      el("span", "ref-section-title", title),
      el("span", "ref-count", String(count)),
    );
    if (add) {
      const plus = iconButton("plus", add.label, (event) => {
        event.stopPropagation();
        add.action();
      }, "icon-button small");
      header.append(plus);
    }
    header.addEventListener("click", () => this.toggle(key));
    this.list.append(header);
    if (open) {
      const content = body();
      if (content.length === 0) {
        content.push(el("div", "ref-empty", filtering ? "No matches" : "None"));
      }
      this.list.append(el("div", "ref-section", ...content));
    }
  }

  private tree(refs: Ref[], scope: string, nameOf: (r: Ref) => string, depth = 0): HTMLElement[] {
    const root: TreeNode = { name: "", path: "", children: new Map() };
    for (const ref of refs) {
      const parts = nameOf(ref).split("/");
      let node = root;
      parts.forEach((part, i) => {
        const path = parts.slice(0, i + 1).join("/");
        let child = node.children.get(part + (i === parts.length - 1 ? "" : "/"));
        if (!child) {
          child = { name: part, path, children: new Map() };
          node.children.set(part + (i === parts.length - 1 ? "" : "/"), child);
        }
        if (i === parts.length - 1) child.ref = ref;
        node = child;
      });
    }
    const filtering = Boolean(this.filter.value.trim());
    const out: HTMLElement[] = [];
    const walk = (node: TreeNode, level: number) => {
      // Folders first, then branches, each alphabetically.
      const children = [...node.children.values()].sort((a, b) => Number(Boolean(a.ref)) - Number(Boolean(b.ref)) || a.name.localeCompare(b.name));
      for (const child of children) {
        if (child.ref) {
          out.push(this.refRow(child.ref, child.name, level));
        } else {
          const key = `${scope}/${child.path}`;
          const open = filtering || !this.collapsed.has(key);
          out.push(this.folderRow(child.name, "folder", open, level, () => this.toggle(key)));
          if (open) walk(child, level + 1);
        }
      }
    };
    walk(root, depth);
    return out;
  }

  private refRow(ref: Ref, name: string, level: number): HTMLElement {
    const iconName: IconName = ref.kind === "tag" ? "tag" : ref.isHead ? "check" : "branch";
    const selected = this.view.selectedOid() === ref.oid;
    const row = this.row(name, iconName, level, selected);
    row.classList.toggle("head", ref.isHead);
    if (ref.kind === "local") {
      if (ref.upstreamGone) {
        row.append(el("span", "ref-gone", "gone"));
      } else {
        if (ref.behind) row.append(el("span", "ahead-behind behind", icon("arrowDown", 11), String(ref.behind)));
        if (ref.ahead) row.append(el("span", "ahead-behind ahead", icon("arrowUp", 11), String(ref.ahead)));
      }
    }
    row.title = ref.kind === "local" && ref.upstream ? `${ref.short} → ${ref.upstream}` : ref.short;
    row.dataset.ref = ref.name;
    const hidden = this.view.isHidden(ref.name);
    row.classList.toggle("hidden-ref", hidden);
    if (ref.kind !== "tag" || this.view.filter.solo.length === 0) {
      const eye = iconButton(hidden ? "eyeOff" : "eye", hidden ? "Show in the graph" : "Hide in the graph", (event) => {
        event.stopPropagation();
        this.view.setFilter((f) => {
          if (f.solo.length) f.solo = hidden ? [...f.solo, ref.name] : f.solo.filter((r) => r !== ref.name);
          else f.hidden = hidden ? f.hidden.filter((h) => h !== ref.name) : [...f.hidden, ref.name];
        });
      }, "icon-button small ref-eye");
      row.append(eye);
    }
    if (ref.kind !== "tag") row.addEventListener("pointerdown", (event) => startRefDrag(this.view, ref.name, event));
    row.addEventListener("click", () => this.view.revealCommit(ref.oid));
    row.addEventListener("dblclick", () => this.view.actions.checkoutRef(ref.name));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.view.actions.refMenu(ref.name, { x: event.clientX, y: event.clientY });
    });
    return row;
  }

  private row(label: string, iconName: IconName, level: number, selected: boolean): HTMLElement {
    const row = el("div", "ref-row", icon(iconName, 13), el("span", "ref-name", label));
    row.style.paddingLeft = `${14 + level * 14}px`;
    row.classList.toggle("selected", selected);
    return row;
  }

  private folderRow(label: string, iconName: IconName, open: boolean, level: number, onClick: () => void): HTMLElement {
    const row = el("div", "ref-row folder", icon(open ? "chevronDown" : "chevronRight", 11), icon(iconName, 13), el("span", "ref-name", label));
    row.style.paddingLeft = `${8 + level * 14}px`;
    row.addEventListener("click", onClick);
    return row;
  }
}
