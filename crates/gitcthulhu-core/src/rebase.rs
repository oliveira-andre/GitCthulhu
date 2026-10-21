//! Interactive rebase: reorder, reword, squash, fix up or drop commits.
//!
//! git asks `GIT_SEQUENCE_EDITOR` to edit its todo list; GitCthulhu points it
//! at a command that copies in the plan the user built. Rewords don't use an
//! editor either: the commit is picked, then an `exec` line amends it with
//! the new message from a file. The files live in `<git dir>/gitcthulhu-rebase`
//! until the rebase ends, because a rebase that stops on conflicts still
//! needs them when it continues.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::inspect::check_revision;
use crate::ops::conflict_aware;
use crate::repo::{Repo, RepoState};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: String,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub summary: String,
    /// The whole message, for editing a reword.
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    /// Keep the changes, replace the message.
    Reword,
    /// Meld into the previous commit, keeping both messages.
    Squash,
    /// Meld into the previous commit, discarding this message.
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub oid: String,
    pub action: RebaseAction,
    /// Rewords only: the new message.
    #[serde(default)]
    pub message: Option<String>,
}

/// The commits a rebase onto `onto` would replay, oldest first. `None`
/// rebases the whole history (`--root`).
pub fn plan(repo: &Repo, onto: Option<&str>) -> Result<Vec<PlanCommit>> {
    let range = match onto {
        Some(onto) => {
            check_revision(onto)?;
            format!("{onto}..HEAD")
        }
        None => "HEAD".to_owned(),
    };
    let text = repo.run_text(&[
        "log",
        "--reverse",
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e",
        &range,
    ])?;
    let mut commits = Vec::new();
    for record in text
        .split('\x1e')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
    {
        let fields: Vec<&str> = record.splitn(6, '\x1f').collect();
        let [oid, parents, author, email, time, message] = fields[..] else {
            return Err(Error::Parse(format!("unexpected log record: {record}")));
        };
        if parents.split_whitespace().count() > 1 {
            return Err(Error::Invalid(
                "these commits include a merge; interactive rebase can't keep merges yet".into(),
            ));
        }
        let message = message.trim_end().to_owned();
        commits.push(PlanCommit {
            oid: oid.to_owned(),
            author: author.to_owned(),
            email: email.to_owned(),
            author_time: time.parse().unwrap_or(0),
            summary: message.lines().next().unwrap_or_default().to_owned(),
            message,
        });
    }
    Ok(commits)
}

/// Replays the commits after `onto` as `steps` says, oldest first. Every
/// commit of the plan must appear exactly once. Local changes are stashed
/// for the duration (`--autostash`).
pub fn run(repo: &Repo, onto: Option<&str>, steps: &[RebaseStep]) -> Result<()> {
    if repo.state() != RepoState::Clean {
        return Err(Error::Invalid(
            "finish or abort what's in progress first".into(),
        ));
    }
    let planned = plan(repo, onto)?;
    let mut expected: Vec<&str> = planned.iter().map(|c| c.oid.as_str()).collect();
    let mut given: Vec<&str> = steps.iter().map(|s| s.oid.as_str()).collect();
    expected.sort_unstable();
    given.sort_unstable();
    if expected != given {
        return Err(Error::Invalid(
            "the branch changed since the rebase was planned; plan it again".into(),
        ));
    }
    let kept: Vec<&RebaseStep> = steps
        .iter()
        .filter(|s| s.action != RebaseAction::Drop)
        .collect();
    if kept
        .first()
        .is_some_and(|s| matches!(s.action, RebaseAction::Squash | RebaseAction::Fixup))
    {
        return Err(Error::Invalid(
            "the oldest kept commit has nothing to squash into".into(),
        ));
    }
    if kept.is_empty() && onto.is_none() {
        return Err(Error::Invalid(
            "dropping every commit would leave the branch empty".into(),
        ));
    }

    let dir = scratch_dir(repo);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let git_exe = shell_quote(&slashes(repo.git().exe()));
    let mut todo = String::new();
    for (i, step) in steps.iter().enumerate() {
        check_revision(&step.oid)?;
        let word = match step.action {
            RebaseAction::Pick | RebaseAction::Reword => "pick",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
            RebaseAction::Drop => "drop",
        };
        todo.push_str(&format!("{word} {}\n", step.oid));
        if step.action == RebaseAction::Reword {
            let message = step
                .message
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty());
            let message = message
                .ok_or_else(|| Error::Invalid("a reworded commit needs a message".into()))?;
            let file = dir.join(format!("message-{i}"));
            std::fs::write(&file, message)?;
            todo.push_str(&format!(
                "exec {git_exe} commit --amend --allow-empty --no-verify --cleanup=strip -F {}\n",
                shell_quote(&slashes(&file))
            ));
        }
    }
    if kept.is_empty() {
        // git treats an empty todo as "abort"; `noop` drops everything.
        todo.push_str("noop\n");
    }
    let todo_file = dir.join("todo");
    std::fs::write(&todo_file, &todo)?;

    // The environment variable outranks any configured sequence editor.
    let editor = format!("cp {}", shell_quote(&slashes(&todo_file)));
    let git = repo.git().clone().with_env("GIT_SEQUENCE_EDITOR", editor);
    let mut args = vec!["rebase", "-i", "--autostash"];
    args.push(onto.unwrap_or("--root"));
    let result = conflict_aware(repo, git.run(repo.root(), &args));
    if repo.state() == RepoState::Clean {
        cleanup(repo);
    }
    result
}

/// Removes the plan's files once no rebase needs them.
pub fn cleanup(repo: &Repo) {
    let _ = std::fs::remove_dir_all(scratch_dir(repo));
}

fn scratch_dir(repo: &Repo) -> PathBuf {
    repo.git_dir().join("gitcthulhu-rebase")
}

/// git runs editors and `exec` lines through a POSIX shell, on Windows too.
fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Changes one commit's message. HEAD is amended; an older commit is
/// reworded by rebasing onto its parent.
pub fn reword(repo: &Repo, oid: &str, message: &str) -> Result<()> {
    check_revision(oid)?;
    let full = repo
        .run_text(&["rev-parse", "--verify", &format!("{oid}^{{commit}}")])?
        .trim()
        .to_owned();
    let head = repo.run_text(&["rev-parse", "HEAD"])?.trim().to_owned();
    if message.trim().is_empty() {
        return Err(Error::Invalid("write a commit message first".into()));
    }
    if full == head {
        // --only with no paths changes just the message, not what's staged.
        let args = [
            "commit",
            "--amend",
            "--allow-empty",
            "--only",
            "--no-verify",
            "--cleanup=strip",
            "--file=-",
        ];
        return repo.run_input(&args, message.as_bytes()).map(drop);
    }
    rewrite_one(repo, &full, RebaseAction::Reword, Some(message))
}

/// Drops one commit from the current branch's history.
pub fn drop_commit(repo: &Repo, oid: &str) -> Result<()> {
    rewrite_one(repo, oid, RebaseAction::Drop, None)
}

/// Swaps a commit with its newer (`up`) or older neighbour.
pub fn move_commit(repo: &Repo, oid: &str, up: bool) -> Result<()> {
    check_revision(oid)?;
    let full = repo
        .run_text(&["rev-parse", "--verify", &format!("{oid}^{{commit}}")])?
        .trim()
        .to_owned();
    // Plan from the commit's grandparent so both neighbours are in range.
    let base = ancestor_base(repo, &full, if up { 1 } else { 2 })?;
    let planned = plan(repo, base.as_deref())?;
    let index = planned
        .iter()
        .position(|c| c.oid == full)
        .ok_or_else(not_on_branch)?;
    let other = if up {
        index + 1
    } else {
        index
            .checked_sub(1)
            .ok_or_else(|| Error::Invalid("that's already the oldest commit".into()))?
    };
    if other >= planned.len() {
        return Err(Error::Invalid("that's already the newest commit".into()));
    }
    let mut steps: Vec<RebaseStep> = planned
        .iter()
        .map(|c| RebaseStep {
            oid: c.oid.clone(),
            action: RebaseAction::Pick,
            message: None,
        })
        .collect();
    steps.swap(index, other);
    run(repo, base.as_deref(), &steps)
}

fn rewrite_one(repo: &Repo, oid: &str, action: RebaseAction, message: Option<&str>) -> Result<()> {
    check_revision(oid)?;
    let full = repo
        .run_text(&["rev-parse", "--verify", &format!("{oid}^{{commit}}")])?
        .trim()
        .to_owned();
    let base = ancestor_base(repo, &full, 1)?;
    let planned = plan(repo, base.as_deref())?;
    if !planned.iter().any(|c| c.oid == full) {
        return Err(not_on_branch());
    }
    let steps: Vec<RebaseStep> = planned
        .iter()
        .map(|c| {
            if c.oid == full {
                RebaseStep {
                    oid: c.oid.clone(),
                    action,
                    message: message.map(str::to_owned),
                }
            } else {
                RebaseStep {
                    oid: c.oid.clone(),
                    action: RebaseAction::Pick,
                    message: None,
                }
            }
        })
        .collect();
    run(repo, base.as_deref(), &steps)
}

/// The commit `generations` above `oid`, or `None` when that runs past the
/// root (rebase with `--root`). Refuses commits that aren't in HEAD's history.
fn ancestor_base(repo: &Repo, oid: &str, generations: usize) -> Result<Option<String>> {
    if !repo
        .output(&["merge-base", "--is-ancestor", oid, "HEAD"])?
        .success()
    {
        return Err(not_on_branch());
    }
    let target = format!("{oid}{}", "^".repeat(generations));
    let out = repo.output(&[
        "rev-parse",
        "-q",
        "--verify",
        &format!("{target}^{{commit}}"),
    ])?;
    Ok(out
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()))
}

fn not_on_branch() -> Error {
    Error::Invalid("that commit isn't in the checked-out branch's history".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(shell_quote("/a b/c"), "'/a b/c'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
