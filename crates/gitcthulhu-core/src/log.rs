//! Loads the commits for the graph: every branch, tag and remote, plus the
//! stashes and a row for uncommitted changes.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

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
    /// git has a commit-graph file (see [`Repo::has_commit_graph`]).
    pub indexed: bool,
}

pub struct GraphOptions {
    pub limit: usize,
    /// Adds the work-in-progress row above HEAD.
    pub work_in_progress: bool,
    pub filter: RefFilter,
}

/// Which branches and tags the graph starts from.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RefFilter {
    /// Full ref names or globs (`refs/tags/*`) left out of the graph; commits
    /// only they reach disappear.
    pub hidden: Vec<String>,
    /// When not empty, only these refs (full names) are shown.
    pub solo: Vec<String>,
    pub hide_stashes: bool,
}

fn check_ref_pattern(pattern: &str) -> Result<()> {
    if !pattern.starts_with("refs/") || pattern.contains(|c: char| c.is_whitespace() || c == '\0') {
        return Err(Error::Invalid(format!("not a ref name: {pattern}")));
    }
    Ok(())
}

/// `%x1f`-separated fields, one commit per line (`%s` never holds a newline).
const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s";
/// The same fields with the whole message last, for `-z` output.
const SEARCH_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B";

pub fn load(repo: &Repo, options: &GraphOptions) -> Result<Graph> {
    let stashes = stash_list(repo)?;
    let limit = options.limit.max(1);

    let head = repo.head()?;
    let filter = &options.filter;
    let mut args = vec![
        "log".to_owned(),
        "--date-order".to_owned(),
        FORMAT.to_owned(),
        format!("--max-count={}", limit + 1),
    ];
    let soloing = !filter.solo.is_empty();
    if soloing {
        for name in &filter.solo {
            check_ref_pattern(name)?;
            args.push(name.clone());
        }
    } else {
        // Each --exclude applies to the --all after it.
        for pattern in &filter.hidden {
            check_ref_pattern(pattern)?;
            args.push(format!("--exclude={pattern}"));
        }
        args.extend(["--exclude=refs/stash".to_owned(), "--all".to_owned()]);
        // Detached HEAD isn't covered by --all's refs; a hidden HEAD branch stays hidden.
        let head_hidden = head
            .branch
            .as_ref()
            .is_some_and(|b| filter.hidden.contains(&format!("refs/heads/{b}")));
        if head.oid.is_some() && !head_hidden {
            args.push("HEAD".to_owned());
        }
    }
    let stashes = if soloing || filter.hide_stashes {
        Vec::new()
    } else {
        stashes
    };
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
        indexed: repo.has_commit_graph(),
    })
}

/// The id of the work-in-progress row.
pub const WORK_IN_PROGRESS: &str = "work-in-progress";

fn has_any_ref(repo: &Repo) -> Result<bool> {
    let out = repo.run(&["for-each-ref", "--count=1", "--format=%(refname)"])?;
    Ok(!out.is_empty())
}

fn parse_commit(line: &str) -> Result<GraphCommit> {
    // The subject is last and may itself hold the separator.
    let fields: Vec<&str> = line.splitn(8, '\x1f').collect();
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

/// A message's first paragraph on one line, as `%s` prints it.
fn subject_line(message: &str) -> String {
    message
        .lines()
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty())
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
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

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitStat {
    pub oid: String,
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// How much each commit changed, compared with its first parent. One git
/// process for all of them.
pub fn commit_stats(repo: &Repo, oids: &[String]) -> Result<Vec<CommitStat>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::new();
    for oid in oids {
        crate::inspect::check_revision(oid)?;
        input.push_str(oid);
        input.push('\n');
    }
    let out = repo.run_input(
        &[
            "diff-tree",
            "--stdin",
            "-r",
            "--root",
            "-m",
            "--first-parent",
            "--shortstat",
        ],
        input.as_bytes(),
    )?;
    let mut stats: Vec<CommitStat> = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let line = line.trim();
        if line.len() == 40 && line.bytes().all(|b| b.is_ascii_hexdigit()) {
            stats.push(CommitStat {
                oid: line.to_owned(),
                ..CommitStat::default()
            });
        } else if let Some(stat) = stats.last_mut().filter(|_| line.contains("changed")) {
            // " 3 files changed, 10 insertions(+), 2 deletions(-)"
            for part in line.split(',') {
                let n = part
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                if part.contains("file") {
                    stat.files = n;
                } else if part.contains("insertion") {
                    stat.insertions = n;
                } else if part.contains("deletion") {
                    stat.deletions = n;
                }
            }
        }
    }
    Ok(stats)
}

/// Commits anywhere in the history whose message or author contains `query`
/// (ignoring case), or whose SHA starts with it. Newest first.
///
/// git ANDs `--author` with `--grep`, so one walk can't ask for either. This
/// walks once, matching here, and stops as soon as it has `limit` commits:
/// on a long history a second walk for authors would read every commit again.
pub fn search(repo: &Repo, query: &str, limit: usize) -> Result<Vec<GraphCommit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.max(1);
    let needle = query.to_lowercase();
    // Most commits don't match, so test the raw fields before parsing any.
    let contains = |text: &[u8]| {
        if needle.is_ascii() {
            let needle = needle.as_bytes();
            text.windows(needle.len())
                .any(|w| w.eq_ignore_ascii_case(needle))
        } else {
            String::from_utf8_lossy(text)
                .to_lowercase()
                .contains(&needle)
        }
    };
    let mut found: Vec<GraphCommit> = Vec::new();
    let mut problem = None;
    repo.git().stream(
        repo.root(),
        &["log", "-z", "--exclude=refs/stash", "--all", SEARCH_FORMAT],
        &mut |record| {
            let fields: Vec<&[u8]> = record.splitn(8, |b| *b == 0x1f).collect();
            let [_, _, author, email, _, _, _, message] = fields[..] else {
                problem = Some(Error::Parse("unexpected log record".into()));
                return false;
            };
            if !(contains(message) || contains(author) || contains(email)) {
                return true;
            }
            match parse_commit(&String::from_utf8_lossy(record)) {
                Ok(commit) => {
                    // `subject` holds the whole message.
                    let subject = subject_line(&commit.subject);
                    found.push(GraphCommit { subject, ..commit });
                }
                Err(e) => {
                    problem = Some(e);
                    return false;
                }
            }
            found.len() < limit
        },
    )?;
    if let Some(problem) = problem {
        return Err(problem);
    }
    if query.len() >= 4 && query.bytes().all(|b| b.is_ascii_hexdigit()) {
        let out = repo.output(&[
            "rev-parse",
            "-q",
            "--verify",
            &format!("{query}^{{commit}}"),
        ])?;
        if out.success() {
            let oid = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            let text = repo.run_text(&["log", "-1", FORMAT, &oid])?;
            if let Some(line) = text.lines().next() {
                let commit = parse_commit(line)?;
                if !found.iter().any(|c| c.oid == commit.oid) {
                    found.insert(0, commit);
                }
            }
        }
    }
    found.sort_by_key(|c| std::cmp::Reverse(c.commit_time));
    found.truncate(limit);
    Ok(found)
}
