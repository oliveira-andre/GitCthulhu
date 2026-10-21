//! A file's history (following renames) and line-by-line blame.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::{lossy, split_nul};
use crate::inspect::check_revision;
use crate::repo::Repo;
use crate::status::ChangeKind;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    pub oid: String,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub subject: String,
    /// The file's path in this commit (it changes across renames).
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub kind: ChangeKind,
}

/// The commits that changed `path`, newest first, following renames.
pub fn file_history(repo: &Repo, path: &str, limit: usize) -> Result<Vec<FileCommit>> {
    if path.is_empty() || path.starts_with('-') {
        return Err(Error::Invalid(format!("not a file path: {path}")));
    }
    let max = format!("--max-count={}", limit.max(1));
    let out = repo.run(&[
        "log",
        "--follow",
        "-M",
        "--name-status",
        "-z",
        "--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s",
        &max,
        "--",
        path,
    ])?;
    let text = lossy(&out);
    let mut commits = Vec::new();
    for record in text.split('\x1e').filter(|r| !r.is_empty()) {
        // The header ends at a newline; -z separates the name-status fields.
        let (header, changes) = record.split_once('\n').unwrap_or((record, ""));
        let fields: Vec<&str> = header.trim_end_matches('\0').split('\x1f').collect();
        let [oid, author, email, time, subject] = fields[..] else {
            return Err(Error::Parse(format!("unexpected log header: {header}")));
        };
        let mut parts = split_nul(changes.as_bytes())
            .map(lossy)
            .filter(|p| !p.trim().is_empty());
        let status = parts.next().unwrap_or_else(|| "M".into());
        let kind = match status.trim().chars().next() {
            Some('A') => ChangeKind::Added,
            Some('D') => ChangeKind::Deleted,
            Some('R') => ChangeKind::Renamed,
            Some('C') => ChangeKind::Copied,
            Some('T') => ChangeKind::TypeChanged,
            _ => ChangeKind::Modified,
        };
        let first = parts.next().unwrap_or_else(|| path.to_owned());
        let (path, old_path) = if matches!(kind, ChangeKind::Renamed | ChangeKind::Copied) {
            (parts.next().unwrap_or_else(|| first.clone()), Some(first))
        } else {
            (first, None)
        };
        commits.push(FileCommit {
            oid: oid.to_owned(),
            author: author.to_owned(),
            email: email.to_owned(),
            author_time: time.parse().unwrap_or(0),
            subject: subject.to_owned(),
            path,
            old_path,
            kind,
        });
    }
    Ok(commits)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub oid: String,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub lines: Vec<BlameLine>,
    /// Each commit that appears, once.
    pub commits: Vec<BlameCommit>,
}

/// Who last changed each line of `path`, as of `rev` (HEAD when `None`).
/// Uncommitted lines get the all-zero id.
pub fn blame(repo: &Repo, path: &str, rev: Option<&str>) -> Result<Blame> {
    if path.is_empty() || path.starts_with('-') {
        return Err(Error::Invalid(format!("not a file path: {path}")));
    }
    let mut args = vec!["blame", "--porcelain", "-M"];
    if let Some(rev) = rev {
        check_revision(rev)?;
        args.push(rev);
    }
    args.extend(["--", path]);
    let out = repo.run(&args)?;
    parse_porcelain(&lossy(&out))
}

fn parse_porcelain(text: &str) -> Result<Blame> {
    let mut lines = Vec::new();
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            let (oid, number) = current
                .take()
                .ok_or_else(|| Error::Parse("blame line without a header".into()))?;
            lines.push(BlameLine {
                oid,
                line: number,
                text: content.to_owned(),
            });
            continue;
        }
        let mut words = line.split(' ');
        let first = words.next().unwrap_or_default();
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            let number = words.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            if !commits.iter().any(|c| c.oid == first) {
                commits.push(BlameCommit {
                    oid: first.to_owned(),
                    author: String::new(),
                    email: String::new(),
                    author_time: 0,
                    summary: String::new(),
                });
            }
            current = Some((first.to_owned(), number));
            continue;
        }
        let Some((oid, _)) = &current else { continue };
        let Some(commit) = commits.iter_mut().find(|c| &c.oid == oid) else {
            continue;
        };
        let rest = line.split_once(' ').map(|(_, r)| r).unwrap_or_default();
        match first {
            "author" => commit.author = rest.to_owned(),
            "author-mail" => commit.email = rest.trim_matches(['<', '>']).to_owned(),
            "author-time" => commit.author_time = rest.parse().unwrap_or(0),
            "summary" => commit.summary = rest.to_owned(),
            _ => {}
        }
    }
    Ok(Blame { lines, commits })
}

/// Every tracked file, for the file-history finder.
pub fn tracked_files(repo: &Repo) -> Result<Vec<String>> {
    let out = repo.run(&["ls-files", "-z"])?;
    Ok(split_nul(&out).map(lossy).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blame_porcelain() {
        let sha = "a".repeat(40);
        let other = "b".repeat(40);
        let text = format!(
            "{sha} 1 1 2\nauthor Ada\nauthor-mail <ada@example.com>\nauthor-time 100\nsummary First\nfilename f\n\tone\n{sha} 2 2\n\ttwo\n{other} 3 3 1\nauthor Grace\nauthor-mail <g@example.com>\nauthor-time 200\nsummary Second\nfilename f\n\tthree\n"
        );
        let blame = parse_porcelain(&text).unwrap();
        assert_eq!(blame.lines.len(), 3);
        assert_eq!(blame.lines[1].oid, sha);
        assert_eq!(blame.lines[2].text, "three");
        assert_eq!(blame.commits.len(), 2);
        assert_eq!(blame.commits[1].author, "Grace");
        assert_eq!(blame.commits[0].email, "ada@example.com");
    }
}
