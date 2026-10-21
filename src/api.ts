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
}

export const WORK_IN_PROGRESS = "work-in-progress";

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

export type LineAction = "stage" | "unstage" | "discard";
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
  answerPrompt: (id: number, answer: string | null) => invoke<void>("answer_prompt", { id, answer }),

  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  initRepo: (path: string, branch: string | null) => invoke<RepoInfo>("init_repo", { path, branch }),
  cloneRepo: (url: string, dest: string, onProgress?: Progress) =>
    invoke<RepoInfo>("clone_repo", { url, dest, onProgress: progressChannel(onProgress) }),
  closeRepo: (id: string) => invoke<void>("close_repo", { id }),

  snapshot: (id: string) => invoke<Snapshot>("snapshot", { id }),
  workingStatus: (id: string) => invoke<WorkingStatus>("working_status", { id }),
  loadGraph: (id: string, limit: number, workInProgress: boolean) =>
    invoke<Graph>("load_graph", { id, limit, workInProgress }),
  commitDetails: (id: string, oid: string) => invoke<CommitDetails>("commit_details", { id, oid }),
  compareFiles: (id: string, from: string, to: string) => invoke<FileChange[]>("compare_files", { id, from, to }),
  fileDiff: (id: string, target: DiffTarget, path: string, oldPath: string | null, context: number) =>
    invoke<FileDiff>("file_diff", { id, target, path, oldPath, context }),
  headMessage: (id: string) => invoke<string>("head_message", { id }),
  worktreeFile: (id: string, path: string) => invoke<string>("worktree_file", { id, path }),

  stage: (id: string, paths: string[]) => invoke<void>("stage", { id, paths }),
  unstage: (id: string, paths: string[]) => invoke<void>("unstage", { id, paths }),
  stageAll: (id: string) => invoke<void>("stage_all", { id }),
  unstageAll: (id: string) => invoke<void>("unstage_all", { id }),
  discard: (id: string, paths: string[]) => invoke<void>("discard", { id, paths }),
  applyLines: (id: string, action: LineAction, path: string, hunk: number, hunkHeader: string, lines: number[] | null) =>
    invoke<void>("apply_lines", { id, action, path, hunk, hunkHeader, lines }),
  commit: (id: string, message: string, amend: boolean) => invoke<string>("commit", { id, message, amend }),

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
  reset: (id: string, oid: string, mode: ResetMode) => invoke<void>("reset", { id, oid, mode }),
  sequence: (id: string, action: Sequence) => invoke<void>("sequence", { id, action }),
  resolveWith: (id: string, paths: string[], side: ConflictSide) => invoke<void>("resolve_with", { id, paths, side }),
  createTag: (id: string, name: string, at: string, message: string | null) =>
    invoke<void>("create_tag", { id, name, at, message }),
  deleteTag: (id: string, name: string) => invoke<void>("delete_tag", { id, name }),
  stashPush: (id: string, message: string | null, includeUntracked: boolean) =>
    invoke<void>("stash_push", { id, message, includeUntracked }),
  stashApply: (id: string, stash: string, pop: boolean) => invoke<void>("stash_apply", { id, stash, pop }),
  stashDrop: (id: string, stash: string) => invoke<void>("stash_drop", { id, stash }),

  fetch: (id: string, remote: string | null, onProgress?: Progress) =>
    invoke<void>("fetch", { id, remote, onProgress: progressChannel(onProgress) }),
  pull: (id: string, mode: PullMode, onProgress?: Progress) =>
    invoke<void>("pull", { id, mode, onProgress: progressChannel(onProgress) }),
  push: (id: string, remote: string, branch: string, setUpstream: boolean, force: boolean, onProgress?: Progress) =>
    invoke<void>("push", { id, remote, branch, setUpstream, force, onProgress: progressChannel(onProgress) }),
  pushTag: (id: string, remote: string, tag: string, onProgress?: Progress) =>
    invoke<void>("push_tag", { id, remote, tag, onProgress: progressChannel(onProgress) }),
  deleteRemoteRef: (id: string, remote: string, fullRef: string, onProgress?: Progress) =>
    invoke<void>("delete_remote_ref", { id, remote, fullRef, onProgress: progressChannel(onProgress) }),
  defaultRemote: (id: string) => invoke<string | null>("default_remote", { id }),
  addRemote: (id: string, name: string, url: string) => invoke<void>("add_remote", { id, name, url }),
  removeRemote: (id: string, name: string) => invoke<void>("remove_remote", { id, name }),

  reveal: (path: string) => invoke<void>("reveal", { path }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
};

export function onRepoChanged(handler: (change: RepoChanged) => void): Promise<UnlistenFn> {
  return listen<RepoChanged>("repo-changed", (event) => handler(event.payload));
}

export function onPrompt(handler: (prompt: Prompt) => void): Promise<UnlistenFn> {
  return listen<Prompt>("askpass-prompt", (event) => handler(event.payload));
}
