//! The commands the UI calls. Each one runs git off the main thread; changes
//! to a repository take its write lock so they never overlap.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use gitcthulhu_core::conflict::{self, ConflictFile};
use gitcthulhu_core::diff::FileDiff;
use gitcthulhu_core::gitflow::{self, FlowConfig, FlowKind};
use gitcthulhu_core::history::{self, Blame, FileCommit};
use gitcthulhu_core::inspect::{self, BlobSource, CommitDetails, DiffTarget};
use gitcthulhu_core::lfs::{self, LfsStatus};
use gitcthulhu_core::log::{self, CommitStat, Graph, GraphCommit, GraphOptions, RefFilter, Stash};
use gitcthulhu_core::ops::{
    self, CommitOptions, ConflictSide, Identity, LineAction, LineSelection, MergeMode, PullMode,
    PushOptions, ResetMode, Sequence,
};
use gitcthulhu_core::rebase::{self, PlanCommit, RebaseStep};
use gitcthulhu_core::refs::{self, Ref};
use gitcthulhu_core::repo::{Head, RepoState};
use gitcthulhu_core::status::{self, WorkingStatus};
use gitcthulhu_core::store::{AppData, Settings};
use gitcthulhu_core::submodules::{self, Submodule};
use gitcthulhu_core::terminal::{self, Terminal};
use gitcthulhu_core::undo::{self, Available, Change, Entry, TipMove};
use gitcthulhu_core::worktrees::{self, Worktree};
use gitcthulhu_core::{CloneOptions, Error, Git, Repo, watch};
use serde::Serialize;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::state::{AppState, OpenRepo, RepoHandle};

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

fn open_repo_handle(state: &AppState, id: &str) -> CmdResult<RepoHandle> {
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
    let repo = open_repo_handle(state, id)?.repo;
    blocking(move || f(&repo)).await
}

/// Runs a change, one at a time per repository.
async fn write<T: Send + 'static>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&Repo) -> gitcthulhu_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    let handle = open_repo_handle(state, id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        f(&handle.repo)
    })
    .await
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A change Undo can take back: HEAD and the branch and tag tips are
/// recorded around it. One that stops on conflicts is recorded when
/// `sequence` finishes it.
async fn undoable<T: Send + 'static>(
    state: &AppState,
    id: &str,
    label: String,
    tip: TipMove,
    f: impl FnOnce(&Repo) -> gitcthulhu_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    let handle = open_repo_handle(state, id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let before = undo::capture(&handle.repo)?;
        match f(&handle.repo) {
            Ok(value) => {
                let after = undo::capture(&handle.repo)?;
                let change = Change::Refs { before, after, tip };
                lock(&handle.history).record(Entry { label, change });
                Ok(value)
            }
            Err(e @ Error::Conflicts(_)) => {
                lock(&handle.history).suspend(label, before, tip);
                Err(e)
            }
            Err(e) => Err(e),
        }
    })
    .await
}

/// Throws away working-tree changes to `paths`, keeping their contents for
/// Undo when they fit in memory.
fn discard_with_backup(
    handle: &RepoHandle,
    label: &str,
    paths: &[String],
    discard: impl FnOnce() -> gitcthulhu_core::Result<()>,
) -> gitcthulhu_core::Result<()> {
    let before = undo::backup_files(&handle.repo, paths).ok();
    discard()?;
    if let (Some(before), Ok(after)) = (before, undo::backup_files(&handle.repo, paths)) {
        let change = Change::Files { before, after };
        lock(&handle.history).record(Entry {
            label: label.to_owned(),
            change,
        });
    }
    Ok(())
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
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
                handle: RepoHandle {
                    repo,
                    write_lock: Arc::default(),
                    history: Arc::default(),
                },
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
    options: Option<CloneOptions>,
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
        gitcthulhu_core::clone_with(
            &git,
            &url,
            &dest,
            &options.unwrap_or_default(),
            &mut |line| {
                let _ = on_progress.send(line.to_owned());
            },
        )
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
    undo: Available,
}

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>, id: String) -> CmdResult<Snapshot> {
    let handle = open_repo_handle(&state, &id)?;
    let undo = lock(&handle.history).available();
    blocking(move || {
        let repo = &handle.repo;
        Ok(Snapshot {
            head: repo.head()?,
            state: repo.state(),
            refs: refs::list(repo)?,
            stashes: log::stash_list(repo)?,
            status: status::status(repo)?,
            remotes: repo.remotes()?,
            prepared_message: repo.prepared_message(),
            undo,
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
    filter: Option<RefFilter>,
) -> CmdResult<Graph> {
    read(&state, &id, move |repo| {
        let filter = filter.unwrap_or_default();
        log::load(
            repo,
            &GraphOptions {
                limit,
                work_in_progress,
                filter,
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn commit_stats(
    state: State<'_, AppState>,
    id: String,
    oids: Vec<String>,
) -> CmdResult<Vec<CommitStat>> {
    read(&state, &id, move |repo| log::commit_stats(repo, &oids)).await
}

#[tauri::command]
pub async fn search_commits(
    state: State<'_, AppState>,
    id: String,
    query: String,
    limit: usize,
) -> CmdResult<Vec<GraphCommit>> {
    read(&state, &id, move |repo| log::search(repo, &query, limit)).await
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
    ignore_whitespace: Option<bool>,
) -> CmdResult<FileDiff> {
    read(&state, &id, move |repo| {
        let context = context.unwrap_or(3);
        inspect::file_diff_with(
            repo,
            &target,
            &path,
            old_path.as_deref(),
            context,
            ignore_whitespace.unwrap_or(false),
        )
    })
    .await
}

/// An image's bytes as a data URL, or `None` when it doesn't exist there.
#[tauri::command]
pub async fn file_image(
    state: State<'_, AppState>,
    id: String,
    source: BlobSource,
    path: String,
) -> CmdResult<Option<String>> {
    const MAX: usize = 16 * 1024 * 1024;
    let mime =
        image_mime(&path).ok_or_else(|| CommandError::new("invalid", "that isn't an image"))?;
    read(&state, &id, move |repo| {
        Ok(inspect::blob(repo, &source, &path, MAX)?
            .map(|bytes| format!("data:{mime};base64,{}", base64(&bytes))))
    })
    .await
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // Scripts in an SVG don't run when it's shown through <img>.
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        discard_with_backup(&handle, "Discard", &paths, || {
            ops::discard_paths(&handle.repo, &paths)
        })
    })
    .await
}

// Commands take the UI's arguments as flat parameters.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn apply_lines(
    state: State<'_, AppState>,
    id: String,
    action: LineAction,
    path: String,
    hunk: usize,
    hunk_header: String,
    lines: Option<Vec<usize>>,
    context: Option<u32>,
) -> CmdResult<()> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let context = context.unwrap_or(3);
        let apply = || {
            ops::apply_lines(
                &handle.repo,
                action,
                &path,
                hunk,
                &hunk_header,
                lines.as_deref(),
                context,
            )
        };
        if action == LineAction::Discard {
            discard_with_backup(&handle, "Discard lines", std::slice::from_ref(&path), apply)
        } else {
            apply()
        }
    })
    .await
}

/// Stages, unstages or discards chosen lines across several hunks of a file.
#[tauri::command]
pub async fn apply_selection(
    state: State<'_, AppState>,
    id: String,
    action: LineAction,
    path: String,
    selections: Vec<LineSelection>,
    context: Option<u32>,
) -> CmdResult<()> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let context = context.unwrap_or(3);
        let apply = || ops::apply_selection(&handle.repo, action, &path, &selections, context);
        if action == LineAction::Discard {
            discard_with_backup(&handle, "Discard lines", std::slice::from_ref(&path), apply)
        } else {
            apply()
        }
    })
    .await
}

#[tauri::command]
pub async fn commit(
    state: State<'_, AppState>,
    id: String,
    message: String,
    amend: bool,
    sign_off: Option<bool>,
    no_verify: Option<bool>,
) -> CmdResult<String> {
    let label = if amend { "Amend" } else { "Commit" }.to_owned();
    undoable(&state, &id, label, TipMove::Soft, move |repo| {
        let options = CommitOptions {
            message: &message,
            amend,
            allow_empty: false,
            sign_off: sign_off.unwrap_or(false),
            no_verify: no_verify.unwrap_or(false),
        };
        ops::commit(repo, &options)
    })
    .await
}

#[tauri::command]
pub async fn identity(state: State<'_, AppState>, id: String) -> CmdResult<Identity> {
    read(&state, &id, ops::identity).await
}

#[tauri::command]
pub async fn set_identity(
    state: State<'_, AppState>,
    id: String,
    name: String,
    email: String,
    global: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::set_identity(repo, &name, &email, global)
    })
    .await
}

#[tauri::command]
pub async fn commit_template(state: State<'_, AppState>, id: String) -> CmdResult<Option<String>> {
    read(&state, &id, ops::commit_template).await
}

// Branches, history and tags

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Check out {name}"),
        TipMove::Keep,
        move |repo| ops::checkout_branch(repo, &name),
    )
    .await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CmdResult<String> {
    undoable(
        &state,
        &id,
        format!("Check out {name}"),
        TipMove::Keep,
        move |repo| ops::checkout_remote_branch(repo, &name),
    )
    .await
}

#[tauri::command]
pub async fn checkout_commit(state: State<'_, AppState>, id: String, oid: String) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Check out {}", short(&oid)),
        TipMove::Keep,
        move |repo| ops::checkout_detached(repo, &oid),
    )
    .await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
    at: Option<String>,
    checkout: bool,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Create {name}"),
        TipMove::Keep,
        move |repo| ops::create_branch(repo, &name, at.as_deref(), checkout),
    )
    .await
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    id: String,
    name: String,
    force: bool,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Delete {name}"),
        TipMove::Keep,
        move |repo| ops::delete_branch(repo, &name, force),
    )
    .await
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    id: String,
    old: String,
    new: String,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Rename {old}"),
        TipMove::Keep,
        move |repo| ops::rename_branch(repo, &old, &new),
    )
    .await
}

#[tauri::command]
pub async fn fast_forward_branch(
    state: State<'_, AppState>,
    id: String,
    branch: String,
    upstream: String,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Fast-forward {branch}"),
        TipMove::Keep,
        move |repo| ops::fast_forward_branch(repo, &branch, &upstream),
    )
    .await
}

#[tauri::command]
pub async fn merge(
    state: State<'_, AppState>,
    id: String,
    other: String,
    mode: MergeMode,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Merge {other}"),
        TipMove::Keep,
        move |repo| ops::merge(repo, &other, mode),
    )
    .await
}

#[tauri::command]
pub async fn rebase(state: State<'_, AppState>, id: String, onto: String) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Rebase onto {onto}"),
        TipMove::Keep,
        move |repo| ops::rebase(repo, &onto),
    )
    .await
}

#[tauri::command]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    id: String,
    oids: Vec<String>,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Cherry-pick".to_owned(),
        TipMove::Keep,
        move |repo| ops::cherry_pick(repo, &oids),
    )
    .await
}

#[tauri::command]
pub async fn revert(state: State<'_, AppState>, id: String, oid: String) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Revert {}", short(&oid)),
        TipMove::Keep,
        move |repo| ops::revert(repo, &oid),
    )
    .await
}

#[tauri::command]
pub async fn revert_commits(
    state: State<'_, AppState>,
    id: String,
    oids: Vec<String>,
) -> CmdResult<()> {
    let label = format!("Revert {} commits", oids.len());
    undoable(&state, &id, label, TipMove::Keep, move |repo| {
        ops::revert_many(repo, &oids)
    })
    .await
}

#[tauri::command]
pub async fn reset(
    state: State<'_, AppState>,
    id: String,
    oid: String,
    mode: ResetMode,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Reset".to_owned(),
        TipMove::Keep,
        move |repo| ops::reset(repo, &oid, mode),
    )
    .await
}

#[tauri::command]
pub async fn sequence(state: State<'_, AppState>, id: String, action: Sequence) -> CmdResult<()> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let result = ops::sequence(&handle.repo, action);
        if handle.repo.state() == RepoState::Clean {
            let mut history = lock(&handle.history);
            if action == Sequence::Abort {
                history.forget_pending();
            } else if result.is_ok() {
                history.resume(undo::capture(&handle.repo)?);
            }
        }
        result
    })
    .await
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
    undoable(
        &state,
        &id,
        format!("Tag {name}"),
        TipMove::Keep,
        move |repo| ops::create_tag(repo, &name, &at, message.as_deref()),
    )
    .await
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Delete tag {name}"),
        TipMove::Keep,
        move |repo| ops::delete_tag(repo, &name),
    )
    .await
}

#[tauri::command]
pub async fn stash_push(
    state: State<'_, AppState>,
    id: String,
    message: Option<String>,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> CmdResult<()> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let top = |repo: &Repo| {
            repo.output(&["rev-parse", "-q", "--verify", "refs/stash"])
                .map(|o| o.stdout)
        };
        let before = top(&handle.repo)?;
        ops::stash_paths(
            &handle.repo,
            message.as_deref(),
            include_untracked,
            &paths.unwrap_or_default(),
        )?;
        let after = top(&handle.repo)?;
        if after != before && !after.is_empty() {
            let oid = String::from_utf8_lossy(&after).trim().to_owned();
            lock(&handle.history).record(Entry {
                label: "Stash".into(),
                change: Change::StashPush { oid },
            });
        }
        Ok(())
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
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        let info = undo::stash_info(&handle.repo, &stash).ok();
        ops::stash_drop(&handle.repo, &stash)?;
        // Undo puts it back on top, which is where `stash@{0}` came from.
        if let Some((oid, message)) = info.filter(|_| stash == "stash@{0}") {
            lock(&handle.history).record(Entry {
                label: "Delete stash".into(),
                change: Change::StashDrop { oid, message },
            });
        }
        Ok(())
    })
    .await
}

// Submodules, worktrees, LFS and Gitflow

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extras {
    submodules: Vec<Submodule>,
    worktrees: Vec<Worktree>,
    lfs: LfsStatus,
    gitflow: Option<FlowConfig>,
}

/// The left panel's extra sections, loaded with the graph rather than on
/// every file change.
#[tauri::command]
pub async fn extras(state: State<'_, AppState>, id: String) -> CmdResult<Extras> {
    read(&state, &id, |repo| {
        Ok(Extras {
            submodules: submodules::list(repo)?,
            worktrees: worktrees::list(repo)?,
            lfs: lfs::status(repo)?,
            gitflow: gitflow::config(repo)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn submodule_update(
    state: State<'_, AppState>,
    id: String,
    path: Option<String>,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        submodules::update(repo, path.as_deref(), &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn submodule_add(
    state: State<'_, AppState>,
    id: String,
    url: String,
    path: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        submodules::add(repo, &url, &path, &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn worktree_add(
    state: State<'_, AppState>,
    id: String,
    path: PathBuf,
    branch: String,
    create: bool,
    start: Option<String>,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        worktrees::add(repo, &path, &branch, create, start.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn worktree_remove(
    state: State<'_, AppState>,
    id: String,
    path: PathBuf,
    force: bool,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        worktrees::remove(repo, &path, force)
    })
    .await
}

#[tauri::command]
pub async fn worktree_prune(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    write(&state, &id, worktrees::prune).await
}

#[tauri::command]
pub async fn lfs_track(state: State<'_, AppState>, id: String, pattern: String) -> CmdResult<()> {
    write(&state, &id, move |repo| lfs::track(repo, &pattern)).await
}

#[tauri::command]
pub async fn lfs_untrack(state: State<'_, AppState>, id: String, pattern: String) -> CmdResult<()> {
    write(&state, &id, move |repo| lfs::untrack(repo, &pattern)).await
}

#[tauri::command]
pub async fn lfs_install(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    write(&state, &id, lfs::install).await
}

#[tauri::command]
pub async fn lfs_pull(
    state: State<'_, AppState>,
    id: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| lfs::pull(repo, &mut sink)).await
}

#[tauri::command]
pub async fn lfs_prune(
    state: State<'_, AppState>,
    id: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| lfs::prune(repo, &mut sink)).await
}

#[tauri::command]
pub async fn gitflow_init(
    state: State<'_, AppState>,
    id: String,
    config: FlowConfig,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Set up Gitflow".into(),
        TipMove::Keep,
        move |repo| gitflow::init(repo, &config),
    )
    .await
}

#[tauri::command]
pub async fn gitflow_start(
    state: State<'_, AppState>,
    id: String,
    kind: FlowKind,
    name: String,
) -> CmdResult<String> {
    let label = format!("Start {}", flow_label(kind, &name));
    undoable(&state, &id, label, TipMove::Keep, move |repo| {
        gitflow::start(repo, kind, &name)
    })
    .await
}

#[tauri::command]
pub async fn gitflow_finish(
    state: State<'_, AppState>,
    id: String,
    kind: FlowKind,
    name: String,
    tag_message: Option<String>,
) -> CmdResult<()> {
    let label = format!("Finish {}", flow_label(kind, &name));
    undoable(&state, &id, label, TipMove::Keep, move |repo| {
        gitflow::finish(repo, kind, &name, tag_message.as_deref())
    })
    .await
}

fn flow_label(kind: FlowKind, name: &str) -> String {
    let kind = match kind {
        FlowKind::Feature => "feature",
        FlowKind::Release => "release",
        FlowKind::Hotfix => "hotfix",
    };
    format!("{kind} {name}")
}

// File history and blame

#[tauri::command]
pub async fn file_history(
    state: State<'_, AppState>,
    id: String,
    path: String,
    limit: usize,
) -> CmdResult<Vec<FileCommit>> {
    read(&state, &id, move |repo| {
        history::file_history(repo, &path, limit)
    })
    .await
}

#[tauri::command]
pub async fn blame(
    state: State<'_, AppState>,
    id: String,
    path: String,
    rev: Option<String>,
) -> CmdResult<Blame> {
    read(&state, &id, move |repo| {
        history::blame(repo, &path, rev.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn tracked_files(state: State<'_, AppState>, id: String) -> CmdResult<Vec<String>> {
    read(&state, &id, history::tracked_files).await
}

// Merge tool

#[tauri::command]
pub async fn conflict_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<ConflictFile> {
    read(&state, &id, move |repo| conflict::load(repo, &path)).await
}

#[tauri::command]
pub async fn resolve_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
    contents: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        conflict::resolve(repo, &path, &contents)
    })
    .await
}

#[tauri::command]
pub async fn resolve_deleted(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        conflict::resolve_deleted(repo, &path)
    })
    .await
}

#[tauri::command]
pub async fn stash_rename(
    state: State<'_, AppState>,
    id: String,
    stash: String,
    message: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::stash_rename(repo, &stash, &message)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashUntracked {
    /// The commit holding them; diff its files with a `commit` target.
    commit: Option<String>,
    files: Vec<gitcthulhu_core::status::FileChange>,
}

#[tauri::command]
pub async fn stash_untracked(
    state: State<'_, AppState>,
    id: String,
    oid: String,
) -> CmdResult<StashUntracked> {
    read(&state, &id, move |repo| {
        let (commit, files) = ops::stash_untracked(repo, &oid)?;
        Ok(StashUntracked { commit, files })
    })
    .await
}

/// Writes commits (oldest first) or, with no `oids`, the uncommitted changes
/// to a patch file at `path`.
#[tauri::command]
pub async fn save_patch(
    state: State<'_, AppState>,
    id: String,
    oids: Vec<String>,
    path: PathBuf,
) -> CmdResult<()> {
    read(&state, &id, move |repo| {
        let patch = if oids.is_empty() {
            ops::changes_patch(repo)?
        } else {
            ops::format_patch(repo, &oids)?
        };
        std::fs::write(&path, patch)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn apply_patch(
    state: State<'_, AppState>,
    id: String,
    path: PathBuf,
    as_commits: bool,
) -> CmdResult<()> {
    let label = if as_commits {
        "Apply patches"
    } else {
        "Apply patch"
    }
    .to_owned();
    undoable(&state, &id, label, TipMove::Keep, move |repo| {
        ops::apply_patch(repo, &path, as_commits)
    })
    .await
}

// Interactive rebase

#[tauri::command]
pub async fn rebase_plan(
    state: State<'_, AppState>,
    id: String,
    onto: Option<String>,
) -> CmdResult<Vec<PlanCommit>> {
    read(&state, &id, move |repo| rebase::plan(repo, onto.as_deref())).await
}

#[tauri::command]
pub async fn interactive_rebase(
    state: State<'_, AppState>,
    id: String,
    onto: Option<String>,
    steps: Vec<RebaseStep>,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Interactive rebase".to_owned(),
        TipMove::Keep,
        move |repo| rebase::run(repo, onto.as_deref(), &steps),
    )
    .await
}

#[tauri::command]
pub async fn reword_commit(
    state: State<'_, AppState>,
    id: String,
    oid: String,
    message: String,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Edit message".to_owned(),
        TipMove::Keep,
        move |repo| rebase::reword(repo, &oid, &message),
    )
    .await
}

#[tauri::command]
pub async fn drop_commit(state: State<'_, AppState>, id: String, oid: String) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        format!("Drop {}", short(&oid)),
        TipMove::Keep,
        move |repo| rebase::drop_commit(repo, &oid),
    )
    .await
}

#[tauri::command]
pub async fn move_commit(
    state: State<'_, AppState>,
    id: String,
    oid: String,
    up: bool,
) -> CmdResult<()> {
    undoable(
        &state,
        &id,
        "Move commit".to_owned(),
        TipMove::Keep,
        move |repo| rebase::move_commit(repo, &oid, up),
    )
    .await
}

// Undo

#[tauri::command]
pub async fn undo(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        lock(&handle.history).undo(&handle.repo)
    })
    .await
}

#[tauri::command]
pub async fn redo(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let handle = open_repo_handle(&state, &id)?;
    blocking(move || {
        let _guard = lock(&handle.write_lock);
        lock(&handle.history).redo(&handle.repo)
    })
    .await
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

/// Writes git's commit-graph file. It changes nothing other commands read
/// (git takes a lock of its own), so it runs without the write lock: on a
/// long history it can take a minute, and the repository stays usable.
#[tauri::command]
pub async fn write_commit_graph(
    state: State<'_, AppState>,
    id: String,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    read(&state, &id, move |repo| {
        ops::write_commit_graph(repo, &mut sink)
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
    undoable(&state, &id, "Pull".to_owned(), TipMove::Keep, move |repo| {
        ops::pull(repo, mode, &mut sink)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn push(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    branch: String,
    remote_branch: Option<String>,
    set_upstream: bool,
    force: bool,
    on_progress: Channel<String>,
) -> CmdResult<()> {
    let mut sink = progress_sink(on_progress);
    write(&state, &id, move |repo| {
        let options = PushOptions {
            remote: &remote,
            branch: &branch,
            remote_branch: remote_branch.as_deref(),
            set_upstream,
            force,
        };
        ops::push(repo, &options, &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn set_remote_url(
    state: State<'_, AppState>,
    id: String,
    name: String,
    url: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::set_remote_url(repo, &name, &url)
    })
    .await
}

#[tauri::command]
pub async fn rename_remote(
    state: State<'_, AppState>,
    id: String,
    old: String,
    new: String,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::rename_remote(repo, &old, &new)
    })
    .await
}

#[tauri::command]
pub async fn remote_url(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CmdResult<Option<String>> {
    read(&state, &id, move |repo| ops::remote_url(repo, &name)).await
}

#[tauri::command]
pub async fn set_upstream(
    state: State<'_, AppState>,
    id: String,
    branch: String,
    upstream: Option<String>,
) -> CmdResult<()> {
    write(&state, &id, move |repo| {
        ops::set_upstream(repo, &branch, upstream.as_deref())
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

// Embedded terminal

/// Starts the user's shell in the repository. Output streams through
/// `on_output` as raw bytes; `on_exit` gets the exit code once.
#[tauri::command]
pub fn terminal_open(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> CmdResult<u64> {
    let root = open_repo_handle(&state, &id)?.repo.root().to_owned();
    let terminal = Terminal::spawn(
        terminal::default_shell(&root),
        cols,
        rows,
        move |bytes| {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            let _ = on_exit.send(code);
        },
    )?;
    let session = state
        .next_terminal
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut terminals = lock(&state.terminals);
    terminals.insert(session, Arc::new(terminal));
    Ok(session)
}

fn terminal_session(state: &AppState, session: u64) -> CmdResult<Arc<Terminal>> {
    let terminals = lock(&state.terminals);
    terminals
        .get(&session)
        .cloned()
        .ok_or_else(|| CommandError::new("notOpen", "that terminal has closed"))
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, session: u64, data: Vec<u8>) -> CmdResult<()> {
    terminal_session(&state, session)?.write(data);
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session: u64,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    terminal_session(&state, session)?
        .resize(cols, rows)
        .map_err(Into::into)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, session: u64) {
    let removed = {
        let mut terminals = lock(&state.terminals);
        terminals.remove(&session)
    };
    if let Some(terminal) = removed {
        terminal.close();
    }
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

/// Opens a file (or the repository, with no `path`) in the editor from
/// Preferences, or the system's default app when none is set.
#[tauri::command]
pub fn open_in_editor(
    state: State<'_, AppState>,
    id: String,
    path: Option<String>,
) -> CmdResult<()> {
    let root = open_repo_handle(&state, &id)?.repo.root().to_owned();
    let target = match path {
        Some(path) if !path.contains("..") => root.join(path),
        Some(_) => {
            return Err(CommandError::new(
                "invalid",
                "that file is outside the repository",
            ));
        }
        None => root.clone(),
    };
    let editor = {
        let data = lock(&state.data);
        data.settings.editor.trim().to_owned()
    };
    if editor.is_empty() {
        return reveal_or_open(&target);
    }
    let mut words = split_command(&editor);
    let program = words.remove(0);
    let mut cmd = std::process::Command::new(find_program(&program));
    cmd.args(words).arg(&target).current_dir(&root);
    cmd.spawn()
        .map(drop)
        .map_err(|e| CommandError::new("io", format!("couldn't run {program}: {e}")))
}

/// The system's default app for a file; Finder/Explorer for a folder.
fn reveal_or_open(path: &Path) -> CmdResult<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    spawn_detached(program, &[path.as_os_str()])
}

/// Splits `code --wait` or `"My Editor" -n` into words, honoring quotes.
fn split_command(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            (_, c) => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// Editors' command-line launchers often live in Homebrew's folders, which
/// apps started from the Dock don't have on PATH.
fn find_program(name: &str) -> PathBuf {
    if name.contains('/') || name.contains('\\') {
        return PathBuf::from(name);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from);
    std::env::split_paths(&path)
        .chain(extra)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Opens a file's change in the external diff tool from git's `diff.tool`
/// (or `diff.guitool`) setting.
#[tauri::command]
pub async fn open_difftool(
    state: State<'_, AppState>,
    id: String,
    target: DiffTarget,
    path: String,
) -> CmdResult<()> {
    let handle = open_repo_handle(&state, &id)?;
    let repo = handle.repo.clone();
    let configured = blocking(move || {
        Ok(repo
            .config_get("diff.guitool")?
            .or(repo.config_get("diff.tool")?))
    })
    .await?;
    if configured.is_none() {
        return Err(CommandError::new(
            "invalid",
            "set diff.tool in your git config to use an external diff tool",
        ));
    }
    let mut args: Vec<String> = vec!["difftool".into(), "--no-prompt".into(), "--gui".into()];
    match &target {
        DiffTarget::Unstaged => {}
        DiffTarget::Staged => args.push("--cached".into()),
        DiffTarget::Commit { oid } => args.extend([format!("{oid}^"), oid.clone()]),
        DiffTarget::Range { from, to } => args.extend([from.clone(), to.clone()]),
    }
    if args.iter().skip(3).any(|a| a.starts_with('-')) {
        return Err(CommandError::new("invalid", "not a revision"));
    }
    args.extend(["--".into(), path]);
    // The tool runs until it's closed; don't hold the repository meanwhile.
    std::thread::spawn(move || {
        let _ = handle.repo.output(&args);
    });
    Ok(())
}

/// Repositories in and up to four folders below `root`.
#[tauri::command]
pub async fn find_repositories(root: PathBuf) -> CmdResult<Vec<PathBuf>> {
    blocking(move || Ok(gitcthulhu_core::discover::find_repositories(&root, 4, 500))).await
}

/// Adds repositories to the recent list without opening them.
#[tauri::command]
pub fn add_recent(state: State<'_, AppState>, paths: Vec<PathBuf>) -> CmdResult<AppData> {
    let time = now();
    update_data(&state, |data| {
        for path in paths.iter().rev() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            data.touch_recent(path, &name, time);
        }
    })
}

/// Whether a folder is a repository root, for the open dialog's hints.
#[tauri::command]
pub fn looks_like_repo(path: PathBuf) -> bool {
    Path::new(&path).join(".git").exists()
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(super::base64(&[0xff, 0xfe, 0xfd]), "//79");
    }
}
