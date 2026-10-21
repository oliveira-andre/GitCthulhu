//! The commands the UI calls. Each one runs git off the main thread; changes
//! to a repository take its write lock so they never overlap.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcthulhu_core::diff::FileDiff;
use gitcthulhu_core::inspect::{self, CommitDetails, DiffTarget};
use gitcthulhu_core::log::{self, Graph, GraphOptions, Stash};
use gitcthulhu_core::ops::{
    self, CommitOptions, ConflictSide, LineAction, MergeMode, PullMode, PushOptions, ResetMode,
    Sequence,
};
use gitcthulhu_core::refs::{self, Ref};
use gitcthulhu_core::repo::{Head, RepoState};
use gitcthulhu_core::status::{self, WorkingStatus};
use gitcthulhu_core::store::{AppData, Settings};
use gitcthulhu_core::{Error, Git, Repo, watch};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::state::{AppState, OpenRepo};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    kind: &'static str,
    message: String,
}

impl From<Error> for CommandError {
    fn from(e: Error) -> CommandError {
        CommandError {
            kind: e.kind(),
            message: e.to_string(),
        }
    }
}

impl CommandError {
    fn new(kind: &'static str, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn git(state: &AppState) -> CmdResult<Git> {
    state
        .git
        .clone()
        .map_err(|e| CommandError::new("gitNotFound", e))
}

fn open_repo_handle(state: &AppState, id: &str) -> CmdResult<(Repo, Arc<Mutex<()>>)> {
    state
        .repo(id)
        .ok_or_else(|| CommandError::new("notOpen", "that repository isn't open"))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> gitcthulhu_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CommandError::new("internal", e.to_string()))?
        .map_err(CommandError::from)
}

/// Runs a read-only query against an open repository.
async fn read<T: Send + 'static>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&Repo) -> gitcthulhu_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    let (repo, _) = open_repo_handle(state, id)?;
    blocking(move || f(&repo)).await
}

/// Runs a change, one at a time per repository.
async fn write<T: Send + 'static>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&Repo) -> gitcthulhu_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    let (repo, lock) = open_repo_handle(state, id)?;
    blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&repo)
    })
    .await
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// App

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    git_version: Option<String>,
    git_error: Option<String>,
    platform: &'static str,
    home: Option<PathBuf>,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let git = state.git.clone();
    let (git_version, git_error) = match git {
        Ok(git) => match blocking(move || git.version()).await {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e.message)),
        },
        Err(e) => (None, Some(e)),
    };
    Ok(AppInfo {
        git_version,
        git_error,
        platform: std::env::consts::OS,
        home: std::env::home_dir(),
    })
}

#[tauri::command]
pub fn load_app_data(state: State<'_, AppState>) -> AppData {
    let data = state.data.lock().unwrap();
    data.clone()
}

fn update_data(state: &AppState, change: impl FnOnce(&mut AppData)) -> CmdResult<AppData> {
    let mut data = state.data.lock().unwrap();
    change(&mut data);
    state.save_data(&data)?;
    Ok(data.clone())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<AppData> {
    update_data(&state, |data| data.settings = settings)
}

#[tauri::command]
pub fn save_tabs(
    state: State<'_, AppState>,
    tabs: Vec<PathBuf>,
    active: Option<PathBuf>,
) -> CmdResult<AppData> {
    update_data(&state, |data| {
        data.tabs = tabs;
        data.active_tab = active;
    })
}

#[tauri::command]
pub fn set_favorite(
    state: State<'_, AppState>,
    path: PathBuf,
    favorite: bool,
) -> CmdResult<AppData> {
    update_data(&state, |data| {
        if let Some(recent) = data.recent.iter_mut().find(|r| r.path == path) {
            recent.favorite = favorite;
        }
    })
}

#[tauri::command]
pub fn forget_recent(state: State<'_, AppState>, path: PathBuf) -> CmdResult<AppData> {
    update_data(&state, |data| data.recent.retain(|r| r.path != path))
}

#[tauri::command]
pub fn answer_prompt(state: State<'_, AppState>, id: u64, answer: Option<String>) {
    state.prompts.answer(id, answer);
}

// Opening repositories

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    id: String,
    name: String,
    root: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    id: String,
    refs: bool,
    files: bool,
}

fn register(state: &AppState, repo: Repo) -> CmdResult<RepoInfo> {
    let id = repo.root().to_string_lossy().into_owned();
    let info = RepoInfo {
        id: id.clone(),
        name: repo.name(),
        root: repo.root().to_owned(),
    };
    if !state.is_open(repo.root()) {
        let emit = state.emit.clone();
        let event_id = id.clone();
        let watcher = watch::watch(&repo, move |change| {
            let change = RepoChanged {
                id: event_id.clone(),
                refs: change.refs,
                files: change.files,
            };
            emit(
                "repo-changed",
                serde_json::to_value(change).unwrap_or_default(),
            );
        })
        .ok();
        let mut repos = state.repos.lock().unwrap();
        repos.insert(
            id,
            OpenRepo {
                repo,
                write_lock: Arc::default(),
                _watcher: watcher,
            },
        );
    }
    update_data(state, |data| {
        data.touch_recent(&info.root, &info.name, now())
    })?;
    Ok(info)
}

#[tauri::command]
pub async fn open_repo(state: State<'_, AppState>, path: PathBuf) -> CmdResult<RepoInfo> {
    let git = git(&state)?;
    let repo = blocking(move || Repo::open(&git, &path)).await?;
    register(&state, repo)
}

#[tauri::command]
pub async fn init_repo(
    state: State<'_, AppState>,
    path: PathBuf,
    branch: Option<String>,
) -> CmdResult<RepoInfo> {
    let git = git(&state)?;
    let repo = blocking(move || Repo::init(&git, &path, branch.as_deref())).await?;
    register(&state, repo)
}

#[tauri::command]
pub async fn clone_repo(
    state: State<'_, AppState>,
    url: String,
    dest: PathBuf,
    on_progress: Channel<String>,
) -> CmdResult<RepoInfo> {
    let git = git(&state)?;
    if dest.exists()
        && dest
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(CommandError::new(
            "invalid",
            format!("{} already exists and isn't empty", dest.display()),
        ));
    }
    let repo = blocking(move || {
        gitcthulhu_core::clone(&git, &url, &dest, &mut |line| {
            let _ = on_progress.send(line.to_owned());
        })
    })
    .await?;
    register(&state, repo)
}

#[tauri::command]
pub fn close_repo(state: State<'_, AppState>, id: String) {
    let mut repos = state.repos.lock().unwrap();
    repos.remove(&id);
}

// Reading

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    head: Head,
    state: RepoState,
    refs: Vec<Ref>,
    stashes: Vec<Stash>,
    status: WorkingStatus,
    remotes: Vec<String>,
    /// The message git prepared for a merge or a conflicted pick.
    prepared_message: Option<String>,
}

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>, id: String) -> CmdResult<Snapshot> {
    read(&state, &id, |repo| {
        Ok(Snapshot {
            head: repo.head()?,
            state: repo.state(),
            refs: refs::list(repo)?,
            stashes: log::stash_list(repo)?,
            status: status::status(repo)?,
            remotes: repo.remotes()?,
            prepared_message: repo.prepared_message(),
        })
    })
    .await
}

#[tauri::command]
pub async fn working_status(state: State<'_, AppState>, id: String) -> CmdResult<WorkingStatus> {
    read(&state, &id, status::status).await
}

#[tauri::command]
pub async fn load_graph(
    state: State<'_, AppState>,
    id: String,
    limit: usize,
    work_in_progress: bool,
) -> CmdResult<Graph> {
    read(&state, &id, move |repo| {
        log::load(
            repo,
            &GraphOptions {
                limit,
                work_in_progress,
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn commit_details(
    state: State<'_, AppState>,
    id: String,
    oid: String,
) -> CmdResult<CommitDetails> {
    read(&state, &id, move |repo| inspect::commit_details(repo, &oid)).await
}

#[tauri::command]
pub async fn compare_files(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> CmdResult<Vec<gitcthulhu_core::status::FileChange>> {
    read(&state, &id, move |repo| {
        inspect::changed_files(repo, Some(&from), &to)
    })
    .await
}

#[tauri::command]
pub async fn file_diff(
    state: State<'_, AppState>,
    id: String,
    target: DiffTarget,
    path: String,
    old_path: Option<String>,
    context: Option<u32>,
) -> CmdResult<FileDiff> {
    read(&state, &id, move |repo| {
        inspect::file_diff(
            repo,
            &target,
            &path,
            old_path.as_deref(),
            context.unwrap_or(3),
        )
    })
    .await
}

#[tauri::command]
pub async fn head_message(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    read(&state, &id, ops::head_message).await
}

/// A working-tree file's text, for showing conflict markers.
#[tauri::command]
pub async fn worktree_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<String> {
    read(&state, &id, move |repo| {
        const LIMIT: u64 = 2 * 1024 * 1024;
        let root = repo.root().canonicalize()?;
        let file = root.join(&path).canonicalize()?;
        if !file.starts_with(&root) {
            return Err(Error::Invalid(format!("{path} is outside the repository")));
        }
        if std::fs::metadata(&file)?.len() > LIMIT {
            return Err(Error::Invalid("the file is too large to show".into()));
        }
        Ok(String::from_utf8_lossy(&std::fs::read(&file)?).into_owned())
    })
    .await
}

// Staging and committing

#[tauri::command]
pub async fn stage(state: State<'_, AppState>, id: String, paths: Vec<String>) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::stage_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn unstage(state: State<'_, AppState>, id: String, paths: Vec<String>) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::unstage_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn stage_all(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    write(&state, &id, ops::stage_all).await
}

#[tauri::command]
pub async fn unstage_all(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    write(&state, &id, ops::unstage_all).await
}

#[tauri::command]
pub async fn discard(state: State<'_, AppState>, id: String, paths: Vec<String>) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::discard_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn apply_lines(
    state: State<'_, AppState>,
    id: String,
    action: LineAction,
    path: String,
    hunk: usize,
    hunk_header: String,
    lines: Option<Vec<usize>>,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::apply_lines(repo, action, &path, hunk, &hunk_header, lines.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn commit(
    state: State<'_, AppState>,
    id: String,
    message: String,
    amend: bool,
) -> CmdResult<String> {
    write(&state, &id, move |repo| {
        ops::commit(
            repo,
            &CommitOptions {
                message: &message,
                amend,
                allow_empty: false,
            },
        )
    })
    .await
}

// Branches, history and tags

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::checkout_branch(repo, &name)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CmdResult<String> {
    write(&state, &id, move |repo| {
        ops::checkout_remote_branch(repo, &name)
    })
    .await
}

#[tauri::command]
pub async fn checkout_commit(state: State<'_, AppState>, id: String, oid: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::checkout_detached(repo, &oid)).await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
    at: Option<String>,
    checkout: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::create_branch(repo, &name, at.as_deref(), checkout)
    })
    .await
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
    force: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::delete_branch(repo, &name, force)
    })
    .await
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    id: String,
    old: String,
    new: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::rename_branch(repo, &old, &new)
    })
    .await
}

#[tauri::command]
pub async fn fast_forward_branch(
    state: State<'_, AppState>,
    id: String,
    branch: String,
    upstream: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::fast_forward_branch(repo, &branch, &upstream)
    })
    .await
}

#[tauri::command]
pub async fn merge(
    state: State<'_, AppState>,
    id: String,
    other: String,
    mode: MergeMode,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::merge(repo, &other, mode)).await
}

#[tauri::command]
pub async fn rebase(state: State<'_, AppState>, id: String, onto: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::rebase(repo, &onto)).await
}

#[tauri::command]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    id: String,
    oids: Vec<String>,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::cherry_pick(repo, &oids)).await
}

#[tauri::command]
pub async fn revert(state: State<'_, AppState>, id: String, oid: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::revert(repo, &oid)).await
}

#[tauri::command]
pub async fn reset(
    state: State<'_, AppState>,
    id: String,
    oid: String,
    mode: ResetMode,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::reset(repo, &oid, mode)).await
}

#[tauri::command]
pub async fn sequence(state: State<'_, AppState>, id: String, action: Sequence) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::sequence(repo, action)).await
}

#[tauri::command]
pub async fn resolve_with(
    state: State<'_, AppState>,
    id: String,
    paths: Vec<String>,
    side: ConflictSide,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::resolve_with(repo, &paths, side)
    })
    .await
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    id: String,
    name: String,
    at: String,
    message: Option<String>,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::create_tag(repo, &name, &at, message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::delete_tag(repo, &name)).await
}

#[tauri::command]
pub async fn stash_push(
    state: State<'_, AppState>,
    id: String,
    message: Option<String>,
    include_untracked: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::stash_push(repo, message.as_deref(), include_untracked)
    })
    .await
}

#[tauri::command]
pub async fn stash_apply(
    state: State<'_, AppState>,
    id: String,
    stash: String,
    pop: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::stash_apply(repo, &stash, pop)).await
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, id: String, stash: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::stash_drop(repo, &stash)).await
}

// Remotes

fn progress_sink(channel: Channel<String>) -> impl FnMut(&str) {
    move |line| {
        let _ = channel.send(line.to_owned());
    }
}

#[tauri::command]
pub async fn fetch(
    state: State<'_, AppState>,
    id: String,
    remote: Option<String>,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        ops::fetch(repo, remote.as_deref(), &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn pull(
    state: State<'_, AppState>,
    id: String,
    mode: PullMode,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| ops::pull(repo, mode, &mut sink)).await
}

#[tauri::command]
pub async fn push(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    branch: String,
    set_upstream: bool,
    force: bool,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        ops::push(
            repo,
            &PushOptions {
                remote: &remote,
                branch: &branch,
                set_upstream,
                force,
            },
            &mut sink,
        )
    })
    .await
}

#[tauri::command]
pub async fn push_tag(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    tag: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        ops::push_tag(repo, &remote, &tag, &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn delete_remote_ref(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    full_ref: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        ops::delete_remote_ref(repo, &remote, &full_ref, &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn default_remote(state: State<'_, AppState>, id: String) -> CmdResult<Option<String>> {
    read(&state, &id, ops::default_remote).await
}

#[tauri::command]
pub async fn add_remote(
    state: State<'_, AppState>,
    id: String,
    name: String,
    url: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::add_remote(repo, &name, &url)).await
}

#[tauri::command]
pub async fn remove_remote(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    write(&state, &id, move |repo| ops::remove_remote(repo, &name)).await
}

// The desktop

/// Opens a folder in Finder, Explorer or the Linux file manager.
#[tauri::command]
pub fn reveal(path: PathBuf) -> CmdResult<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    spawn_detached(program, &[path.as_os_str()])
}

/// Opens a terminal window in the repository.
#[tauri::command]
pub fn open_terminal(path: PathBuf) -> CmdResult<()> {
    if cfg!(target_os = "macos") {
        spawn_detached(
            "open",
            &["-a".as_ref(), "Terminal".as_ref(), path.as_os_str()],
        )
    } else if cfg!(windows) {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", "cmd.exe"]).current_dir(&path);
        cmd.spawn()
            .map(drop)
            .map_err(|e| CommandError::new("io", e.to_string()))
    } else {
        ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
            .iter()
            .find_map(|program| {
                std::process::Command::new(program)
                    .current_dir(&path)
                    .spawn()
                    .ok()
            })
            .map(drop)
            .ok_or_else(|| CommandError::new("io", "no terminal program was found"))
    }
}

fn spawn_detached(program: &str, args: &[&std::ffi::OsStr]) -> CmdResult<()> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(drop)
        .map_err(|e| CommandError::new("io", e.to_string()))
}

/// Whether a folder is a repository root, for the open dialog's hints.
#[tauri::command]
pub fn looks_like_repo(path: PathBuf) -> bool {
    Path::new(&path).join(".git").exists()
}
