//! Go to definition and references without a language server: `git grep`
//! finds the symbol as a whole word, and a handful of patterns that cover
//! the usual declaration shapes (keywords such as `fn`, `class` or `def`,
//! methods, functions assigned to names) pick out the definitions.

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::inspect::{BlobSource, check_revision};
use crate::repo::Repo;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SymbolSearch {
    Definitions,
    References,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub text: String,
    /// The line looks like it declares the symbol.
    pub definition: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolResults {
    pub matches: Vec<SymbolMatch>,
    /// More matched than the limit, or than were scanned for definitions.
    pub truncated: bool,
}

/// References beyond this many are left out.
pub const MAX_REFERENCES: usize = 1000;
/// Definitions are looked for among this many matching lines at most.
const MAX_SCANNED: usize = 50_000;
/// Longer lines (minified code) are cut.
const MAX_TEXT: usize = 400;

/// Identifiers only: letters, digits, `_` and `$`, not starting with a digit.
pub fn is_symbol(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    text.len() <= 200
        && (first.is_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// Lines that mention `symbol` as a whole word in the working tree, the
/// index or a commit. With [`SymbolSearch::Definitions`], only the lines
/// that look like they define it.
pub fn find(
    repo: &Repo,
    source: &BlobSource,
    symbol: &str,
    search: SymbolSearch,
) -> Result<SymbolResults> {
    if !is_symbol(symbol) {
        return Err(Error::Invalid(format!("not a symbol: {symbol}")));
    }
    let mut args = vec![
        "grep".to_owned(),
        "-n".into(),
        "-z".into(),
        "-I".into(),
        "-w".into(),
        "-F".into(),
        "--full-name".into(),
        "--no-color".into(),
    ];
    let mut prefix = String::new();
    match source {
        BlobSource::Worktree => args.push("--untracked".into()),
        BlobSource::Index => args.push("--cached".into()),
        BlobSource::Revision { .. } => {}
    }
    args.extend(["-e".into(), symbol.to_owned()]);
    if let BlobSource::Revision { rev } = source {
        check_revision(rev)?;
        args.push(rev.clone());
        prefix = format!("{rev}:");
    }
    args.push("--".into());

    let definition = Definition::new(symbol);
    let mut matches = Vec::new();
    let mut scanned = 0;
    let mut truncated = false;
    let streamed = repo
        .git()
        .stream_split(repo.root(), &args, b'\n', &mut |record| {
            // path NUL line NUL text
            let mut fields = record.splitn(3, |b| *b == 0);
            let (Some(path), Some(line), Some(text)) =
                (fields.next(), fields.next(), fields.next())
            else {
                return true;
            };
            let path = String::from_utf8_lossy(path);
            let path = path.strip_prefix(&prefix).unwrap_or(&path).to_owned();
            let Some(line) = std::str::from_utf8(line).ok().and_then(|n| n.parse().ok()) else {
                return true;
            };
            let mut text = String::from_utf8_lossy(text).into_owned();
            if text.len() > MAX_TEXT {
                let mut cut = MAX_TEXT;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            let is_definition = definition.matches(&text);
            scanned += 1;
            if search == SymbolSearch::References || is_definition {
                matches.push(SymbolMatch {
                    path,
                    line,
                    text,
                    definition: is_definition,
                });
            }
            let full = match search {
                SymbolSearch::References => matches.len() >= MAX_REFERENCES,
                SymbolSearch::Definitions => scanned >= MAX_SCANNED,
            };
            truncated = full;
            !full
        });
    match streamed {
        Ok(()) => {}
        // grep exits with 1 when nothing matched.
        Err(Error::Git {
            code: Some(1),
            ref stderr,
            ..
        }) if stderr.trim().is_empty() => {}
        Err(e) => return Err(e),
    }
    Ok(SymbolResults { matches, truncated })
}

/// Whether a line declares a symbol, by its shape. It errs towards
/// recognizing declarations; references are every match anyway.
struct Definition {
    /// `fn x`, `class x`, `def x`, `const x`, `#define x`, Go's `func (r T) x`, `x :=`.
    keyword: Regex,
    /// `x(...)`, possibly after modifiers and a return type: methods and C-like functions.
    call_shape: Regex,
    /// `x = function`, `x = (a) =>`, `x: (a) =>`, and `x = ...` at the start of a line.
    assigned: Regex,
}

/// Words that start statements rather than declarations, so `return x(y)`
/// isn't taken for a function `x` returning something.
const STATEMENTS: &[&str] = &[
    "return", "if", "else", "while", "for", "switch", "case", "new", "await", "throw", "yield",
    "typeof", "delete", "do", "catch", "echo", "print", "raise", "assert", "not", "and", "or",
    "in", "of", "with", "goto", "defer", "go", "when", "match", "unless", "until", "elif",
    "except", "puts", "sizeof", "is", "as", "from", "import", "using",
];

impl Definition {
    fn new(symbol: &str) -> Definition {
        let s = regex::escape(symbol);
        let before = r"(?:^|[^\w$])";
        let after = r"(?:[^\w$]|$)";
        let keywords = "function\\*?|def|defp|defn|defmacro|class|struct|enum|trait|interface|type|typedef|fn|func|const|let|var|val|mod|module|namespace|union|object|protocol|record|sub|package|alias|static|data|newtype|macro|proc|procedure";
        let keyword = Regex::new(&format!(
            r"{before}(?:(?:{keywords})\s+(?:mut\s+|async\s+)?\*?{s}{after}|macro_rules!\s*{s}{after}|#\s*define\s+{s}{after}|func\s*\([^)]*\)\s*{s}{after})|^\s*(?:[\w$]+\s*,\s*)*{s}(?:\s*,\s*[\w$]+)*\s*:="
        ))
        .expect("valid pattern");
        let call_shape = Regex::new(&format!(
            r"^\s*(?P<prefix>(?:[\w$<>\[\],.*&?:]+\s+)*)(?:[\w$<>]+::)*[*&]?{s}\s*(?:<[^>]*>)?\s*\((?P<rest>.*)$"
        ))
        .expect("valid pattern");
        let assigned = Regex::new(&format!(
            r#"^\s*(?:(?:export|public|private|protected|static|readonly|declare|async|override)\s+)*(?:this\.|self\.)?['"]?{s}['"]?\s*(?:\??:\s*[^=]*?)?\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[\w$]+\s*=>|lambda\b)|^{s}\s*=[^=]"#
        ))
        .expect("valid pattern");
        Definition {
            keyword,
            call_shape,
            assigned,
        }
    }

    fn matches(&self, line: &str) -> bool {
        let trimmed = line.trim_start();
        let comment = trimmed.starts_with("//")
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
            || trimmed.starts_with("--")
            || (trimmed.starts_with('#') && !trimmed[1..].trim_start().starts_with("define"));
        let import = [
            "import ", "use ", "from ", "export {", "export *", "require",
        ]
        .iter()
        .any(|p| trimmed.starts_with(p));
        if comment || import {
            return false;
        }
        if self.keyword.is_match(line) || self.assigned.is_match(line) {
            return true;
        }
        let Some(found) = self.call_shape.captures(line) else {
            return false;
        };
        let prefix = &found["prefix"];
        let rest = found["rest"].trim_end();
        if let Some(first) = prefix.split_whitespace().next()
            && STATEMENTS.contains(&first)
        {
            return false;
        }
        if rest.ends_with(';') || rest.contains("=>") || rest.contains("function") {
            return false;
        }
        if prefix.trim().is_empty() {
            // A bare `x(...)` declares only when a body follows: `x(a) {`.
            rest.contains(')') && rest.ends_with('{')
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defines(symbol: &str, line: &str) -> bool {
        Definition::new(symbol).matches(line)
    }

    #[test]
    fn recognizes_declarations_across_languages() {
        for line in [
            "export function showMenu(items: MenuItem[]): void {",
            "  private showMenu(): void {",
            "  async showMenu(request: DiffRequest): Promise<void> {",
            "  static showMenu(value) {",
            "export class showMenu {",
            "const showMenu = (items) => {",
            "export const showMenu = async (items: X): Promise<void> => {",
            "  showMenu = function () {",
            "  showMenu: (items) => items,",
            "type showMenu = { a: number };",
            "interface showMenu {",
            "pub fn showMenu(items: &[Item]) -> Result<()> {",
            "    pub(crate) fn showMenu<T>(x: T) {",
            "pub struct showMenu {",
            "pub const showMenu: usize = 4;",
            "macro_rules! showMenu {",
            "def showMenu(items):",
            "class showMenu(Base):",
            "showMenu = lambda items: items",
            "showMenu = 4",
            "func showMenu(items []Item) error {",
            "func (r *Repo) showMenu(items []Item) error {",
            "\tshowMenu := makeMenu()",
            "#define showMenu(x) ((x) + 1)",
            "static void showMenu(int items)",
            "int Menu::showMenu(int items) {",
            "public static List<String> showMenu(int items) {",
        ] {
            assert!(defines("showMenu", line), "should define: {line}");
        }
    }

    #[test]
    fn calls_and_mentions_are_references() {
        for line in [
            "    showMenu(items, button);",
            "  return showMenu(items);",
            "  if (showMenu(items)) {",
            "  } else if showMenu(x) {",
            "  const menu = showMenu(items);",
            "import { showMenu } from \"../menu\";",
            "use crate::menu::showMenu;",
            "// function showMenu is below",
            "    # def showMenu(): old",
            "  window.setTimeout(() => showMenu(items), 0);",
            "  showMenu(() => {",
            "  await showMenu(items)",
            "  items.forEach(showMenu);",
            "  this.showMenu = other;",
            "  x == showMenu",
            "  new showMenu(items)",
        ] {
            assert!(!defines("showMenu", line), "should not define: {line}");
        }
    }

    #[test]
    fn symbols_are_identifiers() {
        assert!(is_symbol("showMenu"));
        assert!(is_symbol("$el"));
        assert!(is_symbol("_private2"));
        assert!(is_symbol("café"));
        assert!(!is_symbol(""));
        assert!(!is_symbol("2fast"));
        assert!(!is_symbol("a-b"));
        assert!(!is_symbol("-e"));
        assert!(!is_symbol("a b"));
    }
}
