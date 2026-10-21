mod common;

use common::{Fixture, git_in};
use gitcthulhu_core::gitflow::{self, FlowConfig, FlowKind};
use gitcthulhu_core::submodules::{self, SubmoduleState};
use gitcthulhu_core::{Repo, lfs, worktrees};

fn flow_config() -> FlowConfig {
    FlowConfig {
        production: "main".into(),
        develop: "develop".into(),
        feature: "feature/".into(),
        release: "release/".into(),
        hotfix: "hotfix/".into(),
        version_tag: "v".into(),
    }
}

#[test]
fn submodules_are_listed_updated_and_added() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    // A second repository to use as the submodule.
    let lib_dir = f.dir.path().join("lib");
    let lib = Repo::init(&f.git, &lib_dir, Some("main")).unwrap();
    std::fs::write(lib_dir.join("lib.txt"), "lib\n").unwrap();
    lib.run(&["add", "-A"]).unwrap();
    lib.run(&["commit", "-q", "-m", "lib"]).unwrap();

    assert!(submodules::list(&f.repo).unwrap().is_empty());
    submodules::add(
        &f.repo,
        lib_dir.to_str().unwrap(),
        "vendor/lib",
        &mut |_| {},
    )
    .unwrap();
    f.git(&["commit", "-q", "-m", "add submodule"]);
    let list = submodules::list(&f.repo).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "vendor/lib");
    assert_eq!(list[0].state, SubmoduleState::Current);
    assert_eq!(list[0].url.as_deref(), Some(lib_dir.to_str().unwrap()));

    // A fresh clone has it uninitialized until it's updated.
    let clone_dir = f.dir.path().join("clone");
    let clone = gitcthulhu_core::clone(
        &git_in(f.dir.path()),
        f.repo.root().to_str().unwrap(),
        &clone_dir,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        submodules::list(&clone).unwrap()[0].state,
        SubmoduleState::Uninitialized
    );
    submodules::update(&clone, Some("vendor/lib"), &mut |_| {}).unwrap();
    assert_eq!(
        submodules::list(&clone).unwrap()[0].state,
        SubmoduleState::Current
    );
    assert!(clone_dir.join("vendor/lib/lib.txt").exists());
}

#[test]
fn worktrees_are_added_listed_and_removed() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let path = f.dir.path().join("second checkout");
    worktrees::add(&f.repo, &path, "topic", true, None).unwrap();
    let list = worktrees::list(&f.repo).unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].main && list[0].current);
    assert_eq!(list[1].branch.as_deref(), Some("topic"));
    assert!(path.join("a.txt").exists());

    // Opening the linked one sees itself as current.
    let linked = Repo::open(&f.git, &path).unwrap();
    assert!(worktrees::list(&linked).unwrap()[1].current);

    std::fs::write(path.join("dirty.txt"), "x").unwrap();
    assert!(
        worktrees::remove(&f.repo, &path, false).is_err(),
        "uncommitted changes need force"
    );
    worktrees::remove(&f.repo, &path, true).unwrap();
    worktrees::prune(&f.repo).unwrap();
    assert_eq!(worktrees::list(&f.repo).unwrap().len(), 1);
}

#[test]
fn lfs_tracks_patterns_and_lists_files() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let status = lfs::status(&f.repo).unwrap();
    if status.version.is_none() {
        eprintln!("git-lfs isn't installed; skipping");
        return;
    }
    lfs::install(&f.repo).unwrap();
    lfs::track(&f.repo, "*.bin").unwrap();
    assert_eq!(lfs::status(&f.repo).unwrap().patterns, ["*.bin"]);
    f.write("big.bin", "pretend this is large\n");
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", "binary"]);
    let status = lfs::status(&f.repo).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "big.bin");
    assert!(status.files[0].downloaded);
    lfs::untrack(&f.repo, "*.bin").unwrap();
    assert!(lfs::status(&f.repo).unwrap().patterns.is_empty());
}

#[test]
fn gitflow_features_releases_and_hotfixes() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    assert_eq!(gitflow::config(&f.repo).unwrap(), None);
    assert!(
        gitflow::start(&f.repo, FlowKind::Feature, "x").is_err(),
        "needs setting up"
    );

    gitflow::init(&f.repo, &flow_config()).unwrap();
    assert_eq!(gitflow::config(&f.repo).unwrap(), Some(flow_config()));
    assert!(
        f.repo
            .output(&["rev-parse", "--verify", "develop"])
            .unwrap()
            .success()
    );

    let branch = gitflow::start(&f.repo, FlowKind::Feature, "login").unwrap();
    assert_eq!(branch, "feature/login");
    f.commit("login form", &[("login.txt", "form\n")]);
    gitflow::finish(&f.repo, FlowKind::Feature, "login", None).unwrap();
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("develop"));
    assert!(f.path("login.txt").exists());
    assert!(
        !f.repo
            .output(&["rev-parse", "-q", "--verify", "refs/heads/feature/login"])
            .unwrap()
            .success()
    );

    gitflow::start(&f.repo, FlowKind::Release, "1.0.0").unwrap();
    f.commit("bump version", &[("VERSION", "1.0.0\n")]);
    gitflow::finish(&f.repo, FlowKind::Release, "1.0.0", Some("First release")).unwrap();
    // Tagged on production, and merged into both branches.
    assert_eq!(
        f.git(&["tag", "-l", "-n1", "v1.0.0"])
            .split_whitespace()
            .nth(1),
        Some("First")
    );
    assert_eq!(f.git(&["show", "main:VERSION"]), "1.0.0\n");
    assert_eq!(f.git(&["show", "develop:VERSION"]), "1.0.0\n");
    assert_eq!(f.git(&["show", "main:login.txt"]), "form\n");

    gitflow::start(&f.repo, FlowKind::Hotfix, "1.0.1").unwrap();
    assert_eq!(
        f.git(&["rev-parse", "HEAD^{tree}"]),
        f.git(&["rev-parse", "main^{tree}"]),
        "hotfixes start from production"
    );
    f.commit("fix", &[("VERSION", "1.0.1\n")]);
    gitflow::finish(&f.repo, FlowKind::Hotfix, "1.0.1", None).unwrap();
    assert_eq!(f.git(&["show", "main:VERSION"]), "1.0.1\n");
    assert_eq!(f.git(&["show", "develop:VERSION"]), "1.0.1\n");
    assert!(
        f.repo
            .output(&["rev-parse", "-q", "--verify", "refs/tags/v1.0.1"])
            .unwrap()
            .success()
    );
}
