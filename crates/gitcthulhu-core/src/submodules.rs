//! Submodules: list them, bring them up to date, add new ones.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    /// Checked out at the commit the superproject records.
    Current,
    /// Checked out at a different commit.
    Changed,
    /// Not checked out yet (`git submodule update --init`).
    Uninitialized,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    pub name: String,
    pub url: Option<String>,
    /// The commit it's checked out at (or recorded at, when uninitialized).
    pub oid: String,
    pub state: SubmoduleState,
}

pub fn list(repo: &Repo) -> Result<Vec<Submodule>> {
    if !repo.root().join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let config = repo.output(&[
        "config",
        "-f",
        ".gitmodules",
        "--get-regexp",
        r"^submodule\..*\.(path|url)$",
    ])?;
    let mut entries: Vec<(String, String, Option<String>)> = Vec::new(); // name, path, url
    for line in String::from_utf8_lossy(&config.stdout).lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };
        let (name, field) = match rest.rsplit_once('.') {
            Some(pair) => pair,
            None => continue,
        };
        let index = match entries.iter().position(|e| e.0 == name) {
            Some(i) => i,
            None => {
                entries.push((name.to_owned(), String::new(), None));
                entries.len() - 1
            }
        };
        match field {
            "path" => entries[index].1 = value.to_owned(),
            "url" => entries[index].2 = Some(value.to_owned()),
            _ => {}
        }
    }

    let status = repo.output(&["submodule", "status"])?;
    let status_text = String::from_utf8_lossy(&status.stdout);
    let mut submodules = Vec::new();
    for (name, path, url) in entries.into_iter().filter(|e| !e.1.is_empty()) {
        // `<flag><oid> <path> (<describe>)`
        let line = status_text
            .lines()
            .find(|l| l.get(1..).and_then(|r| r.split_whitespace().nth(1)) == Some(path.as_str()));
        let (state, oid) = match line {
            Some(l) => {
                let state = match l.chars().next() {
                    Some('-') => SubmoduleState::Uninitialized,
                    Some('+') => SubmoduleState::Changed,
                    Some('U') => SubmoduleState::Conflicted,
                    _ => SubmoduleState::Current,
                };
                (
                    state,
                    l[1..]
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_owned(),
                )
            }
            None => (SubmoduleState::Uninitialized, String::new()),
        };
        submodules.push(Submodule {
            path,
            name,
            url,
            oid,
            state,
        });
    }
    Ok(submodules)
}

/// Checks out the recorded commit, initializing (and cloning) it first if
/// needed; `None` updates every submodule.
pub fn update(repo: &Repo, path: Option<&str>, progress: &mut dyn FnMut(&str)) -> Result<()> {
    let mut args = vec!["submodule", "update", "--init", "--recursive", "--progress"];
    if let Some(path) = path {
        check_path(path)?;
        args.extend(["--", path]);
    }
    repo.git()
        .run_progress(repo.root(), &args, progress)
        .map(drop)
}

pub fn add(repo: &Repo, url: &str, path: &str, progress: &mut dyn FnMut(&str)) -> Result<()> {
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(Error::Invalid(format!("not a repository URL: {url}")));
    }
    check_path(path)?;
    repo.git()
        .run_progress(
            repo.root(),
            &["submodule", "add", "--progress", "--", url, path],
            progress,
        )
        .map(drop)
}

fn check_path(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('-') || path.contains("..") {
        return Err(Error::Invalid(format!("not a submodule path: {path}")));
    }
    Ok(())
}
