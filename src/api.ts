// Typed wrappers around the Rust commands registered in src-tauri/src/lib.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CommandError {
  kind: string;
  message: string;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as CommandError).message);
  }
  return String(error);
}

export function errorKind(error: unknown): string | null {
  return error && typeof error === "object" && "kind" in error ? String((error as CommandError).kind) : null;
}

// Repository data

export type RowKind = "commit" | "stash" | "workInProgress";

export interface GraphCommit {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the epoch. */
  authorTime: number;
  committer: string;
  commitTime: number;
  subject: string;
  kind: RowKind;
  /** Stashes only: `stash@{0}`. */
  stash?: string;
}

export interface Edge {
  from: number;
  to: number;
  color: number;
  dashed?: boolean;
}

export interface RowLayout {
  lane: number;
  color: number;
  /** Lines from the row above into this row. */
  edges: Edge[];
}

export interface Graph {
  commits: GraphCommit[];
  rows: RowLayout[];
  truncated: boolean;
  /** git has a commit-graph file; without one, loading a long history is slow. */
  indexed: boolean;
}

export const WORK_IN_PROGRESS = "work-in-progress";

/** Which refs the graph starts from. */
export interface RefFilter {
  /** Full ref names or globs such as `refs/tags/*`. */
  hidden: string[];
  /** When not empty, only these refs are shown. */
  solo: string[];
  hideStashes: boolean;
}

export interface CommitStat {
  oid: string;
  files: number;
  insertions: number;
  deletions: number;
}

export type RefKind = "local" | "remote" | "tag";

export interface Ref {
  name: string;
  short: string;
  kind: RefKind;
  oid: string;
  remote: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  isHead: boolean;
  annotated: boolean;
}

export interface Head {
  branch: string | null;
  oid: string | null;
}

export type RepoState =
  | { kind: "clean" }
  | { kind: "merging"; head: string | null }
  | { kind: "rebasing"; step: number | null; total: number | null; branch: string | null; onto: string | null }
  | { kind: "cherryPicking"; head: string | null }
  | { kind: "reverting"; head: string | null }
  | { kind: "applyingPatches"; step: number | null; total: number | null }
  | { kind: "bisecting" };

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  | "conflicted";

export interface FileChange {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  conflict?: string;
  submodule?: boolean;
}

export interface WorkingStatus {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
}

export interface Stash {
  name: string;
  oid: string;
  parents: string[];
  message: string;
  time: number;
}

export interface Snapshot {
  head: Head;
  state: RepoState;
  refs: Ref[];
  stashes: Stash[];
  status: WorkingStatus;
  remotes: string[];
  preparedMessage: string | null;
  /** What Undo and Redo would take back or reapply. */
  undo: { undo: string | null; redo: string | null };
}

export interface Identity {
  name: string | null;
  email: string | null;
  /** Set in this repository's config rather than globally. */
  local: boolean;
}

export interface CommitDetails {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  summary: string;
  body: string;
  files: FileChange[];
}

export type LineKind = "context" | "added" | "removed" | "noNewline";

export interface Line {
  kind: LineKind;
  old: number | null;
  new: number | null;
  text: string;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Line[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  tooLarge?: boolean;
}

export type DiffTarget =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "commit"; oid: string }
  | { kind: "range"; from: string; to: string };

export type BlobSource = { kind: "worktree" } | { kind: "index" } | { kind: "revision"; rev: string };

export type LineAction = "stage" | "unstage" | "discard";

export type SymbolSearch = "definitions" | "references";

export interface SymbolMatch {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
  /** The line looks like it declares the symbol. */
  definition: boolean;
}

export interface SymbolResults {
  matches: SymbolMatch[];
  truncated: boolean;
}
export interface Submodule {
  path: string;
  name: string;
  url: string | null;
  oid: string;
  state: "current" | "changed" | "uninitialized" | "conflicted";
}

export interface Worktree {
  path: string;
  oid: string | null;
  branch: string | null;
  main: boolean;
  current: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface LfsStatus {
  /** null when git-lfs isn't installed. */
  version: string | null;
  patterns: string[];
  files: { path: string; downloaded: boolean }[];
}

export interface FlowConfig {
  production: string;
  develop: string;
  feature: string;
  release: string;
  hotfix: string;
  versionTag: string;
}

export type FlowKind = "feature" | "release" | "hotfix";

export interface Extras {
  submodules: Submodule[];
  worktrees: Worktree[];
  lfs: LfsStatus;
  /** null until Gitflow is set up. */
  gitflow: FlowConfig | null;
}

export interface FileCommit {
  oid: string;
  author: string;
  email: string;
  authorTime: number;
  subject: string;
  /** The file's path in this commit; it changes across renames. */
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

export interface Blame {
  lines: { oid: string; line: number; text: string }[];
  commits: { oid: string; author: string; email: string; authorTime: number; summary: string }[];
}

export type Segment =
  | { kind: "stable"; lines: string[] }
  | { kind: "conflict"; ours: string[]; base: string[]; theirs: string[] };

export interface ConflictFile {
  path: string;
  segments: Segment[];
  trailingNewline: boolean;
  binary: boolean;
  deletedInOurs: boolean;
  deletedInTheirs: boolean;
}

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface PlanCommit {
  oid: string;
  author: string;
  email: string;
  authorTime: number;
  summary: string;
  message: string;
}

export interface RebaseStep {
  oid: string;
  action: RebaseAction;
  /** Rewords only. */
  message?: string;
}
export type MergeMode = "default" | "noFastForward" | "fastForwardOnly" | "squash";
export type PullMode = "merge" | "fastForwardOnly" | "rebase";
export type ResetMode = "soft" | "mixed" | "hard";
export type Sequence = "continue" | "abort" | "skip";
export type ConflictSide = "ours" | "theirs";

// App data

export interface Settings {
  commitLimit: number;
  autoFetchMinutes: number;
  diffContext: number;
  dateFormat: "relative" | "absolute";
  showAvatars: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  /** Compact shows a changed line once, with its words changed inline; unified ("Detailed") shows removed and added lines apart. */
  diffLayout: "compact" | "unified" | "split";
  ignoreWhitespace: boolean;
  /** Command that opens files, e.g. `code`; empty uses the system default. */
  editor: string;
  theme: "dracula" | "dark" | "light" | "system";
  zoom: number;
}

/** git's global name and email: who is using the app. */
export interface Profile {
  name: string | null;
  email: string | null;
}

export interface RecentRepo {
  path: string;
  name: string;
  openedAt: number;
  favorite: boolean;
}

export interface AppData {
  version: number;
  recent: RecentRepo[];
  tabs: string[];
  activeTab: string | null;
  settings: Settings;
}

export interface AppInfo {
  gitVersion: string | null;
  gitError: string | null;
  platform: string;
  home: string | null;
}

export interface CloneOptions {
  depth: number | null;
  branch: string | null;
  singleBranch: boolean;
  recurseSubmodules: boolean;
}

export interface RepoInfo {
  id: string;
  name: string;
  root: string;
}

export interface Prompt {
  id: number;
  text: string;
  kind: "username" | "secret" | "yesNo";
}

export interface RepoChanged {
  id: string;
  refs: boolean;
  files: boolean;
}

type Progress = (line: string) => void;

function progressChannel(onProgress?: Progress): Channel<string> {
  const channel = new Channel<string>();
  channel.onmessage = (line) => onProgress?.(line);
  return channel;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  loadAppData: () => invoke<AppData>("load_app_data"),
  saveSettings: (settings: Settings) => invoke<AppData>("save_settings", { settings }),
  saveTabs: (tabs: string[], active: string | null) => invoke<AppData>("save_tabs", { tabs, active }),
  setFavorite: (path: string, favorite: boolean) => invoke<AppData>("set_favorite", { path, favorite }),
  forgetRecent: (path: string) => invoke<AppData>("forget_recent", { path }),
  addRecent: (paths: string[]) => invoke<AppData>("add_recent", { paths }),
  /** Repositories in and up to four folders below `root`. */
  findRepositories: (root: string) => invoke<string[]>("find_repositories", { root }),
  answerPrompt: (id: number, answer: string | null) => invoke<void>("answer_prompt", { id, answer }),
  profile: () => invoke<Profile>("profile"),
  setProfile: (name: string, email: string) => invoke<Profile>("set_profile", { name, email }),
  /** The HTTPS hosts the open repositories' remotes sign in to, as `https://host`. */
  remoteHosts: () => invoke<string[]>("remote_hosts"),
  /** Forgets the global name and email (`identity`) and the passwords saved for `hosts`. */
  signOut: (identity: boolean, hosts: string[]) => invoke<void>("sign_out", { identity, hosts }),

  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  initRepo: (path: string, branch: string | null) => invoke<RepoInfo>("init_repo", { path, branch }),
  cloneRepo: (url: string, dest: string, options: CloneOptions, onProgress?: Progress) =>
    invoke<RepoInfo>("clone_repo", { url, dest, options, onProgress: progressChannel(onProgress) }),
  closeRepo: (id: string) => invoke<void>("close_repo", { id }),

  snapshot: (id: string) => invoke<Snapshot>("snapshot", { id }),
  workingStatus: (id: string) => invoke<WorkingStatus>("working_status", { id }),
  loadGraph: (id: string, limit: number, workInProgress: boolean, filter: RefFilter) =>
    invoke<Graph>("load_graph", { id, limit, workInProgress, filter }),
  commitStats: (id: string, oids: string[]) => invoke<CommitStat[]>("commit_stats", { id, oids }),
  /** Messages, authors and SHAs across all history, newest first. */
  searchCommits: (id: string, query: string, limit: number) => invoke<GraphCommit[]>("search_commits", { id, query, limit }),
  commitDetails: (id: string, oid: string) => invoke<CommitDetails>("commit_details", { id, oid }),
  compareFiles: (id: string, from: string, to: string) => invoke<FileChange[]>("compare_files", { id, from, to }),
  fileDiff: (id: string, target: DiffTarget, path: string, oldPath: string | null, context: number, ignoreWhitespace = false) =>
    invoke<FileDiff>("file_diff", { id, target, path, oldPath, context, ignoreWhitespace }),
  /** A data URL, or null when the file doesn't exist on that side. */
  fileImage: (id: string, source: BlobSource, path: string) => invoke<string | null>("file_image", { id, source, path }),
  headMessage: (id: string) => invoke<string>("head_message", { id }),
  worktreeFile: (id: string, path: string) => invoke<string>("worktree_file", { id, path }),
  /** null when the file doesn't exist there. */
  fileText: (id: string, source: BlobSource, path: string) => invoke<string | null>("file_text", { id, source, path }),
  /** Whole-word matches of `symbol`; definitions are the ones that look like declarations. */
  findSymbol: (id: string, source: BlobSource, symbol: string, search: SymbolSearch) =>
    invoke<SymbolResults>("find_symbol", { id, source, symbol, search }),

  stage: (id: string, paths: string[]) => invoke<void>("stage", { id, paths }),
  unstage: (id: string, paths: string[]) => invoke<void>("unstage", { id, paths }),
  stageAll: (id: string) => invoke<void>("stage_all", { id }),
  unstageAll: (id: string) => invoke<void>("unstage_all", { id }),
  discard: (id: string, paths: string[]) => invoke<void>("discard", { id, paths }),
  applySelection: (id: string, action: LineAction, path: string, selections: { hunk: number; header: string; lines: number[] | null }[], context: number) =>
    invoke<void>("apply_selection", { id, action, path, selections, context }),
  /** `context` is the context the diff was shown with. */
  applyLines: (id: string, action: LineAction, path: string, hunk: number, hunkHeader: string, lines: number[] | null, context: number) =>
    invoke<void>("apply_lines", { id, action, path, hunk, hunkHeader, lines, context }),
  commit: (id: string, message: string, amend: boolean, signOff = false, noVerify = false) =>
    invoke<string>("commit", { id, message, amend, signOff, noVerify }),
  identity: (id: string) => invoke<Identity>("identity", { id }),
  setIdentity: (id: string, name: string, email: string, global: boolean) => invoke<void>("set_identity", { id, name, email, global }),
  commitTemplate: (id: string) => invoke<string | null>("commit_template", { id }),

  checkoutBranch: (id: string, name: string) => invoke<void>("checkout_branch", { id, name }),
  checkoutRemoteBranch: (id: string, name: string) => invoke<string>("checkout_remote_branch", { id, name }),
  checkoutCommit: (id: string, oid: string) => invoke<void>("checkout_commit", { id, oid }),
  createBranch: (id: string, name: string, at: string | null, checkout: boolean) =>
    invoke<void>("create_branch", { id, name, at, checkout }),
  deleteBranch: (id: string, name: string, force: boolean) => invoke<void>("delete_branch", { id, name, force }),
  renameBranch: (id: string, old: string, newName: string) => invoke<void>("rename_branch", { id, old, new: newName }),
  fastForwardBranch: (id: string, branch: string, upstream: string) =>
    invoke<void>("fast_forward_branch", { id, branch, upstream }),
  merge: (id: string, other: string, mode: MergeMode) => invoke<void>("merge", { id, other, mode }),
  rebase: (id: string, onto: string) => invoke<void>("rebase", { id, onto }),
  cherryPick: (id: string, oids: string[]) => invoke<void>("cherry_pick", { id, oids }),
  revert: (id: string, oid: string) => invoke<void>("revert", { id, oid }),
  /** Newest first, so each revert applies on top of the previous one. */
  revertCommits: (id: string, oids: string[]) => invoke<void>("revert_commits", { id, oids }),
  reset: (id: string, oid: string, mode: ResetMode) => invoke<void>("reset", { id, oid, mode }),
  sequence: (id: string, action: Sequence) => invoke<void>("sequence", { id, action }),
  resolveWith: (id: string, paths: string[], side: ConflictSide) => invoke<void>("resolve_with", { id, paths, side }),
  createTag: (id: string, name: string, at: string, message: string | null) =>
    invoke<void>("create_tag", { id, name, at, message }),
  deleteTag: (id: string, name: string) => invoke<void>("delete_tag", { id, name }),
  /** `paths` stashes only those files' changes. */
  stashPush: (id: string, message: string | null, includeUntracked: boolean, paths: string[] | null = null) =>
    invoke<void>("stash_push", { id, message, includeUntracked, paths }),
  stashApply: (id: string, stash: string, pop: boolean) => invoke<void>("stash_apply", { id, stash, pop }),
  stashDrop: (id: string, stash: string) => invoke<void>("stash_drop", { id, stash }),
  /** Commits oldest first; no oids saves the uncommitted changes. */
  savePatch: (id: string, oids: string[], path: string) => invoke<void>("save_patch", { id, oids, path }),
  applyPatch: (id: string, path: string, asCommits: boolean) => invoke<void>("apply_patch", { id, path, asCommits }),
  /** Renaming moves the stash to the top (stash@{0}). */
  stashRename: (id: string, stash: string, message: string) => invoke<void>("stash_rename", { id, stash, message }),
  stashUntracked: (id: string, oid: string) => invoke<{ commit: string | null; files: FileChange[] }>("stash_untracked", { id, oid }),

  extras: (id: string) => invoke<Extras>("extras", { id }),
  submoduleUpdate: (id: string, path: string | null, onProgress?: Progress) =>
    invoke<void>("submodule_update", { id, path, onProgress: progressChannel(onProgress) }),
  submoduleAdd: (id: string, url: string, path: string, onProgress?: Progress) =>
    invoke<void>("submodule_add", { id, url, path, onProgress: progressChannel(onProgress) }),
  worktreeAdd: (id: string, path: string, branch: string, create: boolean, start: string | null) =>
    invoke<void>("worktree_add", { id, path, branch, create, start }),
  worktreeRemove: (id: string, path: string, force: boolean) => invoke<void>("worktree_remove", { id, path, force }),
  worktreePrune: (id: string) => invoke<void>("worktree_prune", { id }),
  lfsTrack: (id: string, pattern: string) => invoke<void>("lfs_track", { id, pattern }),
  lfsUntrack: (id: string, pattern: string) => invoke<void>("lfs_untrack", { id, pattern }),
  lfsInstall: (id: string) => invoke<void>("lfs_install", { id }),
  lfsPull: (id: string, onProgress?: Progress) => invoke<void>("lfs_pull", { id, onProgress: progressChannel(onProgress) }),
  lfsPrune: (id: string, onProgress?: Progress) => invoke<void>("lfs_prune", { id, onProgress: progressChannel(onProgress) }),
  gitflowInit: (id: string, config: FlowConfig) => invoke<void>("gitflow_init", { id, config }),
  gitflowStart: (id: string, kind: FlowKind, name: string) => invoke<string>("gitflow_start", { id, kind, name }),
  gitflowFinish: (id: string, kind: FlowKind, name: string, tagMessage: string | null) =>
    invoke<void>("gitflow_finish", { id, kind, name, tagMessage }),

  /** Newest first, following renames. */
  fileHistory: (id: string, path: string, limit: number) => invoke<FileCommit[]>("file_history", { id, path, limit }),
  /** `rev: null` blames the checked-out version. */
  blame: (id: string, path: string, rev: string | null) => invoke<Blame>("blame", { id, path, rev }),
  trackedFiles: (id: string) => invoke<string[]>("tracked_files", { id }),

  conflictFile: (id: string, path: string) => invoke<ConflictFile>("conflict_file", { id, path }),
  /** Writes the merged text and stages it, marking the file resolved. */
  resolveFile: (id: string, path: string, contents: string) => invoke<void>("resolve_file", { id, path, contents }),
  resolveDeleted: (id: string, path: string) => invoke<void>("resolve_deleted", { id, path }),

  /** `onto: null` rebases the whole history. Commits come oldest first. */
  rebasePlan: (id: string, onto: string | null) => invoke<PlanCommit[]>("rebase_plan", { id, onto }),
  interactiveRebase: (id: string, onto: string | null, steps: RebaseStep[]) =>
    invoke<void>("interactive_rebase", { id, onto, steps }),
  rewordCommit: (id: string, oid: string, message: string) => invoke<void>("reword_commit", { id, oid, message }),
  dropCommit: (id: string, oid: string) => invoke<void>("drop_commit", { id, oid }),
  moveCommit: (id: string, oid: string, up: boolean) => invoke<void>("move_commit", { id, oid, up }),

  /** Both resolve to the label of what was undone or redone. */
  undo: (id: string) => invoke<string>("undo", { id }),
  redo: (id: string) => invoke<string>("redo", { id }),

  fetch: (id: string, remote: string | null, onProgress?: Progress) =>
    invoke<void>("fetch", { id, remote, onProgress: progressChannel(onProgress) }),
  /** Writes git's commit-graph file, which speeds up the graph and file history. */
  writeCommitGraph: (id: string, onProgress?: Progress) =>
    invoke<void>("write_commit_graph", { id, onProgress: progressChannel(onProgress) }),
  pull: (id: string, mode: PullMode, onProgress?: Progress) =>
    invoke<void>("pull", { id, mode, onProgress: progressChannel(onProgress) }),
  /** `remoteBranch` names the branch on the remote when it differs. */
  push: (id: string, remote: string, branch: string, setUpstream: boolean, force: boolean, onProgress?: Progress, remoteBranch: string | null = null) =>
    invoke<void>("push", { id, remote, branch, remoteBranch, setUpstream, force, onProgress: progressChannel(onProgress) }),
  setRemoteUrl: (id: string, name: string, url: string) => invoke<void>("set_remote_url", { id, name, url }),
  renameRemote: (id: string, old: string, newName: string) => invoke<void>("rename_remote", { id, old, new: newName }),
  remoteUrl: (id: string, name: string) => invoke<string | null>("remote_url", { id, name }),
  /** `upstream: null` stops tracking. */
  setUpstream: (id: string, branch: string, upstream: string | null) => invoke<void>("set_upstream", { id, branch, upstream }),
  pushTag: (id: string, remote: string, tag: string, onProgress?: Progress) =>
    invoke<void>("push_tag", { id, remote, tag, onProgress: progressChannel(onProgress) }),
  deleteRemoteRef: (id: string, remote: string, fullRef: string, onProgress?: Progress) =>
    invoke<void>("delete_remote_ref", { id, remote, fullRef, onProgress: progressChannel(onProgress) }),
  defaultRemote: (id: string) => invoke<string | null>("default_remote", { id }),
  addRemote: (id: string, name: string, url: string) => invoke<void>("add_remote", { id, name, url }),
  removeRemote: (id: string, name: string) => invoke<void>("remove_remote", { id, name }),

  /** Starts the user's shell in the repository; output arrives as raw bytes. */
  terminalOpen: (id: string, cols: number, rows: number, onOutput: Channel<ArrayBuffer>, onExit: Channel<number | null>) =>
    invoke<number>("terminal_open", { id, cols, rows, onOutput, onExit }),
  terminalWrite: (session: number, data: Uint8Array) => invoke<void>("terminal_write", { session, data: Array.from(data) }),
  terminalResize: (session: number, cols: number, rows: number) => invoke<void>("terminal_resize", { session, cols, rows }),
  terminalClose: (session: number) => invoke<void>("terminal_close", { session }),

  reveal: (path: string) => invoke<void>("reveal", { path }),
  /** `path: null` opens the repository itself. */
  openInEditor: (id: string, path: string | null) => invoke<void>("open_in_editor", { id, path }),
  openDifftool: (id: string, target: DiffTarget, path: string) => invoke<void>("open_difftool", { id, target, path }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
};

export function onRepoChanged(handler: (change: RepoChanged) => void): Promise<UnlistenFn> {
  return listen<RepoChanged>("repo-changed", (event) => handler(event.payload));
}

export function onPrompt(handler: (prompt: Prompt) => void): Promise<UnlistenFn> {
  return listen<Prompt>("askpass-prompt", (event) => handler(event.payload));
}
