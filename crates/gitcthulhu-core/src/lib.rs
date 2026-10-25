//! GitCthulhu's core: everything that touches a repository, with no UI
//! dependency. All repository access goes through the git command line.

pub mod askpass;
pub mod conflict;
pub mod diff;
pub mod discover;
pub mod error;
pub mod git;
pub mod gitflow;
pub mod graph;
pub mod history;
pub mod inspect;
pub mod lfs;
pub mod log;
pub mod ops;
pub mod profile;
pub mod rebase;
pub mod refs;
pub mod repo;
pub mod status;
pub mod store;
pub mod submodules;
pub mod symbols;
pub mod terminal;
pub mod undo;
pub mod watch;
pub mod worktrees;

pub use error::{Error, Result};
pub use git::Git;
pub use repo::Repo;

use std::ffi::OsStr;
use std::path::Path;

/// Clones `url` into `dest`, which must not exist or be empty.
pub fn clone(git: &Git, url: &str, dest: &Path, progress: &mut dyn FnMut(&str)) -> Result<Repo> {
    clone_with(git, url, dest, &CloneOptions::default(), progress)
}

#[derive(Debug, Clone, Default, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneOptions {
    /// Only this many commits of history (`--depth`).
    pub depth: Option<u32>,
    /// Check out this branch instead of the remote's default.
    pub branch: Option<String>,
    /// Fetch only that branch (`--single-branch`).
    pub single_branch: bool,
    /// Also clone the submodules (`--recurse-submodules`).
    pub recurse_submodules: bool,
}

pub fn clone_with(
    git: &Git,
    url: &str,
    dest: &Path,
    options: &CloneOptions,
    progress: &mut dyn FnMut(&str),
) -> Result<Repo> {
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(Error::Invalid(format!("not a repository URL: {url}")));
    }
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut args: Vec<std::ffi::OsString> = vec!["clone".into(), "--progress".into()];
    if let Some(depth) = options.depth.filter(|d| *d > 0) {
        args.push(format!("--depth={depth}").into());
    }
    if let Some(branch) = options
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        if branch.starts_with('-') {
            return Err(Error::Invalid(format!("not a branch name: {branch}")));
        }
        args.push(format!("--branch={branch}").into());
    }
    if options.single_branch {
        args.push("--single-branch".into());
    }
    if options.recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.extend([
        OsStr::new("--").to_owned(),
        OsStr::new(url).to_owned(),
        dest.as_os_str().to_owned(),
    ]);
    git.run_progress(parent, &args, progress)?;
    Repo::open(git, dest)
}
