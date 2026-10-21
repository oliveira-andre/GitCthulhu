mod common;

use common::Fixture;
use gitcthulhu_core::conflict::{self, Segment};
use gitcthulhu_core::ops::{self, MergeMode};
use gitcthulhu_core::status;

/// main and other both change the middle line of a.txt.
fn conflicted(f: &Fixture) {
    f.commit("base", &[("a.txt", "top\nmiddle\nbottom\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.commit("theirs", &[("a.txt", "top\nTHEIRS\nbottom\n")]);
    f.git(&["switch", "-q", "main"]);
    f.commit("ours", &[("a.txt", "top\nOURS\nOURS 2\nbottom\n")]);
    assert!(ops::merge(&f.repo, "other", MergeMode::Default).is_err());
}

#[test]
fn splits_a_conflicted_file_into_stable_parts_and_conflicts() {
    let f = Fixture::new();
    conflicted(&f);
    let file = conflict::load(&f.repo, "a.txt").unwrap();
    assert!(!file.binary && !file.deleted_in_ours && !file.deleted_in_theirs);
    assert!(file.trailing_newline);
    assert_eq!(
        file.segments,
        [
            Segment::Stable {
                lines: vec!["top".into()]
            },
            Segment::Conflict {
                ours: vec!["OURS".into(), "OURS 2".into()],
                base: vec!["middle".into()],
                theirs: vec!["THEIRS".into()],
            },
            Segment::Stable {
                lines: vec!["bottom".into()]
            },
        ]
    );
    assert!(
        !f.repo.git_dir().join("gitcthulhu-merge").exists(),
        "temporary files are removed"
    );
}

#[test]
fn resolving_writes_and_stages_the_file() {
    let f = Fixture::new();
    conflicted(&f);
    conflict::resolve(&f.repo, "a.txt", "top\nOURS\nTHEIRS\nbottom\n").unwrap();
    assert_eq!(f.read("a.txt"), "top\nOURS\nTHEIRS\nbottom\n");
    let s = status::status(&f.repo).unwrap();
    assert!(s.conflicted.is_empty());
    assert_eq!(f.staged("a.txt"), "top\nOURS\nTHEIRS\nbottom\n");
}

#[test]
fn delete_modify_conflicts_are_flagged_and_can_be_resolved_by_deleting() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n"), ("keep.txt", "k\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.git(&["rm", "-q", "a.txt"]);
    f.git(&["commit", "-q", "-m", "delete"]);
    f.git(&["switch", "-q", "main"]);
    f.commit("edit", &[("a.txt", "2\n")]);
    assert!(ops::merge(&f.repo, "other", MergeMode::Default).is_err());

    let file = conflict::load(&f.repo, "a.txt").unwrap();
    assert!(file.deleted_in_theirs && !file.deleted_in_ours);
    conflict::resolve_deleted(&f.repo, "a.txt").unwrap();
    assert!(status::status(&f.repo).unwrap().conflicted.is_empty());
    assert!(!f.path("a.txt").exists());
}

#[test]
fn files_that_are_not_conflicted_are_refused() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n")]);
    assert!(conflict::load(&f.repo, "a.txt").is_err());
    assert!(conflict::resolve(&f.repo, "../outside.txt", "x").is_err());
}

#[test]
fn taking_the_side_that_deleted_the_file_deletes_it() {
    let f = Fixture::new();
    f.commit("base", &[("a.txt", "1\n"), ("b.txt", "1\n")]);
    f.git(&["switch", "-q", "-c", "other"]);
    f.git(&["rm", "-q", "a.txt", "b.txt"]);
    f.git(&["commit", "-q", "-m", "delete both"]);
    f.git(&["switch", "-q", "main"]);
    f.commit("edit both", &[("a.txt", "2\n"), ("b.txt", "2\n")]);
    assert!(ops::merge(&f.repo, "other", MergeMode::Default).is_err());

    ops::resolve_with(&f.repo, &["a.txt".into()], ops::ConflictSide::Theirs).unwrap();
    ops::resolve_with(&f.repo, &["b.txt".into()], ops::ConflictSide::Ours).unwrap();
    assert!(!f.path("a.txt").exists());
    assert_eq!(f.read("b.txt"), "2\n");
    assert!(status::status(&f.repo).unwrap().conflicted.is_empty());
}
