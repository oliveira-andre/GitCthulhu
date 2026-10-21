//! Undo and redo. An operation records the repository's HEAD and its branch
//! and tag tips before and after it runs. Undo restores the "before" state,
//! redo the "after", but only while nothing else has moved those refs in the
//! meantime: a commit made in a terminal invalidates the history rather
//! than being silently rewound.
//!
//! Commits move back with `reset --soft`, so their changes come back staged.
//! Everything else that moves the checked-out branch uses `reset --keep`,
//! which refuses to overwrite local edits. Discards keep the discarded files'
//! contents so they can be written back.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadState {
    Branch(String),
    Detached(String),
    /// A branch with no commits yet.
    Unborn(String),
}

/// HEAD plus every branch and tag tip (full ref name → object id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefState {
    pub head: HeadState,
    pub refs: BTreeMap<String, String>,
}

impl RefState {
    fn tip(&self, branch: &str) -> Option<&String> {
        self.refs.get(&format!("refs/heads/{branch}"))
    }

    /// The oid HEAD points at, if any.
    fn head_oid(&self) -> Option<&String> {
        match &self.head {
            HeadState::Branch(b) => self.tip(b),
            HeadState::Detached(oid) => Some(oid),
            HeadState::Unborn(_) => None,
        }
    }
}

pub fn capture(repo: &Repo) -> Result<RefState> {
    let text = repo.run_text(&[
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/tags",
    ])?;
    let refs = text
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(name, oid)| (name.to_owned(), oid.to_owned()))
        .collect::<BTreeMap<_, _>>();
    let symbolic = repo.output(&["symbolic-ref", "-q", "HEAD"])?;
    let head = if symbolic.success() {
        let name = String::from_utf8_lossy(&symbolic.stdout)
            .trim()
            .trim_start_matches("refs/heads/")
            .to_owned();
        if refs.contains_key(&format!("refs/heads/{name}")) {
            HeadState::Branch(name)
        } else {
            HeadState::Unborn(name)
        }
    } else {
        HeadState::Detached(repo.run_text(&["rev-parse", "HEAD"])?.trim().to_owned())
    };
    Ok(RefState { head, refs })
}

/// How the checked-out branch moves when undoing or redoing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipMove {
    /// Keep the index and working tree (commits, amends).
    Soft,
    /// Update the files that differ, refusing to touch local edits.
    Keep,
}

/// A working-tree file as it was before a discard: `None` when it didn't exist.
#[derive(Debug, Clone)]
pub struct FileBackup {
    pub path: String,
    pub contents: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub enum Change {
    /// Ref moves only.
    Refs {
        before: RefState,
        after: RefState,
        tip: TipMove,
    },
    /// Working-tree files thrown away; `after` holds them as discarded.
    Files {
        before: Vec<FileBackup>,
        after: Vec<FileBackup>,
    },
    /// A dropped stash, restorable with `git stash store`.
    StashDrop { oid: String, message: String },
    /// A new stash at the top of the list; undo pops it back.
    StashPush { oid: String },
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub label: String,
    pub change: Change,
}

/// Labels for the toolbar: what Undo and Redo would do.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

const LIMIT: usize = 50;

/// One repository's undo and redo stacks, kept for as long as it's open.
#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    /// An operation that stopped on conflicts: recorded once it finishes,
    /// from the state before it started.
    pending: Option<(String, RefState, TipMove)>,
}

impl History {
    /// Remembers where a conflicted merge, rebase or pick started.
    pub fn suspend(&mut self, label: String, before: RefState, tip: TipMove) {
        self.pending = Some((label, before, tip));
    }

    /// The suspended operation finished: record it whole.
    pub fn resume(&mut self, after: RefState) {
        if let Some((label, before, tip)) = self.pending.take() {
            self.record(Entry {
                label,
                change: Change::Refs { before, after, tip },
            });
        }
    }

    /// The suspended operation was aborted.
    pub fn forget_pending(&mut self) {
        self.pending = None;
    }

    pub fn available(&self) -> Available {
        Available {
            undo: self.undo.last().map(|e| e.label.clone()),
            redo: self.redo.last().map(|e| e.label.clone()),
        }
    }

    /// Records a finished operation; a new change ends the redo history.
    pub fn record(&mut self, entry: Entry) {
        if let Change::Refs { before, after, .. } = &entry.change
            && before == after
        {
            return;
        }
        self.undo.push(entry);
        if self.undo.len() > LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.pending = None;
    }

    /// Undoes the latest change and returns its label. If the repository moved
    /// on since, the history no longer applies and is dropped.
    pub fn undo(&mut self, repo: &Repo) -> Result<String> {
        let entry = self
            .undo
            .pop()
            .ok_or_else(|| Error::Invalid("there's nothing to undo".into()))?;
        match apply(repo, &entry.change, Direction::Back) {
            Ok(()) => {
                let label = entry.label.clone();
                self.redo.push(entry);
                Ok(label)
            }
            Err(e @ Error::Invalid(_)) => {
                self.clear();
                Err(e)
            }
            Err(e) => {
                self.undo.push(entry);
                Err(e)
            }
        }
    }

    pub fn redo(&mut self, repo: &Repo) -> Result<String> {
        let entry = self
            .redo
            .pop()
            .ok_or_else(|| Error::Invalid("there's nothing to redo".into()))?;
        match apply(repo, &entry.change, Direction::Forward) {
            Ok(()) => {
                let label = entry.label.clone();
                self.undo.push(entry);
                Ok(label)
            }
            Err(e @ Error::Invalid(_)) => {
                self.clear();
                Err(e)
            }
            Err(e) => {
                self.redo.push(entry);
                Err(e)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Back,
    Forward,
}

fn apply(repo: &Repo, change: &Change, direction: Direction) -> Result<()> {
    match change {
        Change::Refs { before, after, tip } => {
            let (from, to) = match direction {
                Direction::Back => (after, before),
                Direction::Forward => (before, after),
            };
            restore_refs(repo, from, to, *tip)
        }
        Change::Files { before, after } => {
            let (from, to) = match direction {
                Direction::Back => (after, before),
                Direction::Forward => (before, after),
            };
            restore_files(repo, from, to)
        }
        Change::StashDrop { oid, message } => match direction {
            Direction::Back => repo.run(&["stash", "store", "-m", message, oid]).map(drop),
            Direction::Forward => {
                check_top_stash(repo, oid)?;
                repo.run(&["stash", "drop", "-q", "stash@{0}"]).map(drop)
            }
        },
        Change::StashPush { oid } => match direction {
            Direction::Back => {
                check_top_stash(repo, oid)?;
                repo.run(&["stash", "pop", "-q", "--index", "stash@{0}"])
                    .map(drop)
            }
            Direction::Forward => Err(Error::Invalid(
                "stashing again can't be redone exactly; stash the changes yourself".into(),
            )),
        },
    }
}

fn check_top_stash(repo: &Repo, oid: &str) -> Result<()> {
    let out = repo.output(&["rev-parse", "-q", "--verify", "refs/stash"])?;
    if String::from_utf8_lossy(&out.stdout).trim() != oid {
        return Err(changed());
    }
    Ok(())
}

fn changed() -> Error {
    Error::Invalid("the repository changed since, so this can't be undone safely".into())
}

/// Moves the refs from `from` (which must still be current) to `to`.
fn restore_refs(repo: &Repo, from: &RefState, to: &RefState, tip: TipMove) -> Result<()> {
    let now = capture(repo)?;
    let touched: Vec<&String> = from
        .refs
        .keys()
        .chain(to.refs.keys())
        .filter(|k| from.refs.get(*k) != to.refs.get(*k))
        .collect();
    if now.head != from.head
        || touched
            .iter()
            .any(|k| now.refs.get(*k) != from.refs.get(*k))
    {
        return Err(changed());
    }

    let head_branch_ref = match &now.head {
        HeadState::Branch(b) | HeadState::Unborn(b) => Some(format!("refs/heads/{b}")),
        HeadState::Detached(_) => None,
    };
    // 1. Refs that exist in the target, except the checked-out branch, whose
    //    tip moves with the working tree in step 3.
    for name in &touched {
        if Some(*name) == head_branch_ref.as_ref() {
            continue;
        }
        if let Some(oid) = to.refs.get(*name) {
            repo.run(&["update-ref", name.as_str(), oid.as_str()])?;
        }
    }
    // 2. HEAD itself.
    if now.head != to.head {
        match &to.head {
            HeadState::Branch(b) if Some(format!("refs/heads/{b}")) != head_branch_ref => {
                repo.run(&["switch", "-q", b.as_str()])?;
            }
            HeadState::Detached(oid) => {
                repo.run(&["switch", "-q", "--detach", oid.as_str()])?;
            }
            _ => {}
        }
    }
    // 3. The checked-out branch's tip.
    let current = capture(repo)?;
    match (&to.head, current.head_oid(), to.head_oid()) {
        (HeadState::Unborn(b), Some(_), None) => {
            // Back before the first commit: the branch stops existing, and
            // the index keeps the files.
            repo.run(&["update-ref", "-d", &format!("refs/heads/{b}")])?;
        }
        (_, Some(have), Some(want)) if have != want => {
            let flag = match tip {
                TipMove::Soft => "--soft",
                TipMove::Keep => "--keep",
            };
            repo.run(&["reset", "-q", flag, want.as_str()])?;
        }
        (HeadState::Branch(b), None, Some(want)) => {
            // Redoing the first commit.
            repo.run(&["update-ref", &format!("refs/heads/{b}"), want.as_str()])?;
        }
        _ => {}
    }
    // 4. Refs the target doesn't have.
    for name in &touched {
        if !to.refs.contains_key(*name) && capture(repo)?.refs.contains_key(*name) {
            repo.run(&["update-ref", "-d", name.as_str()])?;
        }
    }
    Ok(())
}

/// Saves the working-tree files at `paths`, for undoing a discard. Fails when
/// they're too large to keep in memory.
pub fn backup_files(repo: &Repo, paths: &[String]) -> Result<Vec<FileBackup>> {
    const MAX: usize = 64 * 1024 * 1024;
    let mut total = 0;
    let mut backups = Vec::new();
    for path in paths {
        let full = safe_path(repo, path)?;
        let contents = match std::fs::read(&full) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        total += contents.as_ref().map_or(0, Vec::len);
        if total > MAX {
            return Err(Error::Invalid(
                "these files are too large to keep for undo".into(),
            ));
        }
        backups.push(FileBackup {
            path: path.clone(),
            contents,
        });
    }
    Ok(backups)
}

fn restore_files(repo: &Repo, from: &[FileBackup], to: &[FileBackup]) -> Result<()> {
    // Only restore over files that still look the way the operation left them.
    for expected in from {
        let current = std::fs::read(safe_path(repo, &expected.path)?).ok();
        if current != expected.contents {
            return Err(changed());
        }
    }
    for file in to {
        let full = safe_path(repo, &file.path)?;
        match &file.contents {
            Some(bytes) => {
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&full, bytes)?;
            }
            None => match std::fs::remove_file(&full) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
        }
    }
    Ok(())
}

/// A repository-relative path that can't climb out of the working tree.
fn safe_path(repo: &Repo, path: &str) -> Result<PathBuf> {
    let relative = std::path::Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid(format!("{path} is outside the repository")));
    }
    Ok(repo.root().join(relative))
}

/// The newest stash's id and message, for recording drops and pushes.
pub fn stash_info(repo: &Repo, stash: &str) -> Result<(String, String)> {
    let text = repo.run_text(&["log", "-1", "--format=%H%x1f%gs", "-g", stash, "--"])?;
    let (oid, message) = text
        .trim_end()
        .split_once('\x1f')
        .ok_or_else(|| Error::Parse("unexpected stash entry".into()))?;
    Ok((oid.to_owned(), message.to_owned()))
}
