use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error(
        "Git isn't installed, or GitCthulhu can't find it. Install Git, or set GITCTHULHU_GIT to its path."
    )]
    GitNotFound,

    #[error("{} isn't a Git repository", .0.display())]
    NotARepository(PathBuf),

    #[error("{}", .stderr.trim())]
    Git {
        /// The git subcommand, for example `checkout`.
        command: String,
        code: Option<i32>,
        stderr: String,
    },

    /// A merge, rebase, cherry-pick or revert stopped on conflicts.
    #[error("{0}")]
    Conflicts(String),

    #[error("{0}")]
    Invalid(String),

    #[error("can't read git's output: {0}")]
    Parse(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Watch(#[from] notify::Error),
}

impl Error {
    /// A stable name for the UI to branch on.
    pub fn kind(&self) -> &'static str {
        match self {
            Error::GitNotFound => "gitNotFound",
            Error::NotARepository(_) => "notARepository",
            Error::Git { stderr, .. } if is_auth_failure(stderr) => "authFailed",
            Error::Git { .. } => "git",
            Error::Conflicts(_) => "conflicts",
            Error::Invalid(_) => "invalid",
            Error::Parse(_) => "parse",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
            Error::Watch(_) => "watch",
        }
    }
}

fn is_auth_failure(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    [
        "authentication failed",
        "could not read username",
        "could not read password",
        "permission denied (publickey",
        "terminal prompts disabled",
    ]
    .iter()
    .any(|needle| stderr.contains(needle))
}
