//! Loads the commits for the graph: every branch, tag and remote, plus the
//! stashes and a row for uncommitted changes.

use std::collections::HashSet;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::graph::{self, RowLayout};
use crate::repo::Repo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RowKind {
    Commit,
    Stash,
    /// The working tree's uncommitted changes, drawn above HEAD.
    WorkInProgress,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the epoch.
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    pub kind: RowKind,
    /// Stashes only: `stash@{0}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub commits: Vec<GraphCommit>,
    pub rows: Vec<RowLayout>,
    /// The limit cut the history short.
    pub truncated: bool,
}

pub struct GraphOptions {
    pub limit: usize,
    /// Adds the work-in-progress row above HEAD.
    pub work_in_progress: bool,
}

/// `%x1f`-separated fields, one commit per line (`%s` never holds a newline).
const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s";

pub fn load(repo: &Repo, options: &GraphOptions) -> Result<Graph> {
    let stashes = stash_list(repo)?;
    let limit = options.limit.max(1);

    let head = repo.head()?;
    let mut args = vec![
        "log".to_owned(),
        "--date-order".to_owned(),
        FORMAT.to_owned(),
        format!("--max-count={}", limit + 1),
        "--exclude=refs/stash".to_owned(),
        "--all".to_owned(),
    ];
    // Detached HEAD isn't covered by --all's refs.
    if head.oid.is_some() {
        args.push("HEAD".to_owned());
    }
    args.extend(stashes.iter().map(|s| s.oid.clone()));

    let mut commits = if head.oid.is_none() && !has_any_ref(repo)? {
        Vec::new()
    } else {
        let text = repo.run_text(&args)?;
        text.lines().map(parse_commit).collect::<Result<Vec<_>>>()?
    };
    let truncated = commits.len() > limit;
    commits.truncate(limit);

    // A stash's second and third parents hold its index and untracked
    // files. They aren't history, so drop them from the graph.
    let internal: HashSet<String> = stashes
        .iter()
        .flat_map(|s| s.parents.iter().skip(1).cloned())
        .collect();
    commits.retain(|c| !internal.contains(&c.oid));
    for commit in &mut commits {
        if let Some(stash) = stashes.iter().find(|s| s.oid == commit.oid) {
            commit.kind = RowKind::Stash;
            commit.stash = Some(stash.name.clone());
            commit.subject = stash.message.clone();
            commit.parents.truncate(1);
        }
    }

    if options.work_in_progress {
        commits.insert(
            0,
            GraphCommit {
                oid: WORK_IN_PROGRESS.to_owned(),
                parents: head.oid.into_iter().collect(),
                author: String::new(),
                email: String::new(),
                author_time: 0,
                committer: String::new(),
                commit_time: 0,
                subject: String::new(),
                kind: RowKind::WorkInProgress,
                stash: None,
            },
        );
    }

    let nodes: Vec<graph::Node> = commits
        .iter()
        .map(|c| graph::Node {
            oid: &c.oid,
            parents: &c.parents,
            dashed: c.kind != RowKind::Commit,
        })
        .collect();
    let rows = graph::layout(&nodes);
    Ok(Graph {
        commits,
        rows,
        truncated,
    })
}

/// The id of the work-in-progress row.
pub const WORK_IN_PROGRESS: &str = "work-in-progress";

fn has_any_ref(repo: &Repo) -> Result<bool> {
    let out = repo.run(&["for-each-ref", "--count=1", "--format=%(refname)"])?;
    Ok(!out.is_empty())
}

fn parse_commit(line: &str) -> Result<GraphCommit> {
    let fields: Vec<&str> = line.split('\x1f').collect();
    let [
        oid,
        parents,
        author,
        email,
        author_time,
        committer,
        commit_time,
        subject,
    ] = fields[..]
    else {
        return Err(Error::Parse(format!("unexpected log line: {line}")));
    };
    Ok(GraphCommit {
        oid: oid.to_owned(),
        parents: parents.split_whitespace().map(str::to_owned).collect(),
        author: author.to_owned(),
        email: email.to_owned(),
        author_time: author_time.parse().unwrap_or(0),
        committer: committer.to_owned(),
        commit_time: commit_time.parse().unwrap_or(0),
        subject: subject.to_owned(),
        kind: RowKind::Commit,
        stash: None,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// `stash@{0}`.
    pub name: String,
    pub oid: String,
    pub parents: Vec<String>,
    /// `On main: message` or `WIP on main: abc1234 subject`.
    pub message: String,
    pub time: i64,
}

pub fn stash_list(repo: &Repo) -> Result<Vec<Stash>> {
    let out = repo.output(&["stash", "list", "--format=%gd%x1f%H%x1f%P%x1f%gs%x1f%ct"])?;
    if !out.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\x1f').collect();
            let [name, oid, parents, message, time] = fields[..] else {
                return None;
            };
            Some(Stash {
                name: name.to_owned(),
                oid: oid.to_owned(),
                parents: parents.split_whitespace().map(str::to_owned).collect(),
                message: message.to_owned(),
                time: time.parse().unwrap_or(0),
            })
        })
        .collect())
}
