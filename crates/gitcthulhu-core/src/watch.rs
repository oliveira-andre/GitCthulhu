//! Notices changes to a repository made outside the app (an editor saving,
//! git in a terminal) so the UI can refresh.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::Result;
use crate::repo::Repo;

/// What changed, after a quiet period.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Change {
    /// Branches, tags, HEAD, stashes or an operation's state.
    pub refs: bool,
    /// Files in the working tree or the index.
    pub files: bool,
}

/// Stops watching when dropped.
pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
}

const QUIET: Duration = Duration::from_millis(300);

pub fn watch(repo: &Repo, on_change: impl Fn(Change) + Send + 'static) -> Result<RepoWatcher> {
    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = event {
            let _ = tx.send(event);
        }
    })?;
    let root = repo.root().to_owned();
    watcher.watch(&root, RecursiveMode::Recursive)?;
    // Linked worktrees keep their git data elsewhere.
    let mut git_dirs = vec![repo.git_dir().to_owned(), repo.common_dir().to_owned()];
    git_dirs.dedup();
    for dir in &git_dirs {
        if !dir.starts_with(&root) {
            watcher.watch(dir, RecursiveMode::Recursive)?;
        }
    }

    let repo = repo.clone();
    std::thread::spawn(move || {
        // Ends when the watcher (and with it the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut events = vec![first];
            loop {
                match rx.recv_timeout(QUIET) {
                    Ok(event) => events.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let change = classify(&repo, &git_dirs, &events);
            if change != Change::default() {
                on_change(change);
            }
        }
    });
    Ok(RepoWatcher { _watcher: watcher })
}

fn classify(repo: &Repo, git_dirs: &[PathBuf], events: &[Event]) -> Change {
    let mut change = Change::default();
    let mut files = BTreeSet::new();
    for event in events {
        if matches!(event.kind, EventKind::Access(_)) {
            continue;
        }
        for path in &event.paths {
            if let Some(inside) = git_dirs.iter().find_map(|dir| path.strip_prefix(dir).ok()) {
                match git_path_effect(inside) {
                    GitPathEffect::Refs => change.refs = true,
                    GitPathEffect::Index => change.files = true,
                    GitPathEffect::None => {}
                }
            } else if let Ok(relative) = path.strip_prefix(repo.root()) {
                files.insert(relative.to_owned());
            }
        }
    }
    if !change.files && !files.is_empty() && !all_ignored(repo, &files) {
        change.files = true;
    }
    change
}

enum GitPathEffect {
    Refs,
    Index,
    None,
}

fn git_path_effect(path: &Path) -> GitPathEffect {
    let first = path.components().next().and_then(|c| match c {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.ends_with(".lock") {
        return GitPathEffect::None;
    }
    match first {
        Some("objects" | "logs" | "hooks" | "info" | "lfs" | "modules" | "fsmonitor--daemon") => {
            GitPathEffect::None
        }
        Some("index") => GitPathEffect::Index,
        Some(
            "refs" | "packed-refs" | "HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD"
            | "ORIG_HEAD" | "FETCH_HEAD" | "rebase-merge" | "rebase-apply" | "BISECT_LOG"
            | "worktrees" | "config",
        ) => GitPathEffect::Refs,
        _ => GitPathEffect::None,
    }
}

/// True when every changed path is ignored by git, for example build output.
fn all_ignored(repo: &Repo, files: &BTreeSet<PathBuf>) -> bool {
    // A big batch (a build, a checkout) is cheaper to just refresh.
    if files.len() > 500 {
        return false;
    }
    let mut input = Vec::new();
    for file in files {
        input.extend_from_slice(file.to_string_lossy().as_bytes());
        input.push(0);
    }
    let Ok(out) = repo.git().output(
        repo.root(),
        &["check-ignore", "-z", "--stdin"],
        Some(&input),
    ) else {
        return false;
    };
    let ignored = out
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .count();
    ignored == files.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_internals_are_sorted_by_effect() {
        assert!(matches!(
            git_path_effect(Path::new("refs/heads/main")),
            GitPathEffect::Refs
        ));
        assert!(matches!(
            git_path_effect(Path::new("HEAD")),
            GitPathEffect::Refs
        ));
        assert!(matches!(
            git_path_effect(Path::new("index")),
            GitPathEffect::Index
        ));
        assert!(matches!(
            git_path_effect(Path::new("objects/ab/cdef")),
            GitPathEffect::None
        ));
        assert!(matches!(
            git_path_effect(Path::new("refs/heads/main.lock")),
            GitPathEffect::None
        ));
    }
}
