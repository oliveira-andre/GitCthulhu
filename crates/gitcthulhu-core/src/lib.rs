//! GitCthulhu's core: everything that touches a repository, with no UI
//! dependency. All repository access goes through the git command line.

pub mod askpass;
pub mod diff;
pub mod error;
pub mod git;
pub mod graph;
pub mod inspect;
pub mod log;
pub mod ops;
pub mod refs;
pub mod repo;
pub mod status;
pub mod store;
pub mod watch;

pub use error::{Error, Result};
pub use git::Git;
pub use repo::Repo;

use std::ffi::OsStr;
use std::path::Path;

/// Clones `url` into `dest`, which must not exist or be empty.
pub fn clone(git: &Git, url: &str, dest: &Path, progress: &mut dyn FnMut(&str)) -> Result<Repo> {
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(Error::Invalid(format!("not a repository URL: {url}")));
    }
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let args = [
        OsStr::new("clone"),
        OsStr::new("--progress"),
        OsStr::new("--"),
        OsStr::new(url),
        dest.as_os_str(),
    ];
    git.run_progress(parent, &args, progress)?;
    Repo::open(git, dest)
}
