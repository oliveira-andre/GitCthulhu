mod common;

use common::Fixture;
use gitcthulhu_core::history;
use gitcthulhu_core::status::ChangeKind;

#[test]
fn history_follows_renames_newest_first() {
    let f = Fixture::new();
    let first = f.commit("create", &[("old name.txt", "one\ntwo\nthree\n")]);
    f.commit("unrelated", &[("other.txt", "x\n")]);
    f.git(&["mv", "old name.txt", "new name.txt"]);
    f.git(&["commit", "-q", "-m", "rename"]);
    f.commit("edit", &[("new name.txt", "one\nTWO\nthree\n")]);

    let commits = history::file_history(&f.repo, "new name.txt", 100).unwrap();
    let summary: Vec<_> = commits
        .iter()
        .map(|c| (c.subject.as_str(), c.kind, c.path.as_str()))
        .collect();
    assert_eq!(
        summary,
        [
            ("edit", ChangeKind::Modified, "new name.txt"),
            ("rename", ChangeKind::Renamed, "new name.txt"),
            ("create", ChangeKind::Added, "old name.txt"),
        ]
    );
    assert_eq!(commits[1].old_path.as_deref(), Some("old name.txt"));
    assert_eq!(commits[2].oid, first);
    assert_eq!(commits[0].author, "Test User");
    assert_eq!(
        history::file_history(&f.repo, "new name.txt", 1)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn blame_attributes_each_line() {
    let f = Fixture::new();
    let first = f.commit("create", &[("f.txt", "one\ntwo\nthree\n")]);
    let second = f.commit("edit", &[("f.txt", "one\nTWO\nthree\n")]);

    let blame = history::blame(&f.repo, "f.txt", None).unwrap();
    let owners: Vec<_> = blame
        .lines
        .iter()
        .map(|l| (l.text.as_str(), l.oid.as_str()))
        .collect();
    assert_eq!(
        owners,
        [
            ("one", first.as_str()),
            ("TWO", second.as_str()),
            ("three", first.as_str())
        ]
    );
    assert_eq!(
        blame.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    let edit = blame.commits.iter().find(|c| c.oid == second).unwrap();
    assert_eq!(edit.summary, "edit");
    assert_eq!(edit.email, "test@example.com");

    // As of the first commit, everything is its.
    let old = history::blame(&f.repo, "f.txt", Some(&first)).unwrap();
    assert!(old.lines.iter().all(|l| l.oid == first));
    assert_eq!(old.lines[1].text, "two");
}

#[test]
fn lists_tracked_files() {
    let f = Fixture::new();
    f.commit("create", &[("a.txt", "a"), ("dir/b c.txt", "b")]);
    f.write("untracked.txt", "u");
    let files = history::tracked_files(&f.repo).unwrap();
    assert_eq!(files, ["a.txt", "dir/b c.txt"]);
}
