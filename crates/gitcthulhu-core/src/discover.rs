//! Finds repositories under a folder, for adding many at once.

use std::path::{Path, PathBuf};

/// Folders that never hold repositories worth listing, and can be huge.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    ".cache",
    "Library",
    "Pods",
    "venv",
    ".venv",
    "__pycache__",
    ".Trash",
];

/// Repositories at most `depth` folders below `root` (which counts too). A
/// repository's own folders aren't searched further, and the search stops
/// after `limit` results.
pub fn find_repositories(root: &Path, depth: usize, limit: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, depth, limit, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, limit: usize, found: &mut Vec<PathBuf>) {
    if found.len() >= limit {
        return;
    }
    // `.git` is a folder in a repository and a file in a linked worktree.
    if dir.join(".git").exists() {
        found.push(dir.to_owned());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            !name.starts_with('.') && !SKIP.contains(&name)
        })
        .collect();
    children.sort();
    for child in children {
        walk(&child, depth - 1, limit, found);
        if found.len() >= limit {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repositories_without_descending_into_them_or_skipped_folders() {
        let dir = tempfile::tempdir().unwrap();
        let make = |path: &str| std::fs::create_dir_all(dir.path().join(path)).unwrap();
        make("work/app/.git");
        make("work/app/vendor/lib/.git"); // inside a repository: not listed
        make("work/tools/cli/.git");
        make("node_modules/pkg/.git"); // skipped folder
        make("deep/a/b/c/d/e/.git"); // too deep
        std::fs::write(dir.path().join("work/linked"), "").unwrap();
        make("work/wt");
        std::fs::write(dir.path().join("work/wt/.git"), "gitdir: elsewhere").unwrap();

        let found = find_repositories(dir.path(), 3, 100);
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                p.strip_prefix(dir.path())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(names, ["work/app", "work/tools/cli", "work/wt"]);
        assert_eq!(find_repositories(dir.path(), 3, 1).len(), 1);
    }
}
