//! The working tree's changes, from `git status --porcelain=v2`.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::split_nul;
use crate::repo::Repo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Renames and copies: where it came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    /// Conflicts: git's two-letter code, for example `UU` or `AA`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// A submodule rather than a file.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub submodule: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

impl WorkingStatus {
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty()
    }
}

pub fn status(repo: &Repo) -> Result<WorkingStatus> {
    let out = repo.run(&["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
    parse(&out)
}

fn kind(code: u8) -> Option<ChangeKind> {
    Some(match code {
        b'A' => ChangeKind::Added,
        b'M' => ChangeKind::Modified,
        b'D' => ChangeKind::Deleted,
        b'R' => ChangeKind::Renamed,
        b'C' => ChangeKind::Copied,
        b'T' => ChangeKind::TypeChanged,
        _ => return None,
    })
}

pub(crate) fn parse(out: &[u8]) -> Result<WorkingStatus> {
    let mut status = WorkingStatus::default();
    let mut records = split_nul(out);
    while let Some(record) = records.next() {
        let text = String::from_utf8_lossy(record);
        let bad = || Error::Parse(format!("unexpected status entry: {text}"));
        match record[0] {
            b'1' | b'2' => {
                // `1 XY sub mH mI mW hH hI path`, `2 … Xscore path` then the old path.
                let fixed = if record[0] == b'1' { 8 } else { 9 };
                let mut parts = text.splitn(fixed + 1, ' ');
                let xy = parts.nth(1).ok_or_else(bad)?.as_bytes().to_vec();
                let submodule = parts.next().is_some_and(|s| s.starts_with('S'));
                let path = parts.nth(fixed - 3).ok_or_else(bad)?.to_owned();
                let old_path = if record[0] == b'2' {
                    Some(String::from_utf8_lossy(records.next().ok_or_else(bad)?).into_owned())
                } else {
                    None
                };
                if xy.len() != 2 {
                    return Err(bad());
                }
                let change = |code: u8| {
                    kind(code).map(|kind| FileChange {
                        path: path.clone(),
                        old_path: old_path
                            .clone()
                            .filter(|_| matches!(kind, ChangeKind::Renamed | ChangeKind::Copied)),
                        kind,
                        conflict: None,
                        submodule,
                    })
                };
                status.staged.extend(change(xy[0]));
                status.unstaged.extend(change(xy[1]));
            }
            b'u' => {
                // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
                let mut parts = text.splitn(11, ' ');
                let xy = parts.nth(1).ok_or_else(bad)?.to_owned();
                let path = parts.nth(8).ok_or_else(bad)?.to_owned();
                status.conflicted.push(FileChange {
                    path,
                    old_path: None,
                    kind: ChangeKind::Conflicted,
                    conflict: Some(xy),
                    submodule: false,
                });
            }
            b'?' => status.unstaged.push(FileChange {
                path: text[2..].to_owned(),
                old_path: None,
                kind: ChangeKind::Untracked,
                conflict: None,
                submodule: false,
            }),
            _ => {} // `!` ignored files and `#` headers
        }
    }
    status.unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    status.staged.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_entry_type() {
        let out = b"1 .M N... 100644 100644 100644 aaa bbb src/a b.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\0old.txt\0\
1 AM N... 000000 100644 100644 000 bbb added.txt\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? untracked dir/file.txt\0";
        let status = parse(out).unwrap();
        assert_eq!(
            status
                .staged
                .iter()
                .map(|c| (c.path.as_str(), c.kind))
                .collect::<Vec<_>>(),
            [
                ("added.txt", ChangeKind::Added),
                ("new.txt", ChangeKind::Renamed)
            ]
        );
        assert_eq!(status.staged[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(
            status
                .unstaged
                .iter()
                .map(|c| (c.path.as_str(), c.kind))
                .collect::<Vec<_>>(),
            [
                ("added.txt", ChangeKind::Modified),
                ("src/a b.rs", ChangeKind::Modified),
                ("untracked dir/file.txt", ChangeKind::Untracked)
            ]
        );
        assert_eq!(status.conflicted[0].path, "conflict.txt");
        assert_eq!(status.conflicted[0].conflict.as_deref(), Some("UU"));
    }
}
