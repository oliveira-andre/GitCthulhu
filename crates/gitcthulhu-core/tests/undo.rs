mod common;

use common::Fixture;
use gitcthulhu_core::Error;
use gitcthulhu_core::ops::{self, CommitOptions, MergeMode, ResetMode};
use gitcthulhu_core::rebase;
use gitcthulhu_core::undo::{self, Change, Entry, History, TipMove};

/// Runs `op` and records it the way the app does.
fn recorded(f: &Fixture, history: &mut History, label: &str, tip: TipMove, op: impl FnOnce()) {
    let before = undo::capture(&f.repo).unwrap();
    op();
    let after = undo::capture(&f.repo).unwrap();
    history.record(Entry {
        label: label.into(),
        change: Change::Refs { before, after, tip },
    });
}

fn head(f: &Fixture) -> String {
    f.git(&["rev-parse", "HEAD"]).trim().to_owned()
}

#[test]
fn undoing_a_commit_brings_its_changes_back_staged() {
    let f = Fixture::new();
    let first = f.commit("first", &[("a.txt", "1\n")]);
    let mut history = History::default();
    f.write("a.txt", "2\n");
    ops::stage_all(&f.repo).unwrap();
    recorded(&f, &mut history, "Commit", TipMove::Soft, || {
        ops::commit(
            &f.repo,
            &CommitOptions {
                message: "second",
                amend: false,
                allow_empty: false,
                sign_off: false,
                no_verify: false,
            },
        )
        .unwrap();
    });
    assert_eq!(history.available().undo.as_deref(), Some("Commit"));

    assert_eq!(history.undo(&f.repo).unwrap(), "Commit");
    assert_eq!(head(&f), first);
    assert_eq!(f.staged("a.txt"), "2\n");
    assert_eq!(history.available().redo.as_deref(), Some("Commit"));

    history.redo(&f.repo).unwrap();
    assert_eq!(f.git(&["log", "-1", "--format=%s"]).trim(), "second");
}

#[test]
fn undoing_the_first_commit_leaves_an_unborn_branch_with_the_files_staged() {
    let f = Fixture::new();
    let mut history = History::default();
    f.write("a.txt", "1\n");
    ops::stage_all(&f.repo).unwrap();
    recorded(&f, &mut history, "Commit", TipMove::Soft, || {
        ops::commit(
            &f.repo,
            &CommitOptions {
                message: "first",
                amend: false,
                allow_empty: false,
                sign_off: false,
                no_verify: false,
            },
        )
        .unwrap();
    });
    history.undo(&f.repo).unwrap();
    assert_eq!(f.repo.head().unwrap().oid, None);
    assert_eq!(f.staged("a.txt"), "1\n");
    history.redo(&f.repo).unwrap();
    assert_eq!(f.git(&["log", "-1", "--format=%s"]).trim(), "first");
}

#[test]
fn checkout_branch_creation_rename_and_deletion() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "1\n")]);
    f.commit("tip", &[("a.txt", "2\n")]);
    let mut history = History::default();

    recorded(&f, &mut history, "Create topic", TipMove::Keep, || {
        ops::create_branch(&f.repo, "topic", Some(&base), true).unwrap()
    });
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("topic"));
    recorded(&f, &mut history, "Rename", TipMove::Keep, || {
        ops::rename_branch(&f.repo, "topic", "renamed").unwrap()
    });
    recorded(&f, &mut history, "Check out main", TipMove::Keep, || {
        ops::checkout_branch(&f.repo, "main").unwrap()
    });
    recorded(&f, &mut history, "Delete", TipMove::Keep, || {
        ops::delete_branch(&f.repo, "renamed", true).unwrap()
    });

    history.undo(&f.repo).unwrap(); // the branch is back
    assert_eq!(f.git(&["rev-parse", "renamed"]).trim(), base);
    history.undo(&f.repo).unwrap(); // back on it
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("renamed"));
    assert_eq!(f.read("a.txt"), "1\n");
    history.undo(&f.repo).unwrap(); // its old name
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("topic"));
    history.undo(&f.repo).unwrap(); // never created
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("main"));
    assert!(
        f.repo
            .output(&["rev-parse", "-q", "--verify", "topic"])
            .unwrap()
            .code
            != Some(0)
    );

    // And all the way forward again.
    for _ in 0..4 {
        history.redo(&f.repo).unwrap();
    }
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("main"));
    assert!(
        f.repo
            .output(&["rev-parse", "-q", "--verify", "renamed"])
            .unwrap()
            .code
            != Some(0)
    );
}

#[test]
fn undoing_a_merge_or_hard_reset_keeps_local_edits() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n"), ("notes.txt", "n\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.commit("other", &[("b.txt", "b\n")]);
    f.git(&["switch", "-q", "main"]);
    let main = f.commit("main", &[("a.txt", "2\n")]);
    let mut history = History::default();

    recorded(&f, &mut history, "Merge", TipMove::Keep, || {
        ops::merge(&f.repo, "other", MergeMode::NoFastForward).unwrap()
    });
    f.write("notes.txt", "edited after the merge\n");
    history.undo(&f.repo).unwrap();
    assert_eq!(head(&f), main);
    assert!(!f.path("b.txt").exists());
    assert_eq!(f.read("notes.txt"), "edited after the merge\n");
    history.redo(&f.repo).unwrap();
    assert!(f.path("b.txt").exists());
    ops::discard_paths(&f.repo, &["notes.txt".into()]).unwrap();

    let merged = head(&f);
    recorded(&f, &mut history, "Reset", TipMove::Keep, || {
        ops::reset(&f.repo, &main, ResetMode::Hard).unwrap()
    });
    history.undo(&f.repo).unwrap();
    assert_eq!(head(&f), merged);
}

#[test]
fn undoing_a_rebase_and_tag_changes() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "1\n")]);
    f.commit("one", &[("one.txt", "1\n")]);
    let tip = f.commit("two", &[("two.txt", "2\n")]);
    let mut history = History::default();

    recorded(&f, &mut history, "Drop", TipMove::Keep, || {
        rebase::drop_commit(&f.repo, &tip).unwrap()
    });
    recorded(&f, &mut history, "Tag", TipMove::Keep, || {
        ops::create_tag(&f.repo, "v1", &base, None).unwrap()
    });
    history.undo(&f.repo).unwrap();
    assert!(
        f.repo
            .output(&["rev-parse", "-q", "--verify", "refs/tags/v1"])
            .unwrap()
            .code
            != Some(0)
    );
    history.undo(&f.repo).unwrap();
    assert_eq!(head(&f), tip);
    assert!(f.path("two.txt").exists());
}

#[test]
fn undoing_a_discard_writes_the_files_back() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n")]);
    f.write("a.txt", "precious edit\n");
    f.write("new.txt", "new file\n");
    let paths = vec!["a.txt".to_owned(), "new.txt".to_owned()];
    let mut history = History::default();

    let before = undo::backup_files(&f.repo, &paths).unwrap();
    ops::discard_paths(&f.repo, &paths).unwrap();
    let after = undo::backup_files(&f.repo, &paths).unwrap();
    history.record(Entry {
        label: "Discard".into(),
        change: Change::Files { before, after },
    });
    assert_eq!(f.read("a.txt"), "1\n");
    assert!(!f.path("new.txt").exists());

    history.undo(&f.repo).unwrap();
    assert_eq!(f.read("a.txt"), "precious edit\n");
    assert_eq!(f.read("new.txt"), "new file\n");
    history.redo(&f.repo).unwrap();
    assert_eq!(f.read("a.txt"), "1\n");
    assert!(!f.path("new.txt").exists());
}

#[test]
fn undoing_stash_drops_and_pushes() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n")]);
    let mut history = History::default();

    f.write("a.txt", "stashed\n");
    ops::stash_push(&f.repo, Some("keep me"), false).unwrap();
    let (oid, _) = undo::stash_info(&f.repo, "stash@{0}").unwrap();
    history.record(Entry {
        label: "Stash".into(),
        change: Change::StashPush { oid },
    });
    history.undo(&f.repo).unwrap();
    assert_eq!(f.read("a.txt"), "stashed\n");

    ops::stash_push(&f.repo, Some("keep me"), false).unwrap();
    let (oid, message) = undo::stash_info(&f.repo, "stash@{0}").unwrap();
    assert!(message.contains("keep me"));
    ops::stash_drop(&f.repo, "stash@{0}").unwrap();
    history.record(Entry {
        label: "Delete stash".into(),
        change: Change::StashDrop {
            oid: oid.clone(),
            message,
        },
    });
    history.undo(&f.repo).unwrap();
    assert_eq!(f.git(&["rev-parse", "stash@{0}"]).trim(), oid);
}

#[test]
fn outside_changes_invalidate_the_history() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n")]);
    let mut history = History::default();
    f.write("a.txt", "2\n");
    ops::stage_all(&f.repo).unwrap();
    recorded(&f, &mut history, "Commit", TipMove::Soft, || {
        ops::commit(
            &f.repo,
            &CommitOptions {
                message: "mine",
                amend: false,
                allow_empty: false,
                sign_off: false,
                no_verify: false,
            },
        )
        .unwrap();
    });
    // Someone commits in a terminal.
    f.commit("theirs", &[("b.txt", "b\n")]);
    let tip = head(&f);
    assert!(matches!(history.undo(&f.repo), Err(Error::Invalid(_))));
    assert_eq!(head(&f), tip, "nothing was rewound");
    assert_eq!(history.available().undo, None);
}

#[test]
fn a_no_op_is_not_recorded() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n")]);
    let mut history = History::default();
    recorded(&f, &mut history, "Nothing", TipMove::Keep, || {});
    assert_eq!(history.available().undo, None);
}

#[test]
fn a_conflicted_rebase_undoes_as_a_whole_once_finished() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "base\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.commit("theirs", &[("a.txt", "theirs\n")]);
    f.git(&["switch", "-q", "main"]);
    let ours = f.commit("ours", &[("a.txt", "ours\n")]);
    let mut history = History::default();

    // As the app does: remember where it started when it stops on conflicts.
    let before = undo::capture(&f.repo).unwrap();
    assert!(matches!(
        ops::rebase(&f.repo, "other"),
        Err(Error::Conflicts(_))
    ));
    history.suspend("Rebase onto other".into(), before, TipMove::Keep);
    f.write("a.txt", "resolved\n");
    ops::stage_all(&f.repo).unwrap();
    ops::sequence(&f.repo, ops::Sequence::Continue).unwrap();
    history.resume(undo::capture(&f.repo).unwrap());

    assert_eq!(
        history.available().undo.as_deref(),
        Some("Rebase onto other")
    );
    history.undo(&f.repo).unwrap();
    assert_eq!(head(&f), ours);
    assert_eq!(f.repo.head().unwrap().branch.as_deref(), Some("main"));
    assert_eq!(f.read("a.txt"), "ours\n");
}
