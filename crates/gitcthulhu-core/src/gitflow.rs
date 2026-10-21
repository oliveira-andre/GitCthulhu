//! Gitflow, done with plain git so no `git flow` install is needed. The
//! settings live in the same `gitflow.*` config keys the git-flow tools use,
//! so either can work on the same repository.
//!
//! Features branch from develop and merge back into it. Releases and
//! hotfixes branch from develop and production respectively, and finish by
//! merging into production, tagging, and merging back into develop.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::ops::conflict_aware;
use crate::repo::Repo;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowConfig {
    /// Production releases, usually `main` or `master`.
    pub production: String,
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    /// Prefix for release and hotfix tags, for example `v`.
    pub version_tag: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FlowKind {
    Feature,
    Release,
    Hotfix,
}

/// The repository's Gitflow settings, or `None` before it's set up.
pub fn config(repo: &Repo) -> Result<Option<FlowConfig>> {
    let get = |key: &str| repo.config_get(&format!("gitflow.{key}"));
    let (Some(production), Some(develop)) = (get("branch.master")?, get("branch.develop")?) else {
        return Ok(None);
    };
    Ok(Some(FlowConfig {
        production,
        develop,
        feature: get("prefix.feature")?.unwrap_or_else(|| "feature/".into()),
        release: get("prefix.release")?.unwrap_or_else(|| "release/".into()),
        hotfix: get("prefix.hotfix")?.unwrap_or_else(|| "hotfix/".into()),
        version_tag: get("prefix.versiontag")?.unwrap_or_default(),
    }))
}

/// Saves the settings and creates the develop branch from production if
/// it doesn't exist yet.
pub fn init(repo: &Repo, config: &FlowConfig) -> Result<()> {
    for name in [&config.production, &config.develop] {
        if name.trim().is_empty() || name.starts_with('-') {
            return Err(Error::Invalid(format!("not a branch name: {name}")));
        }
    }
    if !branch_exists(repo, &config.production)? {
        return Err(Error::Invalid(format!(
            "there's no {} branch to release from",
            config.production
        )));
    }
    let set = |key: &str, value: &str| {
        repo.run(&["config", "--local", &format!("gitflow.{key}"), value])
            .map(drop)
    };
    set("branch.master", &config.production)?;
    set("branch.develop", &config.develop)?;
    set("prefix.feature", &config.feature)?;
    set("prefix.release", &config.release)?;
    set("prefix.hotfix", &config.hotfix)?;
    set("prefix.support", "support/")?;
    set("prefix.versiontag", &config.version_tag)?;
    if !branch_exists(repo, &config.develop)? {
        repo.run(&["branch", "--", &config.develop, &config.production])?;
    }
    Ok(())
}

fn branch_exists(repo: &Repo, name: &str) -> Result<bool> {
    Ok(repo
        .output(&["rev-parse", "-q", "--verify", &format!("refs/heads/{name}")])?
        .success())
}

fn require(repo: &Repo) -> Result<FlowConfig> {
    config(repo)?.ok_or_else(|| Error::Invalid("set up Gitflow first".into()))
}

fn prefix(config: &FlowConfig, kind: FlowKind) -> &str {
    match kind {
        FlowKind::Feature => &config.feature,
        FlowKind::Release => &config.release,
        FlowKind::Hotfix => &config.hotfix,
    }
}

/// Creates and checks out `<prefix><name>` from where that kind starts.
pub fn start(repo: &Repo, kind: FlowKind, name: &str) -> Result<String> {
    let config = require(repo)?;
    if name.trim().is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) {
        return Err(Error::Invalid(format!("not a valid name: {name}")));
    }
    let branch = format!("{}{name}", prefix(&config, kind));
    let base = match kind {
        FlowKind::Feature | FlowKind::Release => &config.develop,
        FlowKind::Hotfix => &config.production,
    };
    repo.run(&["switch", "-c", &branch, base])?;
    Ok(branch)
}

/// Merges `<prefix><name>` where it belongs, tags releases and hotfixes,
/// deletes the branch and leaves develop checked out. Stops on conflicts
/// like any merge; finishing again after resolving continues from there.
pub fn finish(repo: &Repo, kind: FlowKind, name: &str, tag_message: Option<&str>) -> Result<()> {
    let config = require(repo)?;
    let branch = format!("{}{name}", prefix(&config, kind));
    if !branch_exists(repo, &branch)? {
        return Err(Error::Invalid(format!("there's no {branch} branch")));
    }
    let merge_into = |target: &str| -> Result<()> {
        repo.run(&["switch", target])?;
        // Already merged (a finish resumed after a conflict) is fine.
        if repo
            .output(&["merge-base", "--is-ancestor", &branch, "HEAD"])?
            .success()
        {
            return Ok(());
        }
        let message = format!("Merge branch '{branch}' into {target}");
        conflict_aware(
            repo,
            repo.run(&["merge", "--no-ff", "-m", &message, &branch]),
        )
    };
    match kind {
        FlowKind::Feature => merge_into(&config.develop)?,
        FlowKind::Release | FlowKind::Hotfix => {
            merge_into(&config.production)?;
            let tag = format!("{}{name}", config.version_tag);
            if !repo
                .output(&["rev-parse", "-q", "--verify", &format!("refs/tags/{tag}")])?
                .success()
            {
                let message = tag_message
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| tag.clone());
                repo.run_input(&["tag", "-a", "-F", "-", &tag], message.as_bytes())?;
            }
            merge_into(&config.develop)?;
        }
    }
    repo.run(&["branch", "-d", &branch]).map(drop)
}
