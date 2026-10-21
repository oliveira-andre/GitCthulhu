//! The three-way merge tool's data: a conflicted file split into unchanged
//! sections and conflicts, each with our, the base's and their lines.
//!
//! The three versions come from the index (stages 1–3). `git merge-file
//! --diff3` merges them as git would, and its markers mark the conflicts.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::lossy;
use crate::repo::Repo;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Segment {
    Stable {
        lines: Vec<String>,
    },
    Conflict {
        ours: Vec<String>,
        base: Vec<String>,
        theirs: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub segments: Vec<Segment>,
    /// The merged file ends with a newline.
    pub trailing_newline: bool,
    /// Neither side can be merged line by line.
    pub binary: bool,
    /// One side deleted the file: only keeping or deleting it makes sense.
    pub deleted_in_ours: bool,
    pub deleted_in_theirs: bool,
}

const MARKER: usize = 7;

pub fn load(repo: &Repo, path: &str) -> Result<ConflictFile> {
    let stage = |n: u8| -> Result<Option<Vec<u8>>> {
        let out = repo.output(&["show", &format!(":{n}:{path}")])?;
        Ok(out.success().then_some(out.stdout))
    };
    let (base, ours, theirs) = (stage(1)?, stage(2)?, stage(3)?);
    if ours.is_none() && theirs.is_none() {
        return Err(Error::Invalid(format!("{path} isn't conflicted")));
    }
    let mut file = ConflictFile {
        path: path.to_owned(),
        segments: Vec::new(),
        trailing_newline: true,
        binary: false,
        deleted_in_ours: ours.is_none(),
        deleted_in_theirs: theirs.is_none(),
    };
    let (Some(ours), Some(theirs)) = (ours, theirs) else {
        return Ok(file);
    };
    let base = base.unwrap_or_default();
    if [&ours, &theirs, &base].iter().any(|b| b.contains(&0)) {
        file.binary = true;
        return Ok(file);
    }

    let dir = repo.git_dir().join("gitcthulhu-merge");
    std::fs::create_dir_all(&dir)?;
    let write = |name: &str, bytes: &[u8]| -> Result<String> {
        let p = dir.join(name);
        std::fs::write(&p, bytes)?;
        Ok(p.to_string_lossy().into_owned())
    };
    let (o, b, t) = (
        write("ours", &ours)?,
        write("base", &base)?,
        write("theirs", &theirs)?,
    );
    let out = repo.output(&[
        "merge-file",
        "-p",
        "--diff3",
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
        &o,
        &b,
        &t,
    ]);
    let _ = std::fs::remove_dir_all(&dir);
    let out = out?;
    // The exit code is the number of conflicts; negative means it failed.
    if out.code.is_none_or(|c| !(0..128).contains(&c)) {
        return Err(Error::Git {
            command: "merge-file".into(),
            code: out.code,
            stderr: out.stderr,
        });
    }
    let merged = lossy(&out.stdout);
    file.trailing_newline = merged.ends_with('\n') || merged.is_empty();
    file.segments = parse(&merged);
    Ok(file)
}

/// Splits `git merge-file --diff3` output at its markers.
fn parse(merged: &str) -> Vec<Segment> {
    #[derive(PartialEq)]
    enum In {
        Stable,
        Ours,
        Base,
        Theirs,
    }
    let marker = |line: &str, c: char| {
        line.len() >= MARKER
            && line.chars().take(MARKER).all(|x| x == c)
            && line[MARKER..].chars().next().is_none_or(|x| x == ' ')
    };

    let mut segments = Vec::new();
    let mut stable: Vec<String> = Vec::new();
    let (mut ours, mut base, mut theirs) = (Vec::new(), Vec::new(), Vec::new());
    let mut state = In::Stable;
    let body = merged.strip_suffix('\n').unwrap_or(merged);
    for line in body.split('\n') {
        match state {
            In::Stable if marker(line, '<') => {
                if !stable.is_empty() {
                    segments.push(Segment::Stable {
                        lines: std::mem::take(&mut stable),
                    });
                }
                state = In::Ours;
            }
            In::Ours if marker(line, '|') => state = In::Base,
            In::Ours | In::Base if marker(line, '=') => state = In::Theirs,
            In::Theirs if marker(line, '>') => {
                segments.push(Segment::Conflict {
                    ours: std::mem::take(&mut ours),
                    base: std::mem::take(&mut base),
                    theirs: std::mem::take(&mut theirs),
                });
                state = In::Stable;
            }
            In::Stable => stable.push(line.to_owned()),
            In::Ours => ours.push(line.to_owned()),
            In::Base => base.push(line.to_owned()),
            In::Theirs => theirs.push(line.to_owned()),
        }
    }
    if !stable.is_empty() && !(stable.len() == 1 && stable[0].is_empty() && merged.is_empty()) {
        segments.push(Segment::Stable { lines: stable });
    }
    segments
}

/// Writes the resolved text and stages it, which marks the file resolved.
pub fn resolve(repo: &Repo, path: &str, contents: &str) -> Result<()> {
    let relative = std::path::Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid(format!("{path} is outside the repository")));
    }
    std::fs::write(repo.root().join(relative), contents)?;
    repo.run(&["add", "--", path]).map(drop)
}

/// Resolves a delete/modify conflict by deleting the file.
pub fn resolve_deleted(repo: &Repo, path: &str) -> Result<()> {
    repo.run(&["rm", "-q", "--", path]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_diff3_markers() {
        let merged =
            "a\n<<<<<<< ours\nmine\n||||||| base\norig\n=======\nyours\nmore\n>>>>>>> theirs\nz\n";
        assert_eq!(
            parse(merged),
            [
                Segment::Stable {
                    lines: vec!["a".into()]
                },
                Segment::Conflict {
                    ours: vec!["mine".into()],
                    base: vec!["orig".into()],
                    theirs: vec!["yours".into(), "more".into()]
                },
                Segment::Stable {
                    lines: vec!["z".into()]
                },
            ]
        );
    }

    #[test]
    fn lines_that_merely_start_like_markers_are_content() {
        let merged = "<<<<<<<<< not a marker\n=======x\n";
        assert_eq!(
            parse(merged),
            [Segment::Stable {
                lines: vec!["<<<<<<<<< not a marker".into(), "=======x".into()]
            }]
        );
    }
}
