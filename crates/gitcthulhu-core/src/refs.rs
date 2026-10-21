use serde::Serialize;

use crate::error::Result;
use crate::repo::Repo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    /// Full name, for example `refs/remotes/origin/main`.
    pub name: String,
    /// `main`, `origin/main`, `v1.0`.
    pub short: String,
    pub kind: RefKind,
    /// The commit it points at (tags are peeled).
    pub oid: String,
    /// Remote branches only: the remote's name.
    pub remote: Option<String>,
    /// Local branches only: the upstream's short name.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream was deleted on the remote.
    pub upstream_gone: bool,
    /// The branch checked out in this worktree.
    pub is_head: bool,
    /// Annotated tags only.
    pub annotated: bool,
}

const FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(symref)";

pub fn list(repo: &Repo) -> Result<Vec<Ref>> {
    let remotes = repo.remotes()?;
    let text = repo.run_text(&[
        "for-each-ref",
        FORMAT,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ])?;
    let mut refs: Vec<Ref> = text
        .lines()
        .filter_map(|line| parse(line, &remotes))
        .collect();
    refs.sort_by_key(|r| (r.kind as u8, natural_key(&r.short)));
    Ok(refs)
}

fn parse(line: &str, remotes: &[String]) -> Option<Ref> {
    let fields: Vec<&str> = line.split('\0').collect();
    let [name, oid, peeled, upstream, track, head, symref] = fields[..] else {
        return None;
    };
    // `refs/remotes/origin/HEAD` is an alias, not a branch.
    if !symref.is_empty() {
        return None;
    }
    let (kind, short, remote) = if let Some(short) = name.strip_prefix("refs/heads/") {
        (RefKind::Local, short.to_owned(), None)
    } else if let Some(short) = name.strip_prefix("refs/remotes/") {
        // Remote names can contain slashes, so match the known ones.
        let remote = remotes
            .iter()
            .filter(|r| short.starts_with(&format!("{r}/")))
            .max_by_key(|r| r.len())
            .cloned()
            .or_else(|| short.split('/').next().map(str::to_owned));
        (RefKind::Remote, short.to_owned(), remote)
    } else {
        (
            RefKind::Tag,
            name.strip_prefix("refs/tags/")?.to_owned(),
            None,
        )
    };
    let (ahead, behind, gone) = parse_track(track);
    Some(Ref {
        name: name.to_owned(),
        short,
        kind,
        oid: if peeled.is_empty() {
            oid.to_owned()
        } else {
            peeled.to_owned()
        },
        remote,
        upstream: Some(upstream.to_owned()).filter(|u| !u.is_empty()),
        ahead,
        behind,
        upstream_gone: gone,
        is_head: head == "*",
        annotated: kind == RefKind::Tag && !peeled.is_empty(),
    })
}

/// Parses `ahead 2, behind 1` or `gone`.
fn parse_track(track: &str) -> (u32, u32, bool) {
    if track == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// Sorts `v2` before `v10` and ignores case.
fn natural_key(s: &str) -> Vec<(u64, String)> {
    let mut key = Vec::new();
    let mut digits = String::new();
    let mut text = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !text.is_empty() {
                key.push((0, std::mem::take(&mut text).to_lowercase()));
            }
            digits.push(c);
        } else {
            if !digits.is_empty() {
                key.push((digits.parse().unwrap_or(u64::MAX), String::new()));
                digits.clear();
            }
            text.push(c);
        }
    }
    if !digits.is_empty() {
        key.push((digits.parse().unwrap_or(u64::MAX), String::new()));
    }
    if !text.is_empty() {
        key.push((0, text.to_lowercase()));
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tracking_info() {
        assert_eq!(parse_track("ahead 2, behind 1"), (2, 1, false));
        assert_eq!(parse_track("behind 5"), (0, 5, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[test]
    fn remote_names_with_slashes_are_matched_whole() {
        let remotes = vec!["origin".to_owned(), "team/fork".to_owned()];
        let line = "refs/remotes/team/fork/feature/x\0abc\0\0\0\0 \0";
        let r = parse(line, &remotes).unwrap();
        assert_eq!(r.remote.as_deref(), Some("team/fork"));
        assert_eq!(r.short, "team/fork/feature/x");
    }

    #[test]
    fn natural_order() {
        let mut names = vec!["v10", "v2", "V1", "main"];
        names.sort_by_key(|n| natural_key(n));
        assert_eq!(names, ["main", "V1", "v2", "v10"]);
    }
}
