mod common;

use common::{Fixture, git_in};
use gitcthulhu_core::inspect::{self, DiffTarget};
use gitcthulhu_core::log::{self, GraphOptions, RowKind, WORK_IN_PROGRESS};
use gitcthulhu_core::ops::{
    self, CommitOptions, ConflictSide, LineAction, MergeMode, PullMode, PushOptions, ResetMode,
    Sequence,
};
use gitcthulhu_core::refs::{self, RefKind};
use gitcthulhu_core::repo::RepoState;
use gitcthulhu_core::status::{self, ChangeKind};
use gitcthulhu_core::{Error, Repo};

fn graph(f: &Fixture, wip: bool) -> log::Graph {
    log::load(
        &f.repo,
        &GraphOptions {
            limit: 100,
            work_in_progress: wip,
            filter: Default::default(),
        },
    )
    .unwrap()
}

#[test]
fn opens_from_a_subdirectory_and_reads_head() {
    let f = Fixture::new();
    f.commit("first", &[("dir/a.txt", "a\n")]);
    let repo = Repo::open(&f.git, &f.path("dir")).unwrap();
    assert_eq!(repo.root(), f.repo.root());
    let head = repo.head().unwrap();
    assert_eq!(head.branch.as_deref(), Some("main"));
    assert!(head.oid.is_some());
    assert_eq!(repo.state(), RepoState::Clean);

    let not_repo = tempfile::tempdir().unwrap();
    assert!(matches!(
        Repo::open(&f.git, not_repo.path()),
        Err(Error::NotARepository(_))
    ));
}

#[test]
fn an_empty_repository_has_an_empty_graph() {
    let f = Fixture::new();
    assert_eq!(f.repo.head().unwrap().oid, None);
    let g = graph(&f, true);
    assert_eq!(g.commits.len(), 1);
    assert_eq!(g.commits[0].kind, RowKind::WorkInProgress);
    assert!(g.commits[0].parents.is_empty());
}

#[test]
fn graph_shows_branches_merges_stashes_and_work_in_progress() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "1\n")]);
    f.git(&["switch", "-q", "-c", "feature"]);
    let feature = f.commit("feature work", &[("b.txt", "b\n")]);
    f.git(&["switch", "-q", "main"]);
    f.commit("main work", &[("a.txt", "2\n")]);
    f.git(&["merge", "-q", "--no-edit", "feature"]);
    f.write("a.txt", "dirty\n");
    f.write("untracked.txt", "u\n");
    ops::stash_push(&f.repo, Some("parked"), true).unwrap();
    f.write("a.txt", "dirty again\n");

    let g = graph(&f, true);
    let subjects: Vec<&str> = g.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(g.commits[0].oid, WORK_IN_PROGRESS);
    let stash = g
        .commits
        .iter()
        .find(|c| c.kind == RowKind::Stash)
        .expect("stash row");
    assert!(stash.subject.contains("parked"), "{subjects:?}");
    assert_eq!(stash.stash.as_deref(), Some("stash@{0}"));
    assert_eq!(
        stash.parents.len(),
        1,
        "a stash links only to its base commit"
    );
    // The stash's index and untracked commits are internal.
    assert!(
        !subjects
            .iter()
            .any(|s| s.starts_with("index on") || s.starts_with("untracked files on")),
        "{subjects:?}"
    );
    assert!(g.commits.iter().any(|c| c.oid == feature));
    assert_eq!(g.commits.last().unwrap().oid, base);
    assert_eq!(g.rows.len(), g.commits.len());
    // The merge put feature work on a second lane.
    let feature_row = g.commits.iter().position(|c| c.oid == feature).unwrap();
    assert_eq!(g.rows[feature_row].lane, 1);
    assert!(!g.truncated);
}

#[test]
fn graph_limit_truncates() {
    let f = Fixture::new();
    for i in 0..5 {
        f.commit(&format!("c{i}"), &[("a.txt", &i.to_string())]);
    }
    let g = log::load(
        &f.repo,
        &GraphOptions {
            limit: 3,
            work_in_progress: false,
            filter: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(g.commits.len(), 3);
    assert!(g.truncated);
}

#[test]
fn status_stage_unstage_and_discard() {
    let f = Fixture::new();
    f.commit("first", &[("a.txt", "a\n"), ("gone.txt", "x\n")]);
    f.write("a.txt", "changed\n");
    f.write("new.txt", "new\n");
    std::fs::remove_file(f.path("gone.txt")).unwrap();

    let s = status::status(&f.repo).unwrap();
    let unstaged: Vec<_> = s
        .unstaged
        .iter()
        .map(|c| (c.path.as_str(), c.kind))
        .collect();
    assert_eq!(
        unstaged,
        [
            ("a.txt", ChangeKind::Modified),
            ("gone.txt", ChangeKind::Deleted),
            ("new.txt", ChangeKind::Untracked)
        ]
    );
    assert!(s.staged.is_empty());

    ops::stage_paths(&f.repo, &["gone.txt".into(), "new.txt".into()]).unwrap();
    let s = status::status(&f.repo).unwrap();
    let staged: Vec<_> = s.staged.iter().map(|c| (c.path.as_str(), c.kind)).collect();
    assert_eq!(
        staged,
        [
            ("gone.txt", ChangeKind::Deleted),
            ("new.txt", ChangeKind::Added)
        ]
    );

    ops::unstage_paths(&f.repo, &["new.txt".into()]).unwrap();
    assert_eq!(status::status(&f.repo).unwrap().staged.len(), 1);

    ops::discard_paths(&f.repo, &["a.txt".into(), "new.txt".into()]).unwrap();
    assert_eq!(f.read("a.txt"), "a\n");
    assert!(!f.path("new.txt").exists());

    ops::stage_all(&f.repo).unwrap();
    ops::unstage_all(&f.repo).unwrap();
    let s = status::status(&f.repo).unwrap();
    assert!(s.staged.is_empty());
    assert_eq!(s.unstaged.len(), 1);
}

#[test]
fn unstaging_works_before_the_first_commit() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    ops::stage_all(&f.repo).unwrap();
    ops::unstage_paths(&f.repo, &["a.txt".into()]).unwrap();
    let s = status::status(&f.repo).unwrap();
    assert!(s.staged.is_empty());
    assert_eq!(s.unstaged[0].kind, ChangeKind::Untracked);
}

const BEFORE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
const AFTER: &str = "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n";

#[test]
fn stages_a_single_hunk_and_single_lines() {
    let f = Fixture::new();
    f.commit("first", &[("f.txt", BEFORE)]);
    f.write("f.txt", AFTER);

    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3).unwrap();
    assert_eq!(diff.hunks.len(), 2);

    // Stage the second hunk whole.
    ops::apply_lines(
        &f.repo,
        LineAction::Stage,
        "f.txt",
        1,
        &diff.hunks[1].header,
        None,
        3,
    )
    .unwrap();
    assert_eq!(
        f.staged("f.txt"),
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n"
    );

    // Unstage only the "eleven" line.
    let staged = inspect::file_diff(&f.repo, &DiffTarget::Staged, "f.txt", None, 3).unwrap();
    let hunk = &staged.hunks[0];
    let eleven = hunk.lines.iter().position(|l| l.text == "eleven").unwrap();
    ops::apply_lines(
        &f.repo,
        LineAction::Unstage,
        "f.txt",
        0,
        &hunk.header,
        Some(&[eleven]),
        3,
    )
    .unwrap();
    assert_eq!(
        f.staged("f.txt"),
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n"
    );

    // Stage just the removal of "one", leaving "ONE" unstaged.
    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3).unwrap();
    let hunk = &diff.hunks[0];
    let removal = hunk.lines.iter().position(|l| l.text == "one").unwrap();
    ops::apply_lines(
        &f.repo,
        LineAction::Stage,
        "f.txt",
        0,
        &hunk.header,
        Some(&[removal]),
        3,
    )
    .unwrap();
    assert!(f.staged("f.txt").starts_with("two\n"));

    // The working tree was never touched.
    assert_eq!(f.read("f.txt"), AFTER);
}

#[test]
fn discards_chosen_lines_from_the_working_tree() {
    let f = Fixture::new();
    f.commit("first", &[("f.txt", BEFORE)]);
    f.write("f.txt", AFTER);
    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3).unwrap();
    let hunk = &diff.hunks[1];
    let eleven = hunk.lines.iter().position(|l| l.text == "eleven").unwrap();
    ops::apply_lines(
        &f.repo,
        LineAction::Discard,
        "f.txt",
        1,
        &hunk.header,
        Some(&[eleven]),
        3,
    )
    .unwrap();
    assert_eq!(
        f.read("f.txt"),
        "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n"
    );
}

#[test]
fn stages_part_of_an_untracked_file() {
    let f = Fixture::new();
    f.commit("first", &[("a.txt", "a\n")]);
    f.write("new.txt", "keep\nskip\n");
    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "new.txt", None, 3).unwrap();
    assert!(diff.new_file);
    let hunk = &diff.hunks[0];
    ops::apply_lines(
        &f.repo,
        LineAction::Stage,
        "new.txt",
        0,
        &hunk.header,
        Some(&[0]),
        3,
    )
    .unwrap();
    assert_eq!(f.staged("new.txt"), "keep\n");
}

#[test]
fn a_stale_hunk_is_refused() {
    let f = Fixture::new();
    f.commit("first", &[("f.txt", BEFORE)]);
    f.write("f.txt", AFTER);
    let result = ops::apply_lines(
        &f.repo,
        LineAction::Stage,
        "f.txt",
        0,
        "@@ -1,2 +1,2 @@",
        None,
        3,
    );
    assert!(matches!(result, Err(Error::Invalid(_))));
}

#[test]
fn commits_and_amends() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    ops::stage_all(&f.repo).unwrap();
    let oid = ops::commit(
        &f.repo,
        &CommitOptions {
            message: "Summary\n\nBody text",
            amend: false,
            allow_empty: false,
            sign_off: false,
            no_verify: false,
        },
    )
    .unwrap();
    let details = inspect::commit_details(&f.repo, &oid).unwrap();
    assert_eq!(details.summary, "Summary");
    assert_eq!(details.body, "Body text");
    assert_eq!(details.files[0].path, "a.txt");
    assert_eq!(details.files[0].kind, ChangeKind::Added);

    let amended = ops::commit(
        &f.repo,
        &CommitOptions {
            message: "Reworded",
            amend: true,
            allow_empty: false,
            sign_off: false,
            no_verify: false,
        },
    )
    .unwrap();
    assert_ne!(amended, oid);
    assert_eq!(ops::head_message(&f.repo).unwrap(), "Reworded");
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]).trim(), "1");

    let empty = ops::commit(
        &f.repo,
        &CommitOptions {
            message: "  ",
            amend: false,
            allow_empty: false,
            sign_off: false,
            no_verify: false,
        },
    );
    assert!(matches!(empty, Err(Error::Invalid(_))));
}

#[test]
fn commit_diff_and_root_commit_diff() {
    let f = Fixture::new();
    let first = f.commit("first", &[("a.txt", "a\n")]);
    let second = f.commit("second", &[("a.txt", "b\n")]);
    let root = inspect::file_diff(
        &f.repo,
        &DiffTarget::Commit { oid: first },
        "a.txt",
        None,
        3,
    )
    .unwrap();
    assert_eq!(root.hunks[0].lines[0].text, "a");
    let d = inspect::file_diff(
        &f.repo,
        &DiffTarget::Commit { oid: second },
        "a.txt",
        None,
        3,
    )
    .unwrap();
    let texts: Vec<_> = d.hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["a", "b"]);
}

#[test]
fn renames_are_detected_in_commits() {
    let f = Fixture::new();
    f.commit("first", &[("old.txt", "same content\nacross the rename\n")]);
    f.git(&["mv", "old.txt", "new.txt"]);
    f.git(&["commit", "-q", "-m", "rename"]);
    let head = f.git(&["rev-parse", "HEAD"]).trim().to_owned();
    let details = inspect::commit_details(&f.repo, &head).unwrap();
    assert_eq!(details.files.len(), 1);
    assert_eq!(details.files[0].kind, ChangeKind::Renamed);
    assert_eq!(details.files[0].old_path.as_deref(), Some("old.txt"));
}

#[test]
fn branches_checkout_rename_and_delete() {
    let f = Fixture::new();
    let first = f.commit("first", &[("a.txt", "a\n")]);
    f.commit("second", &[("a.txt", "b\n")]);

    ops::create_branch(&f.repo, "topic", Some(&first), false).unwrap();
    let topic = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "topic")
        .unwrap();
    assert_eq!(topic.oid, first);
    assert!(!topic.is_head);

    ops::checkout_branch(&f.repo, "topic").unwrap();
    assert_eq!(f.read("a.txt"), "a\n");
    ops::rename_branch(&f.repo, "topic", "renamed").unwrap();
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("renamed"));

    ops::checkout_branch(&f.repo, "main").unwrap();
    ops::delete_branch(&f.repo, "renamed", false).unwrap();
    assert!(
        !refs::list(&f.repo)
            .unwrap()
            .iter()
            .any(|r| r.short == "renamed")
    );

    ops::create_branch(&f.repo, "made-and-checked-out", None, true).unwrap();
    assert_eq!(
        f.repo.head().unwrap().branch.as_deref(),
        Some("made-and-checked-out")
    );

    ops::checkout_detached(&f.repo, &first).unwrap();
    assert_eq!(f.repo.head().unwrap().branch, None);
    assert!(ops::create_branch(&f.repo, "--force", None, false).is_err());
}

#[test]
fn merge_conflicts_are_reported_and_can_be_resolved() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "base\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.commit("theirs", &[("a.txt", "theirs\n")]);
    f.git(&["switch", "-q", "main"]);
    f.commit("ours", &[("a.txt", "ours\n")]);

    let result = ops::merge(&f.repo, "other", MergeMode::Default);
    assert!(matches!(result, Err(Error::Conflicts(_))), "{result:?}");
    assert!(matches!(f.repo.state(), RepoState::Merging { .. }));
    let s = status::status(&f.repo).unwrap();
    assert_eq!(s.conflicted[0].path, "a.txt");
    assert!(
        f.repo
            .prepared_message()
            .unwrap()
            .starts_with("Merge branch 'other'")
    );

    ops::resolve_with(&f.repo, &["a.txt".into()], ConflictSide::Theirs).unwrap();
    assert_eq!(f.read("a.txt"), "theirs\n");
    ops::sequence(&f.repo, Sequence::Continue).unwrap();
    assert_eq!(f.repo.state(), RepoState::Clean);
    assert_eq!(
        f.git(&["rev-list", "--count", "--merges", "HEAD"]).trim(),
        "1"
    );
}

#[test]
fn an_aborted_rebase_leaves_the_branch_alone() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "base\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.commit("theirs", &[("a.txt", "theirs\n")]);
    f.git(&["switch", "-q", "main"]);
    let ours = f.commit("ours", &[("a.txt", "ours\n")]);

    assert!(matches!(
        ops::rebase(&f.repo, "other"),
        Err(Error::Conflicts(_))
    ));
    assert!(matches!(f.repo.state(), RepoState::Rebasing { .. }));
    ops::sequence(&f.repo, Sequence::Abort).unwrap();
    assert_eq!(f.repo.state(), RepoState::Clean);
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), ours);
}

#[test]
fn cherry_pick_revert_and_reset() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "a\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    let picked = f.commit("add b", &[("b.txt", "b\n")]);
    f.git(&["switch", "-q", "main"]);

    ops::cherry_pick(&f.repo, std::slice::from_ref(&picked)).unwrap();
    assert_eq!(f.read("b.txt"), "b\n");
    let head = f.git(&["rev-parse", "HEAD"]).trim().to_owned();
    ops::revert(&f.repo, &head).unwrap();
    assert!(!f.path("b.txt").exists());

    ops::reset(&f.repo, &base, ResetMode::Soft).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), base);
    ops::reset(&f.repo, &base, ResetMode::Hard).unwrap();
    assert!(status::status(&f.repo).unwrap().is_clean());
}

#[test]
fn stash_apply_pop_and_drop() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    f.write("a.txt", "changed\n");
    ops::stash_push(&f.repo, Some("first"), false).unwrap();
    assert_eq!(f.read("a.txt"), "a\n");
    let stashes = log::stash_list(&f.repo).unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("first"));

    ops::stash_apply(&f.repo, "stash@{0}", false).unwrap();
    assert_eq!(f.read("a.txt"), "changed\n");
    assert_eq!(log::stash_list(&f.repo).unwrap().len(), 1);
    ops::discard_paths(&f.repo, &["a.txt".into()]).unwrap();

    ops::stash_apply(&f.repo, "stash@{0}", true).unwrap();
    assert!(log::stash_list(&f.repo).unwrap().is_empty());

    ops::stash_push(&f.repo, None, false).unwrap();
    ops::stash_drop(&f.repo, "stash@{0}").unwrap();
    assert!(log::stash_list(&f.repo).unwrap().is_empty());
    assert!(ops::stash_drop(&f.repo, "--all").is_err());
}

#[test]
fn tags() {
    let f = Fixture::new();
    let oid = f.commit("base", &[("a.txt", "a\n")]);
    ops::create_tag(&f.repo, "v1.0", &oid, Some("Release")).unwrap();
    ops::create_tag(&f.repo, "light", &oid, None).unwrap();
    let tags: Vec<_> = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .filter(|r| r.kind == RefKind::Tag)
        .collect();
    assert_eq!(tags.len(), 2);
    assert!(
        tags.iter().all(|t| t.oid == oid),
        "annotated tags are peeled"
    );
    assert!(tags.iter().find(|t| t.short == "v1.0").unwrap().annotated);
    ops::delete_tag(&f.repo, "light").unwrap();
}

#[test]
fn fetch_pull_and_push_with_a_remote() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let remote_dir = f.dir.path().join("remote.git");
    f.git
        .run(
            f.dir.path(),
            &["init", "-q", "--bare", remote_dir.to_str().unwrap()],
        )
        .unwrap();
    ops::add_remote(&f.repo, "origin", remote_dir.to_str().unwrap()).unwrap();
    assert_eq!(
        ops::default_remote(&f.repo).unwrap().as_deref(),
        Some("origin")
    );

    let mut lines = Vec::new();
    ops::push(
        &f.repo,
        &PushOptions {
            remote: "origin",
            branch: "main",
            remote_branch: None,
            set_upstream: true,
            force: false,
        },
        &mut |l| lines.push(l.to_owned()),
    )
    .unwrap();
    let main = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "main")
        .unwrap();
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));

    // A second clone pushes a commit, which the first then pulls.
    let other_dir = f.dir.path().join("other");
    let other = gitcthulhu_core::clone(
        &f.git,
        remote_dir.to_str().unwrap(),
        &other_dir,
        &mut |_| {},
    )
    .unwrap();
    std::fs::write(other_dir.join("b.txt"), "b\n").unwrap();
    other.run(&["add", "-A"]).unwrap();
    other.run(&["commit", "-q", "-m", "from other"]).unwrap();
    other.run(&["push", "-q"]).unwrap();

    ops::fetch(&f.repo, None, &mut |_| {}).unwrap();
    let main = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "main")
        .unwrap();
    assert_eq!((main.ahead, main.behind), (0, 1));
    ops::pull(&f.repo, PullMode::FastForwardOnly, &mut |_| {}).unwrap();
    assert_eq!(f.read("b.txt"), "b\n");

    // Checking out a remote-only branch creates a tracking branch.
    other.run(&["switch", "-q", "-c", "feature"]).unwrap();
    other
        .run(&["push", "-q", "-u", "origin", "feature"])
        .unwrap();
    ops::fetch(&f.repo, Some("origin"), &mut |_| {}).unwrap();
    let local = ops::checkout_remote_branch(&f.repo, "origin/feature").unwrap();
    assert_eq!(local, "feature");
    let feature = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "feature" && r.kind == RefKind::Local)
        .unwrap();
    assert_eq!(feature.upstream.as_deref(), Some("origin/feature"));

    ops::delete_remote_ref(&f.repo, "origin", "refs/heads/feature", &mut |_| {}).unwrap();
    ops::fetch(&f.repo, None, &mut |_| {}).unwrap();
    let feature = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "feature" && r.kind == RefKind::Local)
        .unwrap();
    assert!(feature.upstream_gone);
}

#[test]
fn fast_forwards_a_branch_that_is_not_checked_out() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "a\n")]);
    let tip = f.commit("tip", &[("a.txt", "b\n")]);
    ops::create_branch(&f.repo, "behind", Some(&base), false).unwrap();
    ops::fast_forward_branch(&f.repo, "behind", "main").unwrap();
    assert_eq!(f.git(&["rev-parse", "behind"]).trim(), tip);
}

#[test]
fn failed_network_commands_never_wait_for_a_terminal() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let git = git_in(f.dir.path());
    let missing = f.dir.path().join("does-not-exist.git");
    let result = gitcthulhu_core::clone(
        &git,
        missing.to_str().unwrap(),
        &f.dir.path().join("x"),
        &mut |_| {},
    );
    assert!(matches!(result, Err(Error::Git { .. })), "{result:?}");
}

#[test]
fn picks_and_reverts_several_commits() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    let one = f.commit("one", &[("one.txt", "1\n")]);
    let two = f.commit("two", &[("two.txt", "2\n")]);
    f.git(&["switch", "-q", "main"]);

    ops::cherry_pick(&f.repo, &[one, two]).unwrap();
    assert!(f.path("one.txt").exists() && f.path("two.txt").exists());
    let picked: Vec<String> = f
        .git(&["log", "-2", "--format=%H"])
        .lines()
        .map(str::to_owned)
        .collect();
    ops::revert_many(&f.repo, &picked).unwrap();
    assert!(!f.path("one.txt").exists() && !f.path("two.txt").exists());
    assert_eq!(
        f.git(&["log", "-1", "--format=%s"]).trim(),
        "Revert \"one\""
    );

    // A merge mixed with ordinary commits is refused up front.
    f.git(&["switch", "-q", "other"]);
    f.git(&["merge", "-q", "--no-ff", "--no-edit", "main"]);
    let merge = f.git(&["rev-parse", "HEAD"]).trim().to_owned();
    let plain = f.git(&["rev-parse", "HEAD^2"]).trim().to_owned();
    f.git(&["switch", "-q", "main"]);
    assert!(matches!(
        ops::cherry_pick(&f.repo, &[plain, merge]),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn stages_lines_from_a_full_file_diff() {
    let f = Fixture::new();
    f.commit("first", &[("f.txt", BEFORE)]);
    f.write("f.txt", AFTER);
    // Shown with all the context there is, the file is one hunk.
    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 100_000).unwrap();
    assert_eq!(diff.hunks.len(), 1);
    let hunk = &diff.hunks[0];
    let eleven = hunk.lines.iter().position(|l| l.text == "eleven").unwrap();
    ops::apply_lines(
        &f.repo,
        LineAction::Stage,
        "f.txt",
        0,
        &hunk.header,
        Some(&[eleven]),
        100_000,
    )
    .unwrap();
    assert_eq!(f.staged("f.txt"), format!("{BEFORE}eleven\n"));
    // Showing it with three lines of context and applying with another is refused, not misapplied.
    let three = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3).unwrap();
    assert!(
        ops::apply_lines(
            &f.repo,
            LineAction::Stage,
            "f.txt",
            0,
            &three.hunks[0].header,
            None,
            100_000
        )
        .is_err()
    );
}

#[test]
fn reads_file_versions_for_image_diffs() {
    use gitcthulhu_core::inspect::{BlobSource, blob};
    let f = Fixture::new();
    let first = f.commit("first", &[("img.png", "v1")]);
    f.write("img.png", "v2");
    ops::stage_all(&f.repo).unwrap();
    f.write("img.png", "v3");
    let read = |source: BlobSource| blob(&f.repo, &source, "img.png", 1024).unwrap();
    assert_eq!(
        read(BlobSource::Revision { rev: first.clone() }).as_deref(),
        Some(&b"v1"[..])
    );
    assert_eq!(read(BlobSource::Index).as_deref(), Some(&b"v2"[..]));
    assert_eq!(read(BlobSource::Worktree).as_deref(), Some(&b"v3"[..]));
    assert_eq!(
        blob(
            &f.repo,
            &BlobSource::Revision { rev: first.clone() },
            "missing.png",
            1024
        )
        .unwrap(),
        None
    );
    assert!(blob(&f.repo, &BlobSource::Worktree, "../escape.png", 1024).is_err());
    assert!(
        blob(&f.repo, &BlobSource::Worktree, "img.png", 1).is_err(),
        "too large"
    );
}

#[test]
fn ignoring_whitespace_hides_whitespace_only_changes() {
    let f = Fixture::new();
    f.commit("first", &[("f.txt", "a\nb\n")]);
    f.write("f.txt", "a  \n  b\nc\n");
    let all =
        inspect::file_diff_with(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3, false).unwrap();
    let lean =
        inspect::file_diff_with(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3, true).unwrap();
    let changed = |d: &gitcthulhu_core::diff::FileDiff| {
        d.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind != gitcthulhu_core::diff::LineKind::Context)
            .count()
    };
    assert_eq!(changed(&all), 5);
    assert_eq!(changed(&lean), 1, "only the added line remains");
}

#[test]
fn hidden_and_soloed_branches_change_what_the_graph_shows() {
    use gitcthulhu_core::log::RefFilter;
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    f.git(&["switch", "-q", "-c", "side"]);
    let side = f.commit("side work", &[("s.txt", "s\n")]);
    f.git(&["switch", "-q", "main"]);
    let main = f.commit("main work", &[("m.txt", "m\n")]);
    f.git(&["tag", "old", &side]);
    f.write("a.txt", "dirty\n");
    ops::stash_push(&f.repo, None, false).unwrap();

    let load = |filter: RefFilter| {
        let options = GraphOptions {
            limit: 100,
            work_in_progress: false,
            filter,
        };
        log::load(&f.repo, &options)
            .unwrap()
            .commits
            .into_iter()
            .map(|c| c.subject)
            .collect::<Vec<_>>()
    };
    assert!(load(RefFilter::default()).contains(&"side work".to_owned()));

    // Hiding the branch alone isn't enough while a tag still reaches the commit.
    let hidden = load(RefFilter {
        hidden: vec!["refs/heads/side".into()],
        ..Default::default()
    });
    assert!(hidden.contains(&"side work".to_owned()));
    let hidden = load(RefFilter {
        hidden: vec!["refs/heads/side".into(), "refs/tags/*".into()],
        hide_stashes: true,
        ..Default::default()
    });
    assert!(!hidden.contains(&"side work".to_owned()), "{hidden:?}");
    assert!(
        !hidden.iter().any(|s| s.contains("WIP on")),
        "stashes hidden"
    );

    let solo = load(RefFilter {
        solo: vec!["refs/heads/side".into()],
        ..Default::default()
    });
    assert_eq!(solo, ["side work", "base"]);
    let _ = main;

    let bad = GraphOptions {
        limit: 10,
        work_in_progress: false,
        filter: RefFilter {
            hidden: vec!["--output=x".into()],
            ..Default::default()
        },
    };
    assert!(log::load(&f.repo, &bad).is_err());
}

#[test]
fn counts_changes_per_commit_and_searches_all_history() {
    let f = Fixture::new();
    let first = f.commit("Summon the old ones", &[("a.txt", "1\n2\n3\n")]);
    let second = f.commit("Tidy", &[("a.txt", "1\nTWO\n3\n"), ("b.txt", "b\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["merge", "-q", "--no-ff", "--no-edit", "other"]);
    let stats = log::commit_stats(&f.repo, &[first.clone(), second.clone()]).unwrap();
    assert_eq!(
        (stats[0].files, stats[0].insertions, stats[0].deletions),
        (1, 3, 0),
        "the root commit counts too"
    );
    assert_eq!(
        (stats[1].files, stats[1].insertions, stats[1].deletions),
        (2, 2, 1)
    );

    let found = log::search(&f.repo, "summon", 50).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].oid, first);
    let by_author = log::search(&f.repo, "test user", 50).unwrap();
    assert!(by_author.len() >= 2);
    let by_sha = log::search(&f.repo, &second[..8], 50).unwrap();
    assert_eq!(by_sha[0].oid, second);
    assert!(log::search(&f.repo, "  ", 50).unwrap().is_empty());
}

#[test]
fn search_reads_whole_messages_and_stops_at_the_limit() {
    let f = Fixture::new();
    let tidy = f.commit("Tidy up\n\nAlso feeds the kraken.", &[("a.txt", "a\n")]);
    for n in 0..5 {
        f.commit(
            &format!("Kraken feeding {n}"),
            &[("a.txt", &format!("{n}\n"))],
        );
    }
    let in_body = log::search(&f.repo, "the KRAKEN", 50).unwrap();
    assert_eq!(in_body.len(), 1);
    assert_eq!(in_body[0].oid, tidy);
    assert_eq!(
        in_body[0].subject, "Tidy up",
        "the subject, not the whole message"
    );

    let few = log::search(&f.repo, "kraken", 3).unwrap();
    assert_eq!(few.len(), 3);
    assert!(few.windows(2).all(|w| w[0].commit_time >= w[1].commit_time));
    assert_eq!(log::search(&f.repo, "kraken", 50).unwrap().len(), 6);
}

#[test]
fn writes_a_commit_graph() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    assert!(!f.repo.has_commit_graph());
    assert!(!graph(&f, false).indexed);
    let mut progress = Vec::new();
    ops::write_commit_graph(&f.repo, &mut |line| progress.push(line.to_owned())).unwrap();
    assert!(f.repo.has_commit_graph());
    assert!(graph(&f, false).indexed);
}

#[test]
fn commit_options_identity_and_template() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    ops::stage_all(&f.repo).unwrap();
    // A hook that would refuse every commit.
    let hook = f.repo.git_dir().join("hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let options = |no_verify| CommitOptions {
        message: "signed",
        amend: false,
        allow_empty: false,
        sign_off: true,
        no_verify,
    };
    if cfg!(unix) {
        assert!(
            ops::commit(&f.repo, &options(false)).is_err(),
            "the hook runs"
        );
    }
    ops::commit(&f.repo, &options(true)).unwrap();
    assert!(
        ops::head_message(&f.repo)
            .unwrap()
            .contains("Signed-off-by: Test User <test@example.com>")
    );

    let me = ops::identity(&f.repo).unwrap();
    assert_eq!(me.name.as_deref(), Some("Test User"));
    assert!(!me.local);
    ops::set_identity(&f.repo, "Repo Person", "repo@example.com", false).unwrap();
    let me = ops::identity(&f.repo).unwrap();
    assert_eq!((me.name.as_deref(), me.local), (Some("Repo Person"), true));

    assert_eq!(ops::commit_template(&f.repo).unwrap(), None);
    f.write(".gitmessage", "# Explain why\nfeat: \n\nRefs: \n");
    f.git(&["config", "commit.template", ".gitmessage"]);
    assert_eq!(
        ops::commit_template(&f.repo).unwrap().as_deref(),
        Some("feat: \n\nRefs:")
    );
}

#[test]
fn a_missing_identity_is_reported_as_such() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("gitconfig");
    std::fs::write(
        &config,
        "[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n",
    )
    .unwrap();
    let git = gitcthulhu_core::Git::find()
        .unwrap()
        .with_env("GIT_CONFIG_GLOBAL", &config)
        .with_env("GIT_CONFIG_NOSYSTEM", "1");
    let repo = Repo::init(&git, &dir.path().join("r"), Some("main")).unwrap();
    std::fs::write(repo.root().join("a.txt"), "a").unwrap();
    ops::stage_all(&repo).unwrap();
    let error = ops::commit(
        &repo,
        &CommitOptions {
            message: "x",
            amend: false,
            allow_empty: false,
            sign_off: false,
            no_verify: false,
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), "identityUnknown", "{error}");
}

#[test]
fn remotes_can_be_edited_and_upstreams_set() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let remote_dir = f.dir.path().join("remote.git");
    f.git
        .run(
            f.dir.path(),
            &["init", "-q", "--bare", remote_dir.to_str().unwrap()],
        )
        .unwrap();
    ops::add_remote(&f.repo, "origin", "https://example.invalid/x.git").unwrap();
    ops::set_remote_url(&f.repo, "origin", remote_dir.to_str().unwrap()).unwrap();
    assert_eq!(
        ops::remote_url(&f.repo, "origin").unwrap().as_deref(),
        Some(remote_dir.to_str().unwrap())
    );
    ops::rename_remote(&f.repo, "origin", "upstream").unwrap();
    assert_eq!(f.repo.remotes().unwrap(), ["upstream"]);

    // Push main to a differently named branch, then track it.
    let options = PushOptions {
        remote: "upstream",
        branch: "main",
        remote_branch: Some("trunk"),
        set_upstream: false,
        force: false,
    };
    ops::push(&f.repo, &options, &mut |_| {}).unwrap();
    ops::fetch(&f.repo, None, &mut |_| {}).unwrap();
    ops::set_upstream(&f.repo, "main", Some("upstream/trunk")).unwrap();
    let main = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "main")
        .unwrap();
    assert_eq!(main.upstream.as_deref(), Some("upstream/trunk"));
    ops::set_upstream(&f.repo, "main", None).unwrap();
    let main = refs::list(&f.repo)
        .unwrap()
        .into_iter()
        .find(|r| r.short == "main")
        .unwrap();
    assert_eq!(main.upstream, None);
}

#[test]
fn clones_shallow_and_single_branch() {
    let f = Fixture::new();
    for i in 0..3 {
        f.commit(&format!("c{i}"), &[("a.txt", &i.to_string())]);
    }
    f.git(&["branch", "other"]);
    let url = format!("file://{}", f.repo.root().display());
    let options = gitcthulhu_core::CloneOptions {
        depth: Some(1),
        branch: Some("other".into()),
        single_branch: true,
        recurse_submodules: false,
    };
    let clone = gitcthulhu_core::clone_with(
        &f.git,
        &url,
        &f.dir.path().join("shallow"),
        &options,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        clone
            .run_text(&["rev-list", "--count", "HEAD"])
            .unwrap()
            .trim(),
        "1"
    );
    assert_eq!(clone.head().unwrap().branch.as_deref(), Some("other"));
    let remote_branches = clone.run_text(&["branch", "-r"]).unwrap();
    assert!(
        !remote_branches.contains("origin/main"),
        "{remote_branches}"
    );
}

#[test]
fn stages_and_unstages_lines_across_several_hunks() {
    use gitcthulhu_core::ops::LineSelection;
    let f = Fixture::new();
    f.commit("first", &[("f.txt", BEFORE)]);
    // Three separate changes, far enough apart to be three hunks.
    let lines: Vec<String> = (1..=30).map(|n| n.to_string()).collect();
    f.commit("long", &[("f.txt", &format!("{}\n", lines.join("\n")))]);
    let mut changed = lines.clone();
    changed[1] = "TWO".into();
    changed.insert(15, "inserted".into());
    changed[28] = "TWENTY-EIGHT".into();
    f.write("f.txt", &format!("{}\n", changed.join("\n")));

    let diff = inspect::file_diff(&f.repo, &DiffTarget::Unstaged, "f.txt", None, 3).unwrap();
    assert_eq!(diff.hunks.len(), 3);
    let pick = |hunk: usize, text: &str| {
        let h = &diff.hunks[hunk];
        LineSelection {
            hunk,
            header: h.header.clone(),
            lines: Some(vec![h.lines.iter().position(|l| l.text == text).unwrap()]),
        }
    };
    // Stage only the additions of hunks 0 and 2 (their removals stay as context), and all of hunk 1.
    let selections = vec![
        pick(0, "TWO"),
        LineSelection {
            hunk: 1,
            header: diff.hunks[1].header.clone(),
            lines: None,
        },
        pick(2, "TWENTY-EIGHT"),
    ];
    ops::apply_selection(&f.repo, LineAction::Stage, "f.txt", &selections, 3).unwrap();
    let staged = f.staged("f.txt");
    let staged: Vec<&str> = staged.lines().collect();
    assert_eq!(&staged[..4], ["1", "2", "TWO", "3"]);
    assert!(
        staged.contains(&"inserted") && staged.contains(&"TWENTY-EIGHT") && staged.contains(&"28")
    );

    // And back out, from the staged side, in one go.
    let staged_diff = inspect::file_diff(&f.repo, &DiffTarget::Staged, "f.txt", None, 3).unwrap();
    let all: Vec<LineSelection> = staged_diff
        .hunks
        .iter()
        .enumerate()
        .map(|(i, h)| LineSelection {
            hunk: i,
            header: h.header.clone(),
            lines: None,
        })
        .collect();
    ops::apply_selection(&f.repo, LineAction::Unstage, "f.txt", &all, 3).unwrap();
    assert_eq!(f.staged("f.txt"), format!("{}\n", lines.join("\n")));
}

#[test]
fn stashes_only_the_chosen_files() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    f.write("a.txt", "A\n");
    f.write("b.txt", "B\n");
    ops::stash_paths(&f.repo, Some("just a"), false, &["a.txt".into()]).unwrap();
    assert_eq!(f.read("a.txt"), "a\n");
    assert_eq!(f.read("b.txt"), "B\n", "b's change stays");
    ops::stash_apply(&f.repo, "stash@{0}", true).unwrap();
    assert_eq!(f.read("a.txt"), "A\n");
}

#[test]
fn stashes_can_be_renamed_and_show_their_untracked_files() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    f.write("a.txt", "A\n");
    f.write("new.txt", "brand new\n");
    ops::stash_push(&f.repo, Some("old name"), true).unwrap();
    let oid = log::stash_list(&f.repo).unwrap()[0].oid.clone();
    let (holder, files) = ops::stash_untracked(&f.repo, &oid).unwrap();
    assert!(holder.is_some());
    assert_eq!(
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["new.txt"]
    );
    let diff = inspect::file_diff(
        &f.repo,
        &DiffTarget::Commit {
            oid: holder.unwrap(),
        },
        "new.txt",
        None,
        3,
    )
    .unwrap();
    assert_eq!(diff.hunks[0].lines[0].text, "brand new");

    ops::stash_rename(&f.repo, "stash@{0}", "new name").unwrap();
    let stashes = log::stash_list(&f.repo).unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].oid, oid, "the same stash");
    assert_eq!(stashes[0].message, "new name");

    // A stash without untracked files has none to show.
    f.write("a.txt", "again\n");
    ops::stash_push(&f.repo, None, false).unwrap();
    let plain = log::stash_list(&f.repo).unwrap()[0].oid.clone();
    assert_eq!(ops::stash_untracked(&f.repo, &plain).unwrap().0, None);
}

#[test]
fn patches_are_saved_and_applied_as_changes_or_commits() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let one = f.commit("one", &[("one.txt", "1\n")]);
    let two = f.commit("two", &[("two.txt", "2\n")]);
    let series = f.dir.path().join("series.patch");
    std::fs::write(
        &series,
        ops::format_patch(&f.repo, &[one.clone(), two.clone()]).unwrap(),
    )
    .unwrap();

    // Back to before them, then replay as commits.
    let base = f.git(&["rev-parse", "HEAD~2"]).trim().to_owned();
    ops::reset(&f.repo, &base, ResetMode::Hard).unwrap();
    ops::apply_patch(&f.repo, &series, true).unwrap();
    assert_eq!(f.git(&["log", "--format=%s", "-2"]).trim(), "two\none");

    // Uncommitted changes as a patch, applied to a clean tree as changes.
    f.write("a.txt", "changed\n");
    let changes = f.dir.path().join("changes.patch");
    std::fs::write(&changes, ops::changes_patch(&f.repo).unwrap()).unwrap();
    ops::discard_paths(&f.repo, &["a.txt".into()]).unwrap();
    assert!(ops::changes_patch(&f.repo).is_err(), "nothing to save");
    ops::apply_patch(&f.repo, &changes, false).unwrap();
    assert_eq!(f.read("a.txt"), "changed\n");
}

#[test]
fn a_conflicting_patch_series_stops_and_can_be_aborted() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "base\n")]);
    let theirs = f.commit("theirs", &[("a.txt", "theirs\n")]);
    let patch = f.dir.path().join("theirs.patch");
    std::fs::write(&patch, ops::format_patch(&f.repo, &[theirs]).unwrap()).unwrap();
    let base = f.git(&["rev-parse", "HEAD~1"]).trim().to_owned();
    ops::reset(&f.repo, &base, ResetMode::Hard).unwrap();
    f.commit("ours", &[("a.txt", "ours\n")]);

    assert!(matches!(
        ops::apply_patch(&f.repo, &patch, true),
        Err(Error::Conflicts(_))
    ));
    assert!(
        matches!(f.repo.state(), RepoState::ApplyingPatches { .. }),
        "{:?}",
        f.repo.state()
    );
    ops::sequence(&f.repo, Sequence::Abort).unwrap();
    assert_eq!(f.repo.state(), RepoState::Clean);
}

#[test]
fn the_watcher_reports_changes_even_while_files_keep_changing() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "a\n")]);
    let (tx, rx) = mpsc::channel();
    let _watcher = gitcthulhu_core::watch::watch(&f.repo, move |change| {
        let _ = tx.send(change);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    // Keep writing faster than the quiet period for longer than the max wait.
    let start = Instant::now();
    let mut reported = None;
    while start.elapsed() < Duration::from_secs(5) {
        f.write("a.txt", &format!("{:?}\n", start.elapsed()));
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(change) = rx.try_recv() {
            reported = Some((change, start.elapsed()));
            break;
        }
    }
    let (change, after) = reported.expect("a change was reported while writing");
    assert!(change.files);
    assert!(after < Duration::from_secs(4), "reported after {after:?}");
}
