//! Linked worktrees: more than one checkout of the same repository.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    pub oid: Option<String>,
    /// The checked-out branch's short name; `None` when detached.
    pub branch: Option<String>,
    /// The repository's main working tree, which can't be removed.
    pub main: bool,
    /// The one this repository view is showing.
    pub current: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` forgets it.
    pub prunable: bool,
}

pub fn list(repo: &Repo) -> Result<Vec<Worktree>> {
    let text = repo.run_text(&["worktree", "list", "--porcelain"])?;
    let mut worktrees: Vec<Worktree> = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut tree = Worktree {
            path: PathBuf::new(),
            oid: None,
            branch: None,
            main: worktrees.is_empty(),
            current: false,
            locked: false,
            prunable: false,
        };
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => tree.path = PathBuf::from(value),
                "HEAD" => tree.oid = Some(value.to_owned()),
                "branch" => tree.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
                "locked" => tree.locked = true,
                "prunable" => tree.prunable = true,
                _ => {}
            }
        }
        tree.current = same_path(&tree.path, repo.root());
        worktrees.push(tree);
    }
    Ok(worktrees)
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Checks out `branch` in a new worktree at `path`. With `create`, the
/// branch is made first, at `start` (HEAD when `None`).
pub fn add(
    repo: &Repo,
    path: &Path,
    branch: &str,
    create: bool,
    start: Option<&str>,
) -> Result<()> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(Error::Invalid(format!("not a branch name: {branch}")));
    }
    let path = path.to_string_lossy().into_owned();
    if path.starts_with('-') {
        return Err(Error::Invalid(format!("not a folder: {path}")));
    }
    let mut args = vec!["worktree".to_owned(), "add".to_owned()];
    if create {
        args.extend(["-b".to_owned(), branch.to_owned(), "--".to_owned(), path]);
        if let Some(start) = start {
            crate::inspect::check_revision(start)?;
            args.push(start.to_owned());
        }
    } else {
        args.extend(["--".to_owned(), path, branch.to_owned()]);
    }
    repo.run(&args).map(drop)
}

/// Removes a linked worktree. Without `force`, git refuses when it has
/// uncommitted changes.
pub fn remove(repo: &Repo, path: &Path, force: bool) -> Result<()> {
    let path = path.to_string_lossy().into_owned();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", path.as_str()]);
    repo.run(&args).map(drop)
}

pub fn prune(repo: &Repo) -> Result<()> {
    repo.run(&["worktree", "prune"]).map(drop)
}
