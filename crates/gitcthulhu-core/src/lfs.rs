//! Git LFS, through the `git lfs` command when it's installed.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// `git lfs version`, or `None` when it isn't installed.
    pub version: Option<String>,
    /// Patterns in `.gitattributes` that LFS stores.
    pub patterns: Vec<String>,
    pub files: Vec<LfsFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub path: String,
    /// The real content is checked out, not just the pointer.
    pub downloaded: bool,
}

pub fn status(repo: &Repo) -> Result<LfsStatus> {
    let version = repo.output(&["lfs", "version"])?;
    if !version.success() {
        return Ok(LfsStatus {
            version: None,
            patterns: Vec::new(),
            files: Vec::new(),
        });
    }
    let version = String::from_utf8_lossy(&version.stdout).trim().to_owned();
    let patterns = patterns(repo)?;
    let mut files = Vec::new();
    if !patterns.is_empty() && repo.head()?.oid.is_some() {
        // `<oid> <*|-> <path>`: `*` means downloaded, `-` only a pointer.
        let out = repo.output(&["lfs", "ls-files"])?;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut parts = line.splitn(3, ' ');
            let (_, marker, path) = (parts.next(), parts.next(), parts.next());
            if let (Some(marker), Some(path)) = (marker, path) {
                files.push(LfsFile {
                    path: path.to_owned(),
                    downloaded: marker == "*",
                });
            }
        }
    }
    Ok(LfsStatus {
        version: Some(version),
        patterns,
        files,
    })
}

/// Reads the LFS patterns straight from `.gitattributes`, which is what
/// `git lfs track` lists.
fn patterns(repo: &Repo) -> Result<Vec<String>> {
    let Ok(text) = std::fs::read_to_string(repo.root().join(".gitattributes")) else {
        return Ok(Vec::new());
    };
    Ok(text
        .lines()
        .filter(|l| l.split_whitespace().any(|a| a == "filter=lfs"))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_owned)
        .collect())
}

/// Stores files matching `pattern` in LFS from now on (edits `.gitattributes`).
pub fn track(repo: &Repo, pattern: &str) -> Result<()> {
    check_pattern(pattern)?;
    repo.run(&["lfs", "track", "--", pattern]).map(drop)
}

pub fn untrack(repo: &Repo, pattern: &str) -> Result<()> {
    check_pattern(pattern)?;
    repo.run(&["lfs", "untrack", "--", pattern]).map(drop)
}

/// Downloads LFS content for the checked-out commit.
pub fn pull(repo: &Repo, progress: &mut dyn FnMut(&str)) -> Result<()> {
    repo.git()
        .run_progress(repo.root(), &["lfs", "pull"], progress)
        .map(drop)
}

/// Deletes old local LFS copies that are already on the remote.
pub fn prune(repo: &Repo, progress: &mut dyn FnMut(&str)) -> Result<()> {
    repo.git()
        .run_progress(repo.root(), &["lfs", "prune"], progress)
        .map(drop)
}

/// Sets up LFS's hooks for this repository.
pub fn install(repo: &Repo) -> Result<()> {
    repo.run(&["lfs", "install", "--local"]).map(drop)
}

fn check_pattern(pattern: &str) -> Result<()> {
    if pattern.trim().is_empty() || pattern.starts_with('-') || pattern.contains('\n') {
        return Err(Error::Invalid(format!("not a file pattern: {pattern}")));
    }
    Ok(())
}
