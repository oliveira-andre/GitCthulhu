mod common;

use common::Fixture;
use gitcthulhu_core::Error;
use gitcthulhu_core::ops::{self, Sequence};
use gitcthulhu_core::rebase::{self, RebaseAction, RebaseStep};
use gitcthulhu_core::repo::RepoState;

fn subjects(f: &Fixture) -> Vec<String> {
    f.git(&["log", "--format=%s", "--reverse"])
        .lines()
        .map(str::to_owned)
        .collect()
}

fn step(oid: &str, action: RebaseAction) -> RebaseStep {
    RebaseStep {
        oid: oid.to_owned(),
        action,
        message: None,
    }
}

/// base, then one, two, three, four, each adding its own file.
fn history(f: &Fixture) -> (String, Vec<String>) {
    let base = f.commit("base", &[("base.txt", "base\n")]);
    let commits = ["one", "two", "three", "four"]
        .iter()
        .map(|n| f.commit(n, &[(&format!("{n}.txt"), &format!("{n}\n"))]))
        .collect();
    (base, commits)
}

#[test]
fn plan_lists_commits_oldest_first_and_refuses_merges() {
    let f = Fixture::new();
    let (base, commits) = history(&f);
    let plan = rebase::plan(&f.repo, Some(&base)).unwrap();
    assert_eq!(
        plan.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(),
        commits
    );
    assert_eq!(plan[0].summary, "one");
    assert_eq!(plan.len(), 4);
    assert_eq!(rebase::plan(&f.repo, None).unwrap().len(), 5);

    f.git(&["switch", "-q", "-c", "side", &base]);
    f.commit("side", &[("side.txt", "s\n")]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["merge", "-q", "--no-edit", "side"]);
    assert!(matches!(
        rebase::plan(&f.repo, Some(&base)),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn reorders_rewords_squashes_and_drops_in_one_go() {
    let f = Fixture::new();
    let (base, c) = history(&f);
    let steps = vec![
        step(&c[1], RebaseAction::Pick),
        RebaseStep {
            oid: c[0].clone(),
            action: RebaseAction::Reword,
            message: Some("ONE, reworded\n\nwith a body".into()),
        },
        step(&c[2], RebaseAction::Squash),
        step(&c[3], RebaseAction::Drop),
    ];
    rebase::run(&f.repo, Some(&base), &steps).unwrap();
    assert_eq!(f.repo.state(), RepoState::Clean);
    assert_eq!(subjects(&f), ["base", "two", "ONE, reworded"]);
    // The squash kept both messages; the reword's body survived.
    let last = f.git(&["log", "-1", "--format=%B"]);
    assert!(
        last.contains("with a body") && last.contains("three"),
        "{last}"
    );
    assert!(f.path("three.txt").exists());
    assert!(!f.path("four.txt").exists());
    assert!(!f.repo.git_dir().join("gitcthulhu-rebase").exists());
}

#[test]
fn fixup_discards_its_message() {
    let f = Fixture::new();
    let (base, c) = history(&f);
    let steps = vec![
        step(&c[0], RebaseAction::Pick),
        step(&c[1], RebaseAction::Fixup),
        step(&c[2], RebaseAction::Pick),
        step(&c[3], RebaseAction::Pick),
    ];
    rebase::run(&f.repo, Some(&base), &steps).unwrap();
    assert_eq!(subjects(&f), ["base", "one", "three", "four"]);
    assert!(f.path("two.txt").exists());
}

#[test]
fn rewords_head_and_older_commits_and_the_root() {
    let f = Fixture::new();
    let (base, c) = history(&f);
    f.write("staged.txt", "keep me staged\n");
    f.git(&["add", "staged.txt"]);

    rebase::reword(&f.repo, &c[3], "four, renamed").unwrap();
    assert_eq!(subjects(&f).last().unwrap(), "four, renamed");
    // Amending the message didn't sweep in the staged file.
    assert!(
        f.git(&["diff", "--cached", "--name-only"])
            .contains("staged.txt")
    );

    rebase::reword(&f.repo, &c[1], "two, renamed").unwrap();
    rebase::reword(&f.repo, &base, "base, renamed").unwrap();
    assert_eq!(
        subjects(&f),
        [
            "base, renamed",
            "one",
            "two, renamed",
            "three",
            "four, renamed"
        ]
    );
    // Autostash put the staged change back.
    assert!(f.git(&["status", "--porcelain"]).contains("staged.txt"));
}

#[test]
fn drops_and_moves_single_commits() {
    let f = Fixture::new();
    let (_, c) = history(&f);
    rebase::drop_commit(&f.repo, &c[1]).unwrap();
    assert_eq!(subjects(&f), ["base", "one", "three", "four"]);

    let three = f
        .git(&["log", "-1", "--format=%H", "--grep=^three$"])
        .trim()
        .to_owned();
    rebase::move_commit(&f.repo, &three, true).unwrap();
    assert_eq!(subjects(&f), ["base", "one", "four", "three"]);
    let three = f
        .git(&["log", "-1", "--format=%H", "--grep=^three$"])
        .trim()
        .to_owned();
    rebase::move_commit(&f.repo, &three, false).unwrap();
    assert_eq!(subjects(&f), ["base", "one", "three", "four"]);
    let four = f.git(&["rev-parse", "HEAD"]).trim().to_owned();
    assert!(
        rebase::move_commit(&f.repo, &four, true).is_err(),
        "the newest can't move up"
    );
}

#[test]
fn a_conflict_stops_and_abort_restores_everything() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "1\n")]);
    let first = f.commit("first", &[("a.txt", "2\n")]);
    let second = f.commit("second", &[("a.txt", "3\n")]);
    let head = f.git(&["rev-parse", "HEAD"]).trim().to_owned();

    // Swapping two edits of the same line conflicts.
    let result = rebase::run(
        &f.repo,
        Some(&base),
        &[
            step(&second, RebaseAction::Pick),
            step(&first, RebaseAction::Pick),
        ],
    );
    assert!(matches!(result, Err(Error::Conflicts(_))), "{result:?}");
    assert!(matches!(f.repo.state(), RepoState::Rebasing { .. }));
    assert!(
        f.repo.git_dir().join("gitcthulhu-rebase").exists(),
        "kept for --continue"
    );

    ops::sequence(&f.repo, Sequence::Abort).unwrap();
    assert_eq!(f.repo.state(), RepoState::Clean);
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), head);
    assert!(!f.repo.git_dir().join("gitcthulhu-rebase").exists());
}

#[test]
fn a_reword_still_applies_after_resolving_a_conflict() {
    let f = Fixture::new();
    let base = f.commit("base", &[("a.txt", "1\n")]);
    let first = f.commit("first", &[("a.txt", "2\n")]);
    let second = f.commit("second", &[("a.txt", "3\n")]);
    let steps = [
        RebaseStep {
            oid: second.clone(),
            action: RebaseAction::Reword,
            message: Some("second, reworded".into()),
        },
        step(&first, RebaseAction::Pick),
    ];
    assert!(matches!(
        rebase::run(&f.repo, Some(&base), &steps),
        Err(Error::Conflicts(_))
    ));
    f.write("a.txt", "3\n");
    f.git(&["add", "a.txt"]);
    let next = ops::sequence(&f.repo, Sequence::Continue);
    // Picking `first` onto it conflicts next; take its side and finish.
    if matches!(next, Err(Error::Conflicts(_))) {
        f.write("a.txt", "2\n");
        f.git(&["add", "a.txt"]);
        ops::sequence(&f.repo, Sequence::Continue).unwrap();
    }
    assert_eq!(f.repo.state(), RepoState::Clean);
    assert_eq!(subjects(&f), ["base", "second, reworded", "first"]);
}

#[test]
fn a_stale_or_incomplete_plan_is_refused() {
    let f = Fixture::new();
    let (base, c) = history(&f);
    let missing = [step(&c[0], RebaseAction::Pick)];
    assert!(matches!(
        rebase::run(&f.repo, Some(&base), &missing),
        Err(Error::Invalid(_))
    ));
    let squash_first = [
        step(&c[0], RebaseAction::Squash),
        step(&c[1], RebaseAction::Pick),
        step(&c[2], RebaseAction::Pick),
        step(&c[3], RebaseAction::Pick),
    ];
    assert!(matches!(
        rebase::run(&f.repo, Some(&base), &squash_first),
        Err(Error::Invalid(_))
    ));
    let no_message = [
        RebaseStep {
            oid: c[0].clone(),
            action: RebaseAction::Reword,
            message: None,
        },
        step(&c[1], RebaseAction::Pick),
        step(&c[2], RebaseAction::Pick),
        step(&c[3], RebaseAction::Pick),
    ];
    assert!(rebase::run(&f.repo, Some(&base), &no_message).is_err());
    assert_eq!(f.repo.state(), RepoState::Clean);
}

#[test]
fn dropping_everything_after_the_base_resets_to_it() {
    let f = Fixture::new();
    let (base, c) = history(&f);
    let steps: Vec<_> = c.iter().map(|oid| step(oid, RebaseAction::Drop)).collect();
    rebase::run(&f.repo, Some(&base), &steps).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), base);
}
