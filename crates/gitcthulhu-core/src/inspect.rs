//! Read-only questions about commits and files: details, changed files and
//! diffs.

use serde::{Deserialize, Serialize};

use crate::diff::{self, FileDiff, MAX_DIFF_BYTES};
use crate::error::{Error, Result};
use crate::git::{lossy, split_nul};
use crate::repo::Repo;
use crate::status::{ChangeKind, FileChange};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub summary: String,
    pub body: String,
    /// Compared with the first parent, or with nothing for a root commit.
    pub files: Vec<FileChange>,
}

const DETAILS_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B";

pub fn commit_details(repo: &Repo, oid: &str) -> Result<CommitDetails> {
    check_revision(oid)?;
    let out = repo.run(&["show", "-s", DETAILS_FORMAT, oid, "--"])?;
    let text = lossy(&out);
    let fields: Vec<&str> = text.splitn(9, '\0').collect();
    let [
        oid,
        parents,
        author,
        email,
        author_time,
        committer,
        committer_email,
        commit_time,
        message,
    ] = fields[..]
    else {
        return Err(Error::Parse("unexpected commit details".into()));
    };
    let parents: Vec<String> = parents.split_whitespace().map(str::to_owned).collect();
    let message = message.trim_end();
    let (summary, body) = match message.split_once('\n') {
        Some((summary, body)) => (summary.to_owned(), body.trim_start_matches('\n').to_owned()),
        None => (message.to_owned(), String::new()),
    };
    let files = changed_files(repo, parents.first().map(String::as_str), oid)?;
    Ok(CommitDetails {
        oid: oid.to_owned(),
        parents,
        author: author.to_owned(),
        email: email.to_owned(),
        author_time: author_time.parse().unwrap_or(0),
        committer: committer.to_owned(),
        committer_email: committer_email.to_owned(),
        commit_time: commit_time.parse().unwrap_or(0),
        summary,
        body,
        files,
    })
}

/// Files changed between two commits; `from: None` lists a root commit's files.
pub fn changed_files(repo: &Repo, from: Option<&str>, to: &str) -> Result<Vec<FileChange>> {
    check_revision(to)?;
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--name-status",
        "--no-commit-id",
    ];
    match from {
        Some(from) => {
            check_revision(from)?;
            args.push(from);
        }
        None => args.push("--root"),
    }
    args.push(to);
    let out = repo.run(&args)?;
    Ok(parse_name_status(&out))
}

fn parse_name_status(out: &[u8]) -> Vec<FileChange> {
    let mut files = Vec::new();
    let mut parts = split_nul(out);
    while let Some(status) = parts.next() {
        let code = status.first().copied().unwrap_or(b'M');
        let kind = match code {
            b'A' => ChangeKind::Added,
            b'D' => ChangeKind::Deleted,
            b'R' => ChangeKind::Renamed,
            b'C' => ChangeKind::Copied,
            b'T' => ChangeKind::TypeChanged,
            b'U' => ChangeKind::Conflicted,
            _ => ChangeKind::Modified,
        };
        let first = parts.next().map(lossy).unwrap_or_default();
        let (path, old_path) = if matches!(kind, ChangeKind::Renamed | ChangeKind::Copied) {
            (parts.next().map(lossy).unwrap_or_default(), Some(first))
        } else {
            (first, None)
        };
        files.push(FileChange {
            path,
            old_path,
            kind,
            conflict: None,
            submodule: false,
        });
    }
    files
}

/// Which version of a file a diff compares.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DiffTarget {
    /// The working tree against the index.
    Unstaged,
    /// The index against HEAD.
    Staged,
    /// A commit against its first parent.
    Commit { oid: String },
    /// Two commits.
    Range { from: String, to: String },
}

pub fn file_diff(
    repo: &Repo,
    target: &DiffTarget,
    path: &str,
    old_path: Option<&str>,
    context: u32,
) -> Result<FileDiff> {
    file_diff_with(repo, target, path, old_path, context, false)
}

/// Like [`file_diff`]; `ignore_whitespace` (`-w`) is for reading only, since
/// patches built from such a diff don't apply to the real file.
pub fn file_diff_with(
    repo: &Repo,
    target: &DiffTarget,
    path: &str,
    old_path: Option<&str>,
    context: u32,
    ignore_whitespace: bool,
) -> Result<FileDiff> {
    let unified = format!("-U{context}");
    let mut args: Vec<String> = vec![
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-color".into(),
        "-M".into(),
        unified.clone(),
    ];
    match target {
        DiffTarget::Unstaged => {
            if is_untracked(repo, path)? {
                return untracked_diff(repo, path, &unified);
            }
        }
        DiffTarget::Staged => args.push("--cached".into()),
        DiffTarget::Commit { oid } => {
            check_revision(oid)?;
            let parent = format!("{oid}^");
            if repo
                .output(&[
                    "rev-parse",
                    "-q",
                    "--verify",
                    &format!("{parent}^{{commit}}"),
                ])?
                .success()
            {
                args.extend([parent, oid.clone()]);
            } else {
                // A root commit: show everything it added.
                args = vec![
                    "diff-tree".into(),
                    "-p".into(),
                    "--no-color".into(),
                    "--root".into(),
                    "-M".into(),
                    unified,
                    oid.clone(),
                ];
            }
        }
        DiffTarget::Range { from, to } => {
            check_revision(from)?;
            check_revision(to)?;
            args.extend([from.clone(), to.clone()]);
        }
    }
    if ignore_whitespace {
        args.push("-w".into());
    }
    args.push("--".into());
    if let Some(old) = old_path.filter(|o| *o != path) {
        args.push(old.into());
    }
    args.push(path.into());
    let out = repo.run(&args)?;
    Ok(pick(&out, path, old_path))
}

fn is_untracked(repo: &Repo, path: &str) -> Result<bool> {
    let out = repo.run(&[
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--",
        path,
    ])?;
    Ok(!out.is_empty())
}

fn untracked_diff(repo: &Repo, path: &str, unified: &str) -> Result<FileDiff> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    // --no-index exits with 1 when the files differ, which they always do.
    let out = repo.output(&[
        "diff",
        "--no-ext-diff",
        "--no-color",
        unified,
        "--no-index",
        "--",
        null,
        path,
    ])?;
    if out.code.is_some_and(|c| c > 1) {
        return Err(Error::Git {
            command: "diff".into(),
            code: out.code,
            stderr: out.stderr,
        });
    }
    let mut file = pick(&out.stdout, path, None);
    file.new_file = true;
    Ok(file)
}

fn pick(out: &[u8], path: &str, old_path: Option<&str>) -> FileDiff {
    let empty = || FileDiff {
        path: path.to_owned(),
        old_path: old_path.map(str::to_owned),
        header: String::new(),
        binary: false,
        new_file: false,
        deleted_file: false,
        hunks: Vec::new(),
        too_large: false,
    };
    if out.len() > MAX_DIFF_BYTES {
        return FileDiff {
            too_large: true,
            ..empty()
        };
    }
    let text = lossy(out);
    let files = diff::parse(&text);
    files
        .iter()
        .find(|f| f.path == path)
        .or(files.first())
        .cloned()
        .unwrap_or_else(empty)
}

/// Refuses anything that git could read as an option.
pub(crate) fn check_revision(rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains(['\0', '\n']) {
        return Err(Error::Invalid(format!("not a revision: {rev}")));
    }
    Ok(())
}

/// Where to read a file's contents from, for image diffs.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BlobSource {
    Worktree,
    Index,
    Revision { rev: String },
}

/// A file's bytes, or `None` when it doesn't exist there. Refuses files
/// larger than `max` bytes.
pub fn blob(repo: &Repo, source: &BlobSource, path: &str, max: usize) -> Result<Option<Vec<u8>>> {
    let relative = std::path::Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid(format!(
            "not a file in the repository: {path}"
        )));
    }
    let bytes = match source {
        BlobSource::Worktree => match std::fs::read(repo.root().join(relative)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        },
        BlobSource::Index | BlobSource::Revision { .. } => {
            let spec = match source {
                BlobSource::Revision { rev } => {
                    check_revision(rev)?;
                    format!("{rev}:{path}")
                }
                _ => format!(":{path}"),
            };
            let out = repo.output(&["cat-file", "blob", &spec])?;
            if !out.success() {
                return Ok(None);
            }
            out.stdout
        }
    };
    if bytes.len() > max {
        return Err(Error::Invalid("the file is too large to show".into()));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_with_renames() {
        let out = b"M\0src/a.rs\0R087\0old.rs\0new.rs\0A\0b c.txt\0";
        let files = parse_name_status(out);
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].kind, ChangeKind::Renamed);
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[1].old_path.as_deref(), Some("old.rs"));
        assert_eq!(files[2].path, "b c.txt");
    }

    #[test]
    fn option_like_revisions_are_refused() {
        assert!(check_revision("--output=/tmp/x").is_err());
        assert!(check_revision("abc123").is_ok());
    }
}
