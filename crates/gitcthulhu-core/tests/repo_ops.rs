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
