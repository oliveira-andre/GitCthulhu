// Syntax highlighting with Prism's tokenizer. It yields tokens, not HTML, so
// code still goes into the page as text.
import "./prism-manual";
import Prism from "prismjs";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-scala";
import "prismjs/components/prism-dart";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-zig";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-elixir";
import "prismjs/components/prism-haskell";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-markdown";

export interface Segment {
  text: string;
  /** Prism token classes, for example `token keyword`; empty for plain text. */
  cls: string;
}

const BY_EXTENSION: Record<string, string> = {
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "c", mm: "cpp",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", dart: "dart", swift: "swift",
  go: "go", rs: "rust", zig: "zig", py: "python", pyi: "python", rb: "ruby", php: "php", lua: "lua",
  ex: "elixir", exs: "elixir", hs: "haskell",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  css: "css", scss: "scss", less: "css", html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", plist: "markup",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  md: "markdown", markdown: "markdown",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".gitconfig": "ini",
  "cargo.lock": "toml",
};

export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const lang = BY_NAME[name] ?? BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1)] ?? (name.startsWith("dockerfile") ? "docker" : null);
  return lang && Prism.languages[lang] ? lang : null;
}

/** Lines longer than this are left plain: tokenizing them is slow and rarely useful. */
const MAX_LINE = 2000;

export function tokenize(text: string, lang: string | null): Segment[] {
  const grammar = lang ? Prism.languages[lang] : undefined;
  if (!grammar || !text || text.length > MAX_LINE) return [{ text, cls: "" }];
  const out: Segment[] = [];
  const walk = (stream: string | Prism.Token | (string | Prism.Token)[], cls: string) => {
    if (typeof stream === "string") {
      if (stream) out.push({ text: stream, cls });
    } else if (Array.isArray(stream)) {
      for (const part of stream) walk(part, cls);
    } else {
      const alias = Array.isArray(stream.alias) ? stream.alias.join(" ") : (stream.alias ?? "");
      walk(stream.content as string | Prism.Token | (string | Prism.Token)[], `token ${stream.type} ${alias}`.trim());
    }
  };
  walk(Prism.tokenize(text, grammar), "");
  return out;
}
