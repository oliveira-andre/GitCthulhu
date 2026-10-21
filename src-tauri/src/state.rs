use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gitcthulhu_core::askpass::{AskpassServer, Prompt};
use gitcthulhu_core::store::AppData;
use gitcthulhu_core::terminal::Terminal;
use gitcthulhu_core::undo::History;
use gitcthulhu_core::watch::RepoWatcher;
use gitcthulhu_core::{Git, Repo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Sends an event to the UI. Kept as a closure so commands don't depend on
/// the runtime type, which lets tests drive them on Tauri's mock runtime.
pub type Emit = Arc<dyn Fn(&str, serde_json::Value) -> bool + Send + Sync>;

pub struct AppState {
    pub git: Result<Git, String>,
    pub data_path: PathBuf,
    pub data: Mutex<AppData>,
    /// Open repositories by id (their root path).
    pub repos: Mutex<HashMap<String, OpenRepo>>,
    pub prompts: Arc<Prompts>,
    pub emit: Emit,
    /// Embedded terminals by session id.
    pub terminals: Mutex<HashMap<u64, Arc<Terminal>>>,
    pub next_terminal: AtomicU64,
    _askpass: Option<AskpassServer>,
}

pub struct OpenRepo {
    pub handle: RepoHandle,
    pub _watcher: Option<RepoWatcher>,
}

/// What a command needs of an open repository.
#[derive(Clone)]
pub struct RepoHandle {
    pub repo: Repo,
    /// Changes run one at a time per repository; reads don't wait. Take it
    /// before `history`.
    pub write_lock: Arc<Mutex<()>>,
    pub history: Arc<Mutex<History>>,
}

/// Credential prompts waiting for the user, by prompt id.
#[derive(Default)]
pub struct Prompts {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<Option<String>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    id: u64,
    #[serde(flatten)]
    prompt: Prompt,
}

/// How long a git command waits for the user to answer a prompt.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

impl Prompts {
    fn ask(&self, emit: &Emit, prompt: Prompt) -> Option<String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut waiting = self.waiting.lock().unwrap();
            waiting.insert(id, tx);
        }
        let event = serde_json::to_value(PromptEvent { id, prompt }).unwrap_or_default();
        let answer = if emit("askpass-prompt", event) {
            rx.recv_timeout(PROMPT_TIMEOUT).ok().flatten()
        } else {
            None
        };
        let mut waiting = self.waiting.lock().unwrap();
        waiting.remove(&id);
        answer
    }

    pub fn answer(&self, id: u64, answer: Option<String>) {
        let sender = {
            let waiting = self.waiting.lock().unwrap();
            waiting.get(&id).cloned()
        };
        if let Some(sender) = sender {
            let _ = sender.send(answer);
        }
    }
}

impl AppState {
    /// App data lives in the platform's app data folder, or in
    /// `GITCTHULHU_DATA_DIR` when set (tests use that).
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<AppState, Box<dyn std::error::Error>> {
        let data_dir = match std::env::var_os("GITCTHULHU_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => app.path().app_data_dir()?,
        };
        let handle = app.clone();
        let emit: Emit = Arc::new(move |event, payload| handle.emit(event, payload).is_ok());
        let git = Git::find().map_err(|e| e.to_string());
        Ok(AppState::open(&data_dir, git, emit)?)
    }

    pub fn open(
        data_dir: &Path,
        git: Result<Git, String>,
        emit: Emit,
    ) -> std::io::Result<AppState> {
        std::fs::create_dir_all(data_dir)?;
        let data_path = data_dir.join("state.json");
        let data = AppData::load(&data_path).unwrap_or_default();

        let prompts = Arc::new(Prompts::default());
        let asker = prompts.clone();
        let ask_emit = emit.clone();
        let askpass =
            AskpassServer::start(Arc::new(move |prompt| asker.ask(&ask_emit, prompt))).ok();

        let git = git.map(|git| match (&askpass, std::env::current_exe()) {
            (Some(server), Ok(exe)) => server.configure(git, &exe),
            _ => git,
        });
        Ok(AppState {
            git,
            data_path,
            data: Mutex::new(data),
            repos: Mutex::new(HashMap::new()),
            prompts,
            emit,
            terminals: Mutex::new(HashMap::new()),
            next_terminal: AtomicU64::new(1),
            _askpass: askpass,
        })
    }

    pub fn save_data(&self, data: &AppData) -> gitcthulhu_core::Result<()> {
        data.save(&self.data_path)
    }

    pub fn repo(&self, id: &str) -> Option<RepoHandle> {
        let repos = self.repos.lock().unwrap();
        repos.get(id).map(|open| open.handle.clone())
    }

    pub fn is_open(&self, root: &Path) -> bool {
        let repos = self.repos.lock().unwrap();
        repos.contains_key(&root.to_string_lossy().into_owned())
    }
}
