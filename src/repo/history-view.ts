// A file's history over the graph: the commits that changed it on the left,
// and on the right either that commit's change to it or the file's blame as
// of that commit.
import { type Blame, type FileCommit, api, errorMessage } from "../api";
import { el } from "../dom";
import { CHANGE_LABELS, avatar, avatarColor, relativeTime, shortSha, splitPath } from "../format";
import { icon, iconButton } from "../icons";
import { notify } from "../toast";
import { CHANGE_ICONS } from "./detail-panel";
import { renderDiff } from "./diff-render";
import type { RepoView } from "./repo-view";

type Tab = "diff" | "blame";

/** How many commits of a file's history to load. */
const LIMIT = 500;

export class HistoryView {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private readonly content: HTMLElement;
  private path = "";
  private commits: FileCommit[] = [];
  private selected = 0;
  private tab: Tab = "diff";
  private token = 0;

  constructor(private readonly view: RepoView) {
    this.header = el("header", "history-header");
    this.list = el("nav", "history-list");
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      this.select(Math.min(Math.max(this.selected + step, 0), this.commits.length - 1));
    });
    this.content = el("div", "history-content");
    this.root = el("div", "history-view", this.header, el("div", "history-body", this.list, this.content));
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(path: string, tab: Tab = "diff"): Promise<void> {
    const token = ++this.token;
    let commits: FileCommit[];
    try {
      commits = await api.fileHistory(this.view.id, path, LIMIT);
    } catch (error) {
      notify.error(`Can't show the history of ${splitPath(path).name}`, errorMessage(error));
      return;
    }
    if (token !== this.token) return;
    if (!commits.length) {
      notify.info(`${splitPath(path).name} has no committed history yet`);
      return;
    }
    this.path = path;
    this.commits = commits;
    this.tab = tab;
    this.view.showCenter("history");
    this.renderHeader();
    this.renderList();
    await this.select(0);
    this.list.focus({ preventScroll: true });
  }

  close(): void {
    if (this.isOpen()) this.view.showCenter("graph");
  }

  private renderHeader(): void {
    const { dir, name } = splitPath(this.path);
    const tabs = el("div", "segmented-tabs");
    for (const tab of ["diff", "blame"] as Tab[]) {
      const b = el("button", `seg${this.tab === tab ? " on" : ""}`, tab === "diff" ? "Changes" : "Blame");
      b.type = "button";
      b.addEventListener("click", () => {
        this.tab = tab;
        this.renderHeader();
        void this.select(this.selected);
      });
      tabs.append(b);
    }
    const count = this.commits.length >= LIMIT ? `latest ${LIMIT} commits` : `${this.commits.length} commit${this.commits.length === 1 ? "" : "s"}`;
    this.header.replaceChildren(
      icon("tree", 16),
      el("div", "history-title", el("strong", "", "History"), el("span", "file-path", el("span", "file-dir", dir), el("span", "file-name", name)), el("span", "merge-status", count)),
      tabs,
      iconButton("close", "Close (Esc)", () => this.close()),
    );
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.commits.map((c, i) => {
        const row = el(
          "div",
          `history-row${i === this.selected ? " selected" : ""}`,
          avatar(c.author, c.email, 22),
          el(
            "div",
            "history-text",
            el("div", "history-subject", c.subject || "(no message)"),
            el("div", "history-meta", el("span", "mono", shortSha(c.oid)), ` · ${c.author} · ${relativeTime(c.authorTime)}`),
          ),
        );
        if (c.kind !== "modified") {
          const badge = el("span", `history-kind kind-${c.kind}`, icon(CHANGE_ICONS[c.kind], 12), CHANGE_LABELS[c.kind]);
          if (c.oldPath) badge.title = `from ${c.oldPath}`;
          row.append(badge);
        }
        row.addEventListener("click", () => void this.select(i));
        row.addEventListener("dblclick", () => this.view.revealCommit(c.oid) && this.close());
        return row;
      }),
    );
  }

  private async select(index: number): Promise<void> {
    const commit = this.commits[index];
    if (!commit) return;
    this.selected = index;
    for (const [i, row] of [...this.list.children].entries()) row.classList.toggle("selected", i === index);
    this.list.children[index]?.scrollIntoView({ block: "nearest" });
    const token = ++this.token;
    this.content.replaceChildren(el("div", "diff-notice", "Loading…"));
    const top = el(
      "div",
      "history-commit",
      el("span", "mono", shortSha(commit.oid)),
      el("span", "history-commit-subject", commit.subject),
      this.jump(commit.oid),
    );
    try {
      if (this.tab === "diff") {
        const diff = await api.fileDiff(this.view.id, { kind: "commit", oid: commit.oid }, commit.path, commit.oldPath ?? null, this.view.settings().diffContext);
        if (token !== this.token) return;
        this.content.replaceChildren(top, el("div", "diff-body history-diff", ...renderDiff(diff)));
      } else if (commit.kind === "deleted") {
        this.content.replaceChildren(top, el("div", "diff-notice", "The file was deleted in this commit, so there's nothing to blame."));
      } else {
        const blame = await api.blame(this.view.id, commit.path, commit.oid);
        if (token !== this.token) return;
        this.content.replaceChildren(top, this.renderBlame(blame));
      }
    } catch (error) {
      if (token === this.token) this.content.replaceChildren(top, el("div", "diff-notice", errorMessage(error)));
    }
  }

  private jump(oid: string): HTMLElement {
    const b = el("button", "button-secondary small", icon("commit", 13), "Show in graph");
    b.type = "button";
    b.addEventListener("click", () => {
      if (this.view.revealCommit(oid)) this.close();
    });
    return b;
  }

  /** Consecutive lines from the same commit share one gutter entry. */
  private renderBlame(blame: Blame): HTMLElement {
    const commits = new Map(blame.commits.map((c) => [c.oid, c]));
    const body = el("div", "blame-body");
    let group: HTMLElement | null = null;
    let previous = "";
    for (const line of blame.lines) {
      if (line.oid !== previous || !group) {
        previous = line.oid;
        const info = commits.get(line.oid);
        const uncommitted = /^0+$/.test(line.oid);
        const gutter = el("div", "blame-gutter");
        if (info && !uncommitted) {
          gutter.append(
            el("span", "blame-sha mono", shortSha(line.oid)),
            el("span", "blame-author", info.author),
            el("span", "blame-when", relativeTime(info.authorTime)),
          );
          gutter.title = `${info.summary}\n${info.author} <${info.email}>`;
          gutter.style.setProperty("--blame", avatarColor(info.email || info.author));
          gutter.addEventListener("click", () => {
            const i = this.commits.findIndex((c) => c.oid === line.oid);
            if (i >= 0) {
              this.tab = "diff";
              this.renderHeader();
              void this.select(i);
            } else if (this.view.revealCommit(line.oid)) {
              this.close();
            }
          });
        } else {
          gutter.append(el("span", "blame-author", "Not committed yet"));
        }
        group = el("div", "blame-group", gutter, el("div", "blame-lines"));
        body.append(group);
      }
      group.lastElementChild!.append(el("div", "line", el("span", "ln", String(line.line)), el("span", "code", line.text)));
    }
    if (!blame.lines.length) body.append(el("div", "diff-notice", "The file is empty."));
    return body;
  }
}
