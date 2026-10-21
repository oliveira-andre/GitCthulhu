use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::{Git, Output};

/// An open working tree. Every operation runs git in `root`.
#[derive(Debug, Clone)]
pub struct Repo {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    git: Git,
}

/// What the repository is in the middle of, read from the files git leaves
/// in its directory.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RepoState {
    Clean,
    Merging {
        head: Option<String>,
    },
    Rebasing {
        step: Option<u32>,
        total: Option<u32>,
        branch: Option<String>,
        onto: Option<String>,
    },
    CherryPicking {
        head: Option<String>,
    },
    Reverting {
        head: Option<String>,
    },
    /// `git am` stopped partway through a series of patches.
    ApplyingPatches {
        step: Option<u32>,
        total: Option<u32>,
    },
    Bisecting,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    /// The checked-out branch's short name; `None` when detached.
    pub branch: Option<String>,
    /// `None` on an unborn branch (no commits yet).
    pub oid: Option<String>,
}

impl Repo {
    /// Opens the working tree that contains `path`.
    pub fn open(git: &Git, path: &Path) -> Result<Repo> {
        if !path.is_dir() {
            return Err(Error::NotARepository(path.to_owned()));
        }
        let out = git.output(
            path,
            &[
                "rev-parse",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
            None,
        )?;
        if !out.success() {
            return Err(Error::NotARepository(path.to_owned()));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut lines = text.lines();
        let (Some(root), Some(git_dir), Some(common)) = (lines.next(), lines.next(), lines.next())
        else {
            // A bare repository has no top level.
            return Err(Error::NotARepository(path.to_owned()));
        };
        let root = PathBuf::from(root);
        let git_dir = PathBuf::from(git_dir);
        let common_dir = if Path::new(common).is_absolute() {
            PathBuf::from(common)
        } else {
            path.join(common)
        };
        Ok(Repo {
            root: dunce(root),
            git_dir: dunce(git_dir),
            common_dir: dunce(common_dir),
            git: git.clone(),
        })
    }

    /// Creates a repository in `path` (made if missing) and opens it.
    pub fn init(git: &Git, path: &Path, initial_branch: Option<&str>) -> Result<Repo> {
        std::fs::create_dir_all(path)?;
        let mut args = vec!["init".to_owned()];
        if let Some(branch) = initial_branch.filter(|b| !b.is_empty()) {
            args.push(format!("--initial-branch={branch}"));
        }
        git.run(path, &args)?;
        Repo::open(git, path)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// Shared by all worktrees: refs, config and objects live here.
    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    pub fn git(&self) -> &Git {
        &self.git
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
    }

    pub fn run<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<Vec<u8>> {
        self.git.run(&self.root, args)
    }

    pub fn run_text<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<String> {
        self.git.run_text(&self.root, args)
    }

    pub fn run_input<S: AsRef<OsStr>>(&self, args: &[S], input: &[u8]) -> Result<Vec<u8>> {
        self.git.run_input(&self.root, args, input)
    }

    pub fn output<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<Output> {
        self.git.output(&self.root, args, None)
    }

    pub fn head(&self) -> Result<Head> {
        let branch = self.output(&["symbolic-ref", "-q", "--short", "HEAD"])?;
        let oid = self.output(&["rev-parse", "-q", "--verify", "HEAD^{commit}"])?;
        let text = |out: &Output| {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
                .filter(|s| out.success() && !s.is_empty())
        };
        Ok(Head {
            branch: text(&branch),
            oid: text(&oid),
        })
    }

    pub fn state(&self) -> RepoState {
        let dir = &self.git_dir;
        let read = |name: &str| {
            std::fs::read_to_string(dir.join(name))
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        // `git am` shares rebase-apply with old-style rebases; it marks itself.
        if dir.join("rebase-apply/applying").is_file() {
            let number =
                |name: &str| read(&format!("rebase-apply/{name}")).and_then(|n| n.parse().ok());
            return RepoState::ApplyingPatches {
                step: number("next"),
                total: number("last"),
            };
        }
        for rebase_dir in ["rebase-merge", "rebase-apply"] {
            if dir.join(rebase_dir).is_dir() {
                let file = |name: &str| read(&format!("{rebase_dir}/{name}"));
                let number = |name: &str| file(name).and_then(|n| n.parse().ok());
                let (step, total) = if rebase_dir == "rebase-merge" {
                    (number("msgnum"), number("end"))
                } else {
                    (number("next"), number("last"))
                };
                return RepoState::Rebasing {
                    step,
                    total,
                    branch: file("head-name")
                        .map(|h| h.trim_start_matches("refs/heads/").to_owned()),
                    onto: file("onto"),
                };
            }
        }
        if let Some(head) = read("MERGE_HEAD") {
            return RepoState::Merging {
                head: head.lines().next().map(str::to_owned),
            };
        }
        if let Some(head) = read("CHERRY_PICK_HEAD") {
            return RepoState::CherryPicking { head: Some(head) };
        }
        if let Some(head) = read("REVERT_HEAD") {
            return RepoState::Reverting { head: Some(head) };
        }
        if dir.join("BISECT_LOG").is_file() {
            return RepoState::Bisecting;
        }
        RepoState::Clean
    }

    /// The commit message git prepared for a merge, revert or conflicted
    /// cherry-pick, so the commit box can start from it.
    pub fn prepared_message(&self) -> Option<String> {
        let message = std::fs::read_to_string(self.git_dir.join("MERGE_MSG")).ok()?;
        let kept: Vec<&str> = message.lines().filter(|l| !l.starts_with('#')).collect();
        Some(kept.join("\n").trim().to_owned()).filter(|m| !m.is_empty())
    }

    /// Whether git has a commit-graph file. Without one, sorting history
    /// (`--date-order`) reads every commit first, which takes seconds on a
    /// long history; `git gc` and `git maintenance` write it.
    pub fn has_commit_graph(&self) -> bool {
        let info = self.common_dir.join("objects/info");
        info.join("commit-graph").is_file()
            || info.join("commit-graphs/commit-graph-chain").is_file()
    }

    pub fn remotes(&self) -> Result<Vec<String>> {
        Ok(self
            .run_text(&["remote"])?
            .lines()
            .map(str::to_owned)
            .collect())
    }

    pub fn config_get(&self, key: &str) -> Result<Option<String>> {
        let out = self.output(&["config", "--get", key])?;
        Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
            .filter(|v| out.success() && !v.is_empty()))
    }
}

/// On Windows git prints `C:/x/y`; normalize separators so paths compare.
fn dunce(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().replace('/', "\\"))
    } else {
        path
    }
}
