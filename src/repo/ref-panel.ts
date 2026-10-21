// The left panel: local branches, remotes, tags and stashes. Branch names
// with slashes are grouped into folders.
import { type Ref, api } from "../api";
import { brandMark } from "../brand";
import { el } from "../dom";
import { type IconName, icon, iconButton } from "../icons";
import { showMenu } from "../menu";
import { shortcutLabel } from "../platform";
import type { RepoView } from "./repo-view";

type Section = "local" | "remote" | "tags" | "stashes";

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
  private readonly collapsed = new Set<string>(["section:tags"]);

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
                { label: `Fetch ${remote}`, icon: "refresh", action: () => void this.view.attempt(`Fetch ${remote}`, (p) => api.fetch(this.view.id, remote, p), { progress: true, success: `Fetched ${remote}` }) },
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
              { separator: true },
              { label: "Delete stash", icon: "trash", danger: true, action: () => this.view.actions.dropStash(stash.name) },
            ],
            { x: event.clientX, y: event.clientY },
          );
        });
        return row;
      }),
    );
    this.list.scrollTop = scroll;
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
