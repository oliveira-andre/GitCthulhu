mod common;

use common::Fixture;
use gitcthulhu_core::inspect;
use gitcthulhu_core::inspect::BlobSource;
use gitcthulhu_core::symbols::{self, SymbolSearch};

#[test]
fn finds_definitions_and_references_in_each_source() {
    let f = Fixture::new();
    let oid = f.commit(
        "start",
        &[
            (
                "src/menu.ts",
                "export function showMenu(items) {\n  return items;\n}\n",
            ),
            (
                "src/main.ts",
                "import { showMenu } from \"./menu\";\nshowMenu([]);\n",
            ),
            ("notes.md", "showMenuItems isn't the same word\n"),
        ],
    );
    // Only in the working tree: an untracked file and an unstaged call.
    f.write("src/extra.ts", "showMenu([1]);\n");
    f.write(
        "src/main.ts",
        "import { showMenu } from \"./menu\";\nshowMenu([]);\nshowMenu([2]);\n",
    );

    let found = |source: &BlobSource, search| {
        symbols::find(&f.repo, source, "showMenu", search)
            .unwrap()
            .matches
            .into_iter()
            .map(|m| (m.path, m.line, m.definition))
            .collect::<Vec<_>>()
    };
    let worktree = BlobSource::Worktree;
    assert_eq!(
        found(&worktree, SymbolSearch::Definitions),
        [("src/menu.ts".to_owned(), 1, true)]
    );
    assert_eq!(
        found(&worktree, SymbolSearch::References),
        [
            ("src/extra.ts".to_owned(), 1, false),
            ("src/main.ts".to_owned(), 1, false),
            ("src/main.ts".to_owned(), 2, false),
            ("src/main.ts".to_owned(), 3, false),
            ("src/menu.ts".to_owned(), 1, true),
        ]
    );
    let committed = BlobSource::Revision { rev: oid };
    assert_eq!(found(&committed, SymbolSearch::References).len(), 3);
    assert_eq!(found(&BlobSource::Index, SymbolSearch::References).len(), 3);

    let none = symbols::find(&f.repo, &worktree, "nowhere", SymbolSearch::References).unwrap();
    assert!(none.matches.is_empty() && !none.truncated);
    assert!(symbols::find(&f.repo, &worktree, "-e", SymbolSearch::References).is_err());
    let option = BlobSource::Revision {
        rev: "--output=x".into(),
    };
    assert!(symbols::find(&f.repo, &option, "showMenu", SymbolSearch::References).is_err());
}

#[test]
fn reads_text_and_refuses_binary_files() {
    let f = Fixture::new();
    let oid = f.commit("start", &[("a.txt", "one\n"), ("b.bin", "a\0b")]);
    f.write("a.txt", "two\n");
    let text = |source: &BlobSource, path| inspect::text(&f.repo, source, path, 1 << 20);
    assert_eq!(
        text(&BlobSource::Worktree, "a.txt").unwrap().as_deref(),
        Some("two\n")
    );
    assert_eq!(
        text(&BlobSource::Index, "a.txt").unwrap().as_deref(),
        Some("one\n")
    );
    assert_eq!(
        text(&BlobSource::Revision { rev: oid }, "a.txt")
            .unwrap()
            .as_deref(),
        Some("one\n")
    );
    assert_eq!(text(&BlobSource::Worktree, "missing.txt").unwrap(), None);
    assert!(text(&BlobSource::Worktree, "b.bin").is_err());
    assert!(text(&BlobSource::Worktree, "../outside").is_err());
}
