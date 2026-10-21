//! Parses unified diffs and builds the partial patches behind hunk and line
//! staging.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Added,
    Removed,
    /// `\ No newline at end of file`, about the line before it.
    NoNewline,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub kind: LineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The whole `@@ -a,b +c,d @@ context` line.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Everything from `diff --git` up to the first hunk.
    #[serde(skip)]
    pub header: String,
    pub binary: bool,
    pub new_file: bool,
    pub deleted_file: bool,
    pub hunks: Vec<Hunk>,
    /// The diff was too large to show.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub too_large: bool,
}

/// Which way a partial patch will be applied.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// `git apply`: stage lines from a working-tree diff.
    Forward,
    /// `git apply -R`: unstage lines from a staged diff, or discard them
    /// from the working tree.
    Reverse,
}

/// Diffs above this size are not parsed line by line.
pub const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

pub fn parse(patch: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut in_header = false;
    let (mut old_no, mut new_no) = (0u32, 0u32);

    for raw in patch.split_inclusive('\n') {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("diff --git ") {
            files.push(FileDiff {
                path: header_paths(rest).1,
                old_path: None,
                header: String::new(),
                binary: false,
                new_file: false,
                deleted_file: false,
                hunks: Vec::new(),
                too_large: false,
            });
            in_header = true;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };

        if line.starts_with("@@") {
            in_header = false;
            if let Some(hunk) = parse_hunk_header(line) {
                old_no = hunk.old_start;
                new_no = hunk.new_start;
                file.hunks.push(hunk);
            }
            continue;
        }
        if in_header {
            file.header.push_str(line);
            file.header.push('\n');
            if let Some(path) = line.strip_prefix("+++ ") {
                if path != "/dev/null" {
                    file.path = strip_prefix_path(path);
                }
            } else if let Some(path) = line.strip_prefix("--- ") {
                if path != "/dev/null" {
                    file.old_path = Some(strip_prefix_path(path));
                }
            } else if let Some(path) = line.strip_prefix("rename from ") {
                file.old_path = Some(path.to_owned());
            } else if let Some(path) = line.strip_prefix("rename to ") {
                file.path = path.to_owned();
            } else if line.starts_with("new file mode") {
                file.new_file = true;
            } else if line.starts_with("deleted file mode") {
                file.deleted_file = true;
            } else if line.starts_with("Binary files") || line == "GIT binary patch" {
                file.binary = true;
            }
            continue;
        }
        let Some(hunk) = file.hunks.last_mut() else {
            continue;
        };
        let (kind, text) = match line.as_bytes().first() {
            Some(b'+') => (LineKind::Added, &line[1..]),
            Some(b'-') => (LineKind::Removed, &line[1..]),
            Some(b' ') => (LineKind::Context, &line[1..]),
            Some(b'\\') => (LineKind::NoNewline, line),
            // A blank context line whose leading space was stripped.
            None => (LineKind::Context, ""),
            _ => continue,
        };
        let (old, new) = match kind {
            LineKind::Context => {
                old_no += 1;
                new_no += 1;
                (Some(old_no - 1), Some(new_no - 1))
            }
            LineKind::Added => {
                new_no += 1;
                (None, Some(new_no - 1))
            }
            LineKind::Removed => {
                old_no += 1;
                (Some(old_no - 1), None)
            }
            LineKind::NoNewline => (None, None),
        };
        hunk.lines.push(Line {
            kind,
            old,
            new,
            text: text.to_owned(),
        });
    }
    for file in &mut files {
        if file.old_path.as_deref() == Some(file.path.as_str()) {
            file.old_path = None;
        }
    }
    files
}

/// `a/x b/x` → (`x`, `x`). Only a fallback: `---`/`+++` and the rename lines
/// are exact, but a binary or mode-only diff has neither.
fn header_paths(rest: &str) -> (String, String) {
    let half = rest.len() / 2;
    let (a, b) = rest.split_at(half);
    let b = b.trim_start();
    (strip_prefix_path(a.trim_end()), strip_prefix_path(b))
}

fn strip_prefix_path(path: &str) -> String {
    let path = path.trim_end_matches('\t');
    let path = path
        .strip_prefix('"')
        .and_then(|p| p.strip_suffix('"'))
        .unwrap_or(path);
    match path.split_once('/') {
        Some((prefix, rest)) if prefix.len() == 1 => rest.to_owned(),
        _ => path.to_owned(),
    }
}

fn parse_hunk_header(line: &str) -> Option<Hunk> {
    // @@ -a[,b] +c[,d] @@ …
    let inner = line.strip_prefix("@@ ")?;
    let end = inner.find(" @@")?;
    let mut ranges = inner[..end].split(' ');
    let range = |s: &str, sign: char| -> Option<(u32, u32)> {
        let s = s.strip_prefix(sign)?;
        Some(match s.split_once(',') {
            Some((start, len)) => (start.parse().ok()?, len.parse().ok()?),
            None => (s.parse().ok()?, 1),
        })
    };
    let (old_start, old_lines) = range(ranges.next()?, '-')?;
    let (new_start, new_lines) = range(ranges.next()?, '+')?;
    Some(Hunk {
        header: line.to_owned(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: Vec::new(),
    })
}

/// Builds a patch holding only `selected` lines (indexes into the hunk's
/// lines; `None` means all of them) of one hunk, ready for `git apply`.
///
/// Unselected changes must leave the target untouched. Applied forwards, an
/// unselected removal stays as context and an unselected addition is
/// dropped; applied in reverse it's the other way round.
pub fn partial_patch(
    file: &FileDiff,
    hunk: usize,
    selected: Option<&[usize]>,
    direction: Direction,
) -> Result<String> {
    partial_patch_multi(
        file,
        &[HunkSelection {
            hunk,
            lines: selected,
        }],
        direction,
    )
}

/// Lines chosen from one hunk; `None` means all of them.
#[derive(Debug, Clone, Copy)]
pub struct HunkSelection<'a> {
    pub hunk: usize,
    pub lines: Option<&'a [usize]>,
}

/// Like [`partial_patch`], for chosen lines in several hunks at once. Later
/// hunks start where the earlier ones, as partially applied, leave them.
pub fn partial_patch_multi(
    file: &FileDiff,
    selections: &[HunkSelection],
    direction: Direction,
) -> Result<String> {
    let mut selections = selections.to_vec();
    selections.sort_by_key(|s| s.hunk);
    selections.dedup_by_key(|s| s.hunk);
    if selections.is_empty() {
        return Err(Error::Invalid(
            "select at least one added or removed line".into(),
        ));
    }
    let mut patch = file.header.clone();
    // How far the side being produced has shifted from the earlier hunks.
    let mut offset: i64 = 0;
    for selection in &selections {
        let hunk = file
            .hunks
            .get(selection.hunk)
            .ok_or_else(|| Error::Invalid("that change is no longer in the file".into()))?;
        let (body, old_lines, new_lines) = build_hunk(hunk, selection.lines, direction)?;
        // The side the patch is applied to is unchanged, so its range is the
        // original one; the other side starts at the same place, shifted.
        let (old_start, new_start) = match direction {
            Direction::Forward => (
                hunk.old_start,
                shift(other_start(hunk.old_start, old_lines, new_lines), offset),
            ),
            Direction::Reverse => (
                shift(other_start(hunk.new_start, new_lines, old_lines), offset),
                hunk.new_start,
            ),
        };
        offset += match direction {
            Direction::Forward => i64::from(new_lines) - i64::from(old_lines),
            Direction::Reverse => i64::from(old_lines) - i64::from(new_lines),
        };
        patch.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        patch.push_str(&body);
    }
    Ok(patch)
}

fn shift(start: u32, offset: i64) -> u32 {
    (i64::from(start) + offset).max(0) as u32
}

/// One hunk's lines for a partial patch, with its old and new line counts.
fn build_hunk(
    hunk: &Hunk,
    selected: Option<&[usize]>,
    direction: Direction,
) -> Result<(String, u32, u32)> {
    let chosen = |i: usize| selected.is_none_or(|s| s.contains(&i));
    let (keep_as_context, drop) = match direction {
        Direction::Forward => (LineKind::Removed, LineKind::Added),
        Direction::Reverse => (LineKind::Added, LineKind::Removed),
    };
    let mut body = String::new();
    let (mut old_lines, mut new_lines) = (0u32, 0u32);
    let mut changed = false;
    let mut last_kept = true;
    for (i, line) in hunk.lines.iter().enumerate() {
        let kind = match line.kind {
            LineKind::NoNewline => {
                if last_kept {
                    body.push_str(&line.text);
                    body.push('\n');
                }
                continue;
            }
            kind if kind == LineKind::Context || chosen(i) => kind,
            kind if kind == keep_as_context => LineKind::Context,
            kind if kind == drop => {
                last_kept = false;
                continue;
            }
            kind => kind,
        };
        last_kept = true;
        let prefix = match kind {
            LineKind::Context => {
                old_lines += 1;
                new_lines += 1;
                ' '
            }
            LineKind::Added => {
                new_lines += 1;
                changed = true;
                '+'
            }
            LineKind::Removed => {
                old_lines += 1;
                changed = true;
                '-'
            }
            LineKind::NoNewline => unreachable!(),
        };
        body.push(prefix);
        body.push_str(&line.text);
        body.push('\n');
    }
    if !changed {
        return Err(Error::Invalid(
            "select at least one added or removed line".into(),
        ));
    }
    Ok((body, old_lines, new_lines))
}

/// A range with no lines names the line before it, so `-5,0` and `+6,2`
/// start at the same place.
fn other_start(start: u32, count: u32, other_count: u32) -> u32 {
    let first = if count == 0 { start + 1 } else { start };
    if other_count == 0 { first - 1 } else { first }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@ fn main
 one
-two
+TWO
+extra
 three
-four
\\ No newline at end of file
";

    #[test]
    fn parses_hunks_and_line_numbers() {
        let files = parse(PATCH);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "f.txt");
        assert_eq!(f.old_path, None);
        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 4, 1, 4)
        );
        let kinds: Vec<_> = h.lines.iter().map(|l| (l.kind, l.old, l.new)).collect();
        assert_eq!(
            kinds,
            [
                (LineKind::Context, Some(1), Some(1)),
                (LineKind::Removed, Some(2), None),
                (LineKind::Added, None, Some(2)),
                (LineKind::Added, None, Some(3)),
                (LineKind::Context, Some(3), Some(4)),
                (LineKind::Removed, Some(4), None),
                (LineKind::NoNewline, None, None),
            ]
        );
    }

    #[test]
    fn parses_renames_and_new_files() {
        let patch = "diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/n.txt
@@ -0,0 +1 @@
+hi
";
        let files = parse(patch);
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
        assert!(files[1].new_file);
        assert_eq!(files[1].hunks[0].lines[0].new, Some(1));
    }

    #[test]
    fn forward_partial_patch_keeps_unselected_removals_as_context() {
        let file = &parse(PATCH)[0];
        // Only the "+TWO" line.
        let patch = partial_patch(file, 0, Some(&[2]), Direction::Forward).unwrap();
        assert!(
            patch.ends_with(
                "@@ -1,4 +1,5 @@\n one\n two\n+TWO\n three\n four\n\\ No newline at end of file\n"
            ),
            "{patch}"
        );
    }

    #[test]
    fn reverse_partial_patch_keeps_unselected_additions_as_context() {
        let file = &parse(PATCH)[0];
        // Only the "-four" line, as if unstaging it.
        let patch = partial_patch(file, 0, Some(&[5]), Direction::Reverse).unwrap();
        assert!(
            patch.ends_with(
                "@@ -1,5 +1,4 @@\n one\n TWO\n extra\n three\n-four\n\\ No newline at end of file\n"
            ),
            "{patch}"
        );
    }

    #[test]
    fn selecting_only_context_is_refused() {
        let file = &parse(PATCH)[0];
        assert!(partial_patch(file, 0, Some(&[0]), Direction::Forward).is_err());
    }
}
