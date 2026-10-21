#![allow(dead_code)]

use std::path::{Path, PathBuf};

use gitcthulhu_core::{Git, Repo};
use tempfile::TempDir;

/// A throwaway repository with its own git config, so the developer's
/// global settings (signing, hooks, default branch) can't change results.
pub struct Fixture {
    pub dir: TempDir,
    pub git: Git,
    pub repo: Repo,
}

pub fn git_in(dir: &Path) -> Git {
    let config = dir.join("gitconfig");
    std::fs::write(
        &config,
        "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[protocol \"file\"]\n\tallow = always\n",
    )
    .unwrap();
    Git::find()
        .unwrap()
        .with_env("GIT_CONFIG_GLOBAL", &config)
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
}

impl Fixture {
    pub fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let git = git_in(dir.path());
        let repo = Repo::init(&git, &dir.path().join("repo"), Some("main")).unwrap();
        Fixture { dir, git, repo }
    }

    pub fn path(&self, file: &str) -> PathBuf {
        self.repo.root().join(file)
    }

    pub fn write(&self, file: &str, contents: &str) {
        let path = self.path(file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    pub fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.path(file)).unwrap()
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.repo.run_text(args).unwrap()
    }

    /// Writes the files and commits them; returns the commit id.
    pub fn commit(&self, message: &str, files: &[(&str, &str)]) -> String {
        for (file, contents) in files {
            self.write(file, contents);
        }
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    /// The staged version of a file.
    pub fn staged(&self, file: &str) -> String {
        self.git(&["show", &format!(":{file}")])
    }
}
