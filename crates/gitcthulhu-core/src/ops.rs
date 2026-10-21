//! Everything that changes a repository. Each operation is one or two git
//! commands, so it behaves as it would in a terminal: hooks run, signing
//! follows the user's config, and git's own safety checks apply.

use serde::Deserialize;

use crate::diff::{self, Direction};
use crate::error::{Error, Result};
use crate::inspect::{self, DiffTarget, check_revision};
use crate::refs::{self, RefKind};
use crate::repo::{Repo, RepoState};

// Staging

pub fn stage_paths(repo: &Repo, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    // -A also stages deletions of the listed paths.
    run_with_paths(repo, &["add", "-A"], paths)
}

pub fn stage_all(repo: &Repo) -> Result<()> {
    repo.run(&["add", "-A"]).map(drop)
}

pub fn unstage_paths(repo: &Repo, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    if repo.head()?.oid.is_none() {
        // Nothing to restore from before the first commit.
        return run_with_paths(repo, &["rm", "--cached", "-r", "-q"], paths);
    }
    run_with_paths(repo, &["restore", "--staged"], paths)
}

pub fn unstage_all(repo: &Repo) -> Result<()> {
    if repo.head()?.oid.is_none() {
        return repo.run(&["rm", "--cached", "-r", "-q", "."]).map(drop);
    }
    repo.run(&["reset", "-q"]).map(drop)
}

/// Throws away unstaged changes: tracked files go back to their staged
/// version and untracked files are deleted.
pub fn discard_paths(repo: &Repo, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "ls-files".to_owned(),
        "-z".into(),
        "--others".into(),
        "--exclude-standard".into(),
        "--".into(),
    ];
    args.extend(paths.iter().cloned());
    let untracked: Vec<String> = crate::git::split_nul(&repo.run(&args)?)
        .map(crate::git::lossy)
        .collect();
    let tracked: Vec<String> = paths
        .iter()
        .filter(|p| !untracked.contains(p))
        .cloned()
        .collect();
    if !tracked.is_empty() {
        run_with_paths(repo, &["restore", "--worktree"], &tracked)?;
    }
    if !untracked.is_empty() {
        run_with_paths(repo, &["clean", "-f", "-q"], &untracked)?;
    }
    Ok(())
}

/// What to do with some lines of a file's diff.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineAction {
    /// Unstaged lines into the index.
    Stage,
    /// Staged lines back out of the index.
    Unstage,
    /// Unstaged lines out of the working tree.
    Discard,
}

/// Stages, unstages or discards one hunk, or chosen lines of it.
///
/// `hunk_header` must match what the UI showed: the diff is read again here,
/// and a file that changed meanwhile is refused rather than patched blind.
pub fn apply_lines(
    repo: &Repo,
    action: LineAction,
    path: &str,
    hunk: usize,
    hunk_header: &str,
    lines: Option<&[usize]>,
) -> Result<()> {
    let target = match action {
        LineAction::Stage | LineAction::Discard => DiffTarget::Unstaged,
        LineAction::Unstage => DiffTarget::Staged,
    };
    let mut file = inspect::file_diff(repo, &target, path, None, 3)?;
    if action == LineAction::Stage && file.new_file && is_untracked(repo, path)? {
        // A new file must be known to the index before part of it can be
        // staged; intent-to-add records it as empty.
        repo.run(&["add", "-N", "--", path])?;
        file = inspect::file_diff(repo, &target, path, None, 3)?;
    }
    let shown = file.hunks.get(hunk).map(|h| h.header.as_str());
    if shown != Some(hunk_header) {
        return Err(Error::Invalid(
            "the file changed since it was shown; look at the diff again".into(),
        ));
    }
    let direction = match action {
        LineAction::Stage => Direction::Forward,
        LineAction::Unstage | LineAction::Discard => Direction::Reverse,
    };
    let patch = diff::partial_patch(&file, hunk, lines, direction)?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if action != LineAction::Discard {
        args.push("--cached");
    }
    if direction == Direction::Reverse {
        args.push("-R");
    }
    args.push("-");
    repo.run_input(&args, patch.as_bytes()).map(drop)
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

// Commits

pub struct CommitOptions<'a> {
    pub message: &'a str,
    pub amend: bool,
    /// Allows a commit with no changes, for example an amend that only
    /// rewords.
    pub allow_empty: bool,
}

/// Commits the index and returns the new commit's id.
pub fn commit(repo: &Repo, options: &CommitOptions) -> Result<String> {
    if options.message.trim().is_empty() && !options.amend {
        return Err(Error::Invalid("write a commit message first".into()));
    }
    // The message goes through stdin so it is never parsed as arguments.
    let mut args = vec!["commit", "--file=-", "--cleanup=strip"];
    if options.amend {
        args.push("--amend");
    }
    if options.allow_empty || options.amend {
        args.push("--allow-empty");
    }
    repo.run_input(&args, options.message.as_bytes())?;
    Ok(repo.head()?.oid.unwrap_or_default())
}

/// The message of HEAD, to prefill an amend.
pub fn head_message(repo: &Repo) -> Result<String> {
    Ok(repo
        .run_text(&["log", "-1", "--format=%B"])?
        .trim_end()
        .to_owned())
}

// Branches and checkout

pub fn checkout_branch(repo: &Repo, name: &str) -> Result<()> {
    check_name(name)?;
    repo.run(&["switch", name]).map(drop)
}

/// Checks out a remote branch: switches to the local branch of the same
/// name if there is one, or creates it tracking the remote.
pub fn checkout_remote_branch(repo: &Repo, remote_branch: &str) -> Result<String> {
    check_name(remote_branch)?;
    let all = refs::list(repo)?;
    let remote = all
        .iter()
        .find(|r| r.kind == RefKind::Remote && r.short == remote_branch)
        .ok_or_else(|| Error::Invalid(format!("{remote_branch} isn't a remote branch")))?;
    let local_name = remote
        .remote
        .as_deref()
        .and_then(|prefix| remote_branch.strip_prefix(prefix))
        .map(|n| n.trim_start_matches('/').to_owned())
        .unwrap_or_else(|| remote_branch.to_owned());
    if all
        .iter()
        .any(|r| r.kind == RefKind::Local && r.short == local_name)
    {
        repo.run(&["switch", &local_name])?;
    } else {
        repo.run(&["switch", "-c", &local_name, "--track", remote_branch])?;
    }
    Ok(local_name)
}

pub fn checkout_detached(repo: &Repo, oid: &str) -> Result<()> {
    check_revision(oid)?;
    repo.run(&["switch", "--detach", oid]).map(drop)
}

pub fn create_branch(repo: &Repo, name: &str, at: Option<&str>, checkout: bool) -> Result<()> {
    check_name(name)?;
    let mut args = if checkout {
        vec!["switch", "-c", name]
    } else {
        vec!["branch", name]
    };
    if let Some(at) = at {
        check_revision(at)?;
        args.push(at);
    }
    repo.run(&args).map(drop)
}

pub fn delete_branch(repo: &Repo, name: &str, force: bool) -> Result<()> {
    check_name(name)?;
    repo.run(&["branch", if force { "-D" } else { "-d" }, name])
        .map(drop)
}

pub fn rename_branch(repo: &Repo, old: &str, new: &str) -> Result<()> {
    check_name(old)?;
    check_name(new)?;
    repo.run(&["branch", "-m", old, new]).map(drop)
}

/// Moves a branch that isn't checked out to its upstream, if that is a
/// fast-forward.
pub fn fast_forward_branch(repo: &Repo, branch: &str, upstream: &str) -> Result<()> {
    check_name(branch)?;
    check_name(upstream)?;
    let is_ancestor = repo.output(&["merge-base", "--is-ancestor", branch, upstream])?;
    if !is_ancestor.success() {
        return Err(Error::Invalid(format!(
            "{branch} has commits that {upstream} doesn't; it can't be fast-forwarded"
        )));
    }
    repo.run(&["update-ref", &format!("refs/heads/{branch}"), upstream])
        .map(drop)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    /// Fast-forward when possible, otherwise a merge commit.
    Default,
    /// Always a merge commit.
    NoFastForward,
    FastForwardOnly,
    /// Stages the combined changes without committing.
    Squash,
}

pub fn merge(repo: &Repo, other: &str, mode: MergeMode) -> Result<()> {
    check_revision(other)?;
    let mut args = vec!["merge", "--no-edit"];
    match mode {
        MergeMode::Default => {}
        MergeMode::NoFastForward => args.push("--no-ff"),
        MergeMode::FastForwardOnly => args.push("--ff-only"),
        MergeMode::Squash => args.push("--squash"),
    }
    args.push(other);
    conflict_aware(repo, repo.run(&args))
}

pub fn rebase(repo: &Repo, onto: &str) -> Result<()> {
    check_revision(onto)?;
    conflict_aware(repo, repo.run(&["rebase", onto]))
}

pub fn cherry_pick(repo: &Repo, oids: &[String]) -> Result<()> {
    let mut args = vec!["cherry-pick".to_owned()];
    for oid in oids {
        check_revision(oid)?;
        if is_merge(repo, oid)? {
            args.push("-m1".into());
        }
    }
    args.extend(oids.iter().cloned());
    conflict_aware(repo, repo.run(&args))
}

pub fn revert(repo: &Repo, oid: &str) -> Result<()> {
    check_revision(oid)?;
    let mut args = vec!["revert", "--no-edit"];
    if is_merge(repo, oid)? {
        args.push("-m1");
    }
    args.push(oid);
    conflict_aware(repo, repo.run(&args))
}

fn is_merge(repo: &Repo, oid: &str) -> Result<bool> {
    let out = repo.output(&["rev-parse", "-q", "--verify", &format!("{oid}^2")])?;
    Ok(out.success())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

pub fn reset(repo: &Repo, oid: &str, mode: ResetMode) -> Result<()> {
    check_revision(oid)?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
    };
    repo.run(&["reset", "-q", flag, oid]).map(drop)
}

/// A merge, rebase, cherry-pick or revert that stopped on conflicts is
/// reported as `Conflicts`, so the UI can show them instead of an error.
fn conflict_aware(repo: &Repo, result: Result<Vec<u8>>) -> Result<()> {
    match result {
        Ok(_) => Ok(()),
        Err(Error::Git { stderr, .. }) if repo.state() != RepoState::Clean => {
            Err(Error::Conflicts(stderr))
        }
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Sequence {
    Continue,
    Abort,
    Skip,
}

/// Continues, aborts or skips whatever merge, rebase, cherry-pick or revert
/// is in progress.
pub fn sequence(repo: &Repo, action: Sequence) -> Result<()> {
    let command = match repo.state() {
        RepoState::Merging { .. } => "merge",
        RepoState::Rebasing { .. } => "rebase",
        RepoState::CherryPicking { .. } => "cherry-pick",
        RepoState::Reverting { .. } => "revert",
        RepoState::Bisecting => "bisect",
        RepoState::Clean => return Err(Error::Invalid("nothing is in progress".into())),
    };
    let flag = match (command, action) {
        ("bisect", _) => "reset",
        ("merge", Sequence::Continue) => {
            // `merge --continue` refuses while files are unresolved; say why.
            return conflict_aware(repo, repo.run(&["commit", "--no-edit"]));
        }
        ("merge", Sequence::Skip) => {
            return Err(Error::Invalid(
                "a merge can't skip; abort it instead".into(),
            ));
        }
        (_, Sequence::Continue) => "--continue",
        (_, Sequence::Abort) => "--abort",
        (_, Sequence::Skip) => "--skip",
    };
    conflict_aware(repo, repo.run(&[command, flag]))
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// Resolves conflicted files by taking one side whole, then stages them.
pub fn resolve_with(repo: &Repo, paths: &[String], side: ConflictSide) -> Result<()> {
    let flag = match side {
        ConflictSide::Ours => "--ours",
        ConflictSide::Theirs => "--theirs",
    };
    run_with_paths(repo, &["checkout", flag], paths)?;
    stage_paths(repo, paths)
}

// Tags

pub fn create_tag(repo: &Repo, name: &str, at: &str, message: Option<&str>) -> Result<()> {
    check_name(name)?;
    check_revision(at)?;
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(message) => repo
            .run_input(&["tag", "-a", "-F", "-", name, at], message.as_bytes())
            .map(drop),
        None => repo.run(&["tag", name, at]).map(drop),
    }
}

pub fn delete_tag(repo: &Repo, name: &str) -> Result<()> {
    check_name(name)?;
    repo.run(&["tag", "-d", name]).map(drop)
}

// Stashes

pub fn stash_push(repo: &Repo, message: Option<&str>, include_untracked: bool) -> Result<()> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(message) = message {
        args.extend(["-m", message]);
    }
    repo.run(&args).map(drop)
}

pub fn stash_apply(repo: &Repo, stash: &str, pop: bool) -> Result<()> {
    check_stash(stash)?;
    let result = repo.run(&["stash", if pop { "pop" } else { "apply" }, "--index", stash]);
    match result {
        // --index fails when the staged changes no longer apply; fall back
        // to restoring everything unstaged.
        Err(Error::Git { ref stderr, .. })
            if stderr.contains("--index") || stderr.contains("Conflicts in index") =>
        {
            repo.run(&["stash", if pop { "pop" } else { "apply" }, stash])
                .map(drop)
        }
        other => other.map(drop),
    }
}

pub fn stash_drop(repo: &Repo, stash: &str) -> Result<()> {
    check_stash(stash)?;
    repo.run(&["stash", "drop", stash]).map(drop)
}

fn check_stash(stash: &str) -> Result<()> {
    let valid = stash
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
        .is_some_and(|n| n.parse::<u32>().is_ok());
    if valid {
        Ok(())
    } else {
        Err(Error::Invalid(format!("not a stash: {stash}")))
    }
}

// Remotes

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// Fast-forward if possible, otherwise merge.
    Merge,
    FastForwardOnly,
    Rebase,
}

pub fn fetch(repo: &Repo, remote: Option<&str>, progress: &mut dyn FnMut(&str)) -> Result<()> {
    let mut args = vec!["fetch", "--progress", "--prune", "--tags"];
    match remote {
        Some(remote) => {
            check_name(remote)?;
            args.push(remote);
        }
        None => args.push("--all"),
    }
    repo.git()
        .run_progress(repo.root(), &args, progress)
        .map(drop)
}

pub fn pull(repo: &Repo, mode: PullMode, progress: &mut dyn FnMut(&str)) -> Result<()> {
    let flag = match mode {
        PullMode::Merge => "--no-rebase",
        PullMode::FastForwardOnly => "--ff-only",
        PullMode::Rebase => "--rebase",
    };
    let result = repo.git().run_progress(
        repo.root(),
        &["pull", "--progress", "--no-edit", flag],
        progress,
    );
    conflict_aware(repo, result)
}

pub struct PushOptions<'a> {
    pub remote: &'a str,
    pub branch: &'a str,
    pub set_upstream: bool,
    /// `--force-with-lease`: refuses if the remote moved since the last fetch.
    pub force: bool,
}

pub fn push(repo: &Repo, options: &PushOptions, progress: &mut dyn FnMut(&str)) -> Result<()> {
    check_name(options.remote)?;
    check_name(options.branch)?;
    let mut args = vec!["push", "--progress"];
    if options.set_upstream {
        args.push("--set-upstream");
    }
    if options.force {
        args.push("--force-with-lease");
    }
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", options.branch);
    args.extend([options.remote, refspec.as_str()]);
    repo.git()
        .run_progress(repo.root(), &args, progress)
        .map(drop)
}

pub fn push_tag(
    repo: &Repo,
    remote: &str,
    tag: &str,
    progress: &mut dyn FnMut(&str),
) -> Result<()> {
    check_name(remote)?;
    check_name(tag)?;
    let refspec = format!("refs/tags/{tag}");
    repo.git()
        .run_progress(
            repo.root(),
            &["push", "--progress", remote, &refspec],
            progress,
        )
        .map(drop)
}

/// Deletes a branch or tag on a remote.
pub fn delete_remote_ref(
    repo: &Repo,
    remote: &str,
    full_ref: &str,
    progress: &mut dyn FnMut(&str),
) -> Result<()> {
    check_name(remote)?;
    check_name(full_ref)?;
    repo.git()
        .run_progress(
            repo.root(),
            &["push", "--progress", remote, "--delete", full_ref],
            progress,
        )
        .map(drop)
}

pub fn add_remote(repo: &Repo, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_name(url)?;
    repo.run(&["remote", "add", name, url]).map(drop)
}

pub fn remove_remote(repo: &Repo, name: &str) -> Result<()> {
    check_name(name)?;
    repo.run(&["remote", "remove", name]).map(drop)
}

/// The remote a push should go to when the branch has no upstream:
/// `origin` if it exists, else the only remote.
pub fn default_remote(repo: &Repo) -> Result<Option<String>> {
    let remotes = repo.remotes()?;
    Ok(remotes
        .iter()
        .find(|r| *r == "origin")
        .or(if remotes.len() == 1 {
            remotes.first()
        } else {
            None
        })
        .cloned())
}

// Helpers

fn run_with_paths(repo: &Repo, args: &[&str], paths: &[String]) -> Result<()> {
    let mut all: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    all.push("--".into());
    all.extend(paths.iter().cloned());
    repo.run(&all).map(drop)
}

/// Branch, tag and remote names go after options, so refuse anything that
/// git could read as one.
fn check_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.starts_with('-') || name.contains(['\0', '\n']) {
        return Err(Error::Invalid(format!("not a valid name: {name}")));
    }
    Ok(())
}
