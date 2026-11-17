/**
 * Tokenizer ringan ala VS Code untuk penampil berkas.
 *
 * Fungsi murni tanpa DOM. Satu mesin memindai seluruh isi (bukan per baris) agar
 * komentar blok, string template, dan triple-quote lintas baris tetap benar, lalu
 * token dipecah di batas newline.
 *
 * Invarian: gabungan `text` semua token pada satu baris sama persis dengan baris
 * aslinya (lossless). Baris kosong selalu direpresentasikan sebagai `[]`.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "control"
  | "type"
  | "function"
  | "variable"
  | "property"
  | "tag"
  | "attr"
  | "operator"
  | "heading"
  | "inserted"
  | "deleted";

export interface Token {
  text: string;
  kind: TokenKind;
}

export type LangId =
  | "ts"
  | "js"
  | "json"
  | "css"
  | "html"
  | "sh"
  | "py"
  | "php"
  | "yaml"
  | "md"
  | "go"
  | "rust"
  | "java"
  | "sql"
  | "toml"
  | "diff"
  | "plain";

export const MAX_HIGHLIGHT_LINES = 4000;

const EXT_LANG: Record<string, LangId> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  webmanifest: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  xhtml: "html",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  env: "sh",
  py: "py",
  php: "php",
  yml: "yaml",
  yaml: "yaml",
  md: "md",
  markdown: "md",
  mdx: "md",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "java",
  kts: "java",
  swift: "java",
  c: "java",
  h: "java",
  cpp: "java",
  hpp: "java",
  cs: "java",
  sql: "sql",
  toml: "toml",
  ini: "toml",
  cfg: "toml",
  diff: "diff",
  patch: "diff",
};

const SHELL_NAMES = new Set([".zshrc", ".bashrc", ".profile", "dockerfile"]);

/** Bahasa dari ekstensi atau nama berkas; tak dikenal menjadi "plain". */
export function languageForPath(path: string): LangId {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (SHELL_NAMES.has(name)) return "sh";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plain";
  return EXT_LANG[name.slice(dot + 1)] ?? "plain";
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isHex = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
const isIdentStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
const isIdent = (code: number): boolean => isIdentStart(code) || isDigit(code);

class Sink {
  readonly tokens: Token[] = [];

  push(kind: TokenKind, text: string): void {
    if (text === "") return;
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.kind === kind) last.text += text;
    else this.tokens.push({ text, kind });
  }
}

/** Pindai angka desimal/hex/biner/oktal dengan pemisah `_` dan eksponen. */
function scanNumber(content: string, start: number): number {
  const n = content.length;
  let i = start;
  if (i < n && (content[i] === "-" || content[i] === "+")) i += 1;
  const c0 = content.charCodeAt(i);
  const c1 = content.charCodeAt(i + 1);
  if (c0 === 48 && (c1 === 120 || c1 === 88 || c1 === 98 || c1 === 66 || c1 === 111 || c1 === 79)) {
    i += 2;
    while (i < n && (isHex(content.charCodeAt(i)) || content[i] === "_")) i += 1;
    return i;
  }
  while (i < n && (isDigit(content.charCodeAt(i)) || content[i] === "_")) i += 1;
  if (i < n && content[i] === "." && isDigit(content.charCodeAt(i + 1))) {
    i += 1;
    while (i < n && (isDigit(content.charCodeAt(i)) || content[i] === "_")) i += 1;
  }
  if (i < n && (content[i] === "e" || content[i] === "E")) {
    let k = i + 1;
    if (k < n && (content[k] === "+" || content[k] === "-")) k += 1;
    if (isDigit(content.charCodeAt(k))) {
      i = k;
      while (i < n && isDigit(content.charCodeAt(i))) i += 1;
    }
  }
  return i;
}

interface CodeOptions {
  lineComments: readonly string[];
  blockComment: boolean;
  hashComment: boolean;
  quotes: readonly string[];
  tripleQuotes: boolean;
  keywords: ReadonlySet<string>;
  controls: ReadonlySet<string>;
  caseInsensitive: boolean;
  dollarVar: boolean;
  phpTags: boolean;
  decorator: boolean;
}

function scanCode(content: string, options: CodeOptions): Token[] {
  const sink = new Sink();
  const n = content.length;
  let i = 0;
  let lastSignificant = "";

  const emit = (kind: TokenKind, text: string): void => {
    sink.push(kind, text);
    for (let k = text.length - 1; k >= 0; k -= 1) {
      const ch = text.charAt(k);
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
        lastSignificant = ch;
        break;
      }
    }
  };

  while (i < n) {
    const ch = content.charAt(i);

    if (options.phpTags && content.startsWith("<?php", i)) {
      emit("keyword", "<?php");
      i += 5;
      continue;
    }
    if (options.phpTags && content.startsWith("?>", i)) {
      emit("keyword", "?>");
      i += 2;
      continue;
    }

    let matched = false;
    for (const marker of options.lineComments) {
      if (content.startsWith(marker, i)) {
        let j = i + marker.length;
        while (j < n && content[j] !== "\n") j += 1;
        emit("comment", content.slice(i, j));
        i = j;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (options.hashComment && ch === "#") {
      let j = i + 1;
      while (j < n && content[j] !== "\n") j += 1;
      emit("comment", content.slice(i, j));
      i = j;
      continue;
    }

    if (options.blockComment && ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      emit("comment", content.slice(i, j));
      i = j;
      continue;
    }

    if (options.tripleQuotes && (content.startsWith('"""', i) || content.startsWith("'''", i))) {
      const quote = content.slice(i, i + 3);
      const end = content.indexOf(quote, i + 3);
      const j = end === -1 ? n : end + 3;
      emit("string", content.slice(i, j));
      i = j;
      continue;
    }

    if (options.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        if (content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      emit("string", content.slice(i, j));
      i = j;
      continue;
    }

    if (isDigit(ch.charCodeAt(0)) || (ch === "." && isDigit(content.charCodeAt(i + 1)))) {
      const j = scanNumber(content, i);
      emit("number", content.slice(i, j));
      i = j;
      continue;
    }

    if (options.dollarVar && ch === "$" && isIdentStart(content.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdent(content.charCodeAt(j))) j += 1;
      emit("variable", content.slice(i, j));
      i = j;
      continue;
    }

    if (options.decorator && ch === "@" && isIdentStart(content.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdent(content.charCodeAt(j))) j += 1;
      emit("function", content.slice(i, j));
      i = j;
      continue;
    }

    if (isIdentStart(ch.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && isIdent(content.charCodeAt(j))) j += 1;
      const word = content.slice(i, j);
      const key = options.caseInsensitive ? word.toLowerCase() : word;
      let kind: TokenKind;
      if (options.controls.has(key)) kind = "control";
      else if (options.keywords.has(key)) kind = "keyword";
      else if (content[j] === "(") kind = "function";
      else if (lastSignificant === ".") kind = "property";
      else if (word.charCodeAt(0) >= 65 && word.charCodeAt(0) <= 90) kind = "type";
      else kind = "variable";
      emit(kind, word);
      i = j;
      continue;
    }

    emit("plain", ch);
    i += 1;
  }

  return sink.tokens;
}

const TS_CONTROL = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
  "throw", "try", "catch", "finally", "import", "export", "from", "default", "await",
  "async", "yield", "new", "delete", "typeof", "instanceof", "in", "of",
]);

const TS_KEYWORD = new Set([
  "const", "let", "var", "function", "class", "extends", "implements", "interface", "type",
  "enum", "namespace", "declare", "abstract", "static", "readonly", "public", "private",
  "protected", "get", "set", "as", "is", "keyof", "void", "this", "super", "true", "false",
  "null", "undefined",
]);

const TS_OPTIONS: CodeOptions = {
  lineComments: ["//"],
  blockComment: true,
  hashComment: false,
  quotes: ["'", '"', "`"],
  tripleQuotes: false,
  keywords: TS_KEYWORD,
  controls: TS_CONTROL,
  caseInsensitive: false,
  dollarVar: false,
  phpTags: false,
  decorator: false,
};

const GO_KEYWORD = new Set([
  "func", "var", "const", "type", "struct", "interface", "map", "chan", "package", "import",
  "go", "defer", "range", "select",
]);

const GO_CONTROL = new Set([
  "if", "else", "for", "while", "return", "switch", "case", "break", "continue", "try",
  "catch", "throw", "defer",
]);

const GO_OPTIONS: CodeOptions = {
  lineComments: ["//"],
  blockComment: true,
  hashComment: false,
  quotes: ["'", '"', "`"],
  tripleQuotes: false,
  keywords: GO_KEYWORD,
  controls: GO_CONTROL,
  caseInsensitive: false,
  dollarVar: false,
  phpTags: false,
  decorator: false,
};

const RUST_KEYWORD = new Set([
  "fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "as",
  "ref", "self", "Self", "where", "move", "dyn", "crate", "unsafe",
]);

const RUST_CONTROL = new Set([
  "if", "else", "for", "while", "return", "switch", "case", "break", "continue", "try",
  "catch", "throw", "defer",
]);

const RUST_OPTIONS: CodeOptions = {
  lineComments: ["//"],
  blockComment: true,
  hashComment: false,
  quotes: ["'", '"'],
  tripleQuotes: false,
  keywords: RUST_KEYWORD,
  controls: RUST_CONTROL,
  caseInsensitive: false,
  dollarVar: false,
  phpTags: false,
  decorator: false,
};

const JAVA_KEYWORD = new Set([
  "class", "interface", "public", "private", "protected", "static", "final", "void", "new",
  "extends", "implements", "package", "import", "abstract", "val", "var", "fun", "struct",
  "enum",
]);

const JAVA_CONTROL = new Set([
  "if", "else", "for", "while", "return", "switch", "case", "break", "continue", "try",
  "catch", "throw", "defer",
]);

const JAVA_OPTIONS: CodeOptions = {
  lineComments: ["//"],
  blockComment: true,
  hashComment: false,
  quotes: ["'", '"'],
  tripleQuotes: false,
  keywords: JAVA_KEYWORD,
  controls: JAVA_CONTROL,
  caseInsensitive: false,
  dollarVar: false,
  phpTags: false,
  decorator: false,
};

const PHP_KEYWORD = new Set([
  "function", "class", "public", "private", "protected", "static", "new", "use", "namespace",
  "extends", "implements", "echo", "null", "true", "false",
]);

const PHP_CONTROL = new Set([
  "if", "else", "elseif", "foreach", "for", "while", "switch", "case", "return", "try",
  "catch", "throw",
]);

const PHP_OPTIONS: CodeOptions = {
  lineComments: ["//", "#"],
  blockComment: true,
  hashComment: false,
  quotes: ["'", '"'],
  tripleQuotes: false,
  keywords: PHP_KEYWORD,
  controls: PHP_CONTROL,
  caseInsensitive: false,
  dollarVar: true,
  phpTags: true,
  decorator: false,
};

const PY_KEYWORD = new Set([
  "def", "class", "lambda", "None", "True", "False", "and", "or", "not", "is", "in", "pass",
  "global", "nonlocal", "with", "as",
]);

const PY_CONTROL = new Set([
  "if", "elif", "else", "for", "while", "return", "yield", "raise", "try", "except",
  "finally", "import", "from", "break", "continue", "await", "async", "assert", "del",
  "match", "case",
]);

const PY_OPTIONS: CodeOptions = {
  lineComments: [],
  blockComment: false,
  hashComment: true,
  quotes: ["'", '"'],
  tripleQuotes: true,
  keywords: PY_KEYWORD,
  controls: PY_CONTROL,
  caseInsensitive: false,
  dollarVar: false,
  phpTags: false,
  decorator: true,
};

const SQL_KEYWORD = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "on", "group", "by",
  "order", "having", "limit", "insert", "into", "values", "update", "set", "delete", "create",
  "table", "alter", "drop", "index", "primary", "key", "foreign", "references", "not", "null",
  "and", "or", "in", "as", "union", "distinct", "case", "when", "then", "else", "end",
]);

const SQL_OPTIONS: CodeOptions = {
  lineComments: ["--"],
  blockComment: true,
  hashComment: false,
  quotes: ["'"],
  tripleQuotes: false,
  keywords: SQL_KEYWORD,
  controls: new Set<string>(),
  caseInsensitive: true,
  dollarVar: false,
  phpTags: false,
  decorator: false,
};

function scanJson(content: string): Token[] {
  const sink = new Sink();
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content.charAt(i);
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      let k = j;
      while (k < n && (content[k] === " " || content[k] === "\t" || content[k] === "\n")) k += 1;
      sink.push(content[k] === ":" ? "property" : "string", content.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(ch.charCodeAt(0)) || (ch === "-" && isDigit(content.charCodeAt(i + 1)))) {
      const j = scanNumber(content, i);
      sink.push("number", content.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(ch.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && isIdent(content.charCodeAt(j))) j += 1;
      const word = content.slice(i, j);
      sink.push(word === "true" || word === "false" || word === "null" ? "keyword" : "plain", word);
      i = j;
      continue;
    }
    sink.push("plain", ch);
    i += 1;
  }
  return sink.tokens;
}

function scanCss(content: string): Token[] {
  const sink = new Sink();
  const n = content.length;
  let i = 0;
  let context: "selector" | "block" | "value" = "selector";
  while (i < n) {
    const ch = content.charAt(i);
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      sink.push("comment", content.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      sink.push("string", content.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "@" && isIdentStart(content.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-")) j += 1;
      sink.push("keyword", content.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "{") {
      sink.push("plain", "{");
      context = "block";
      i += 1;
      continue;
    }
    if (ch === "}") {
      sink.push("plain", "}");
      context = "selector";
      i += 1;
      continue;
    }
    if (ch === ";") {
      sink.push("plain", ";");
      context = "block";
      i += 1;
      continue;
    }
    if (ch === ":" && context === "block") {
      sink.push("plain", ":");
      context = "value";
      i += 1;
      continue;
    }
    if (ch === "#") {
      let j = i + 1;
      while (j < n && isHex(content.charCodeAt(j))) j += 1;
      if (context === "value" && j > i + 1) {
        sink.push("number", content.slice(i, j));
        i = j;
        continue;
      }
      let k = i + 1;
      while (k < n && isIdent(content.charCodeAt(k))) k += 1;
      if (k > i + 1) {
        sink.push("type", content.slice(i, k));
        i = k;
        continue;
      }
      sink.push("plain", ch);
      i += 1;
      continue;
    }
    if (ch === "." && context === "selector" && isIdentStart(content.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdent(content.charCodeAt(j))) j += 1;
      sink.push("type", content.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "-" && content[i + 1] === "-" && isIdentStart(content.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-")) j += 1;
      sink.push("variable", content.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(ch.charCodeAt(0)) || (ch === "." && isDigit(content.charCodeAt(i + 1)))) {
      const j = scanNumber(content, i);
      let k = j;
      while (k < n && (isIdent(content.charCodeAt(k)) || content[k] === "%")) k += 1;
      sink.push("number", content.slice(i, k));
      i = k;
      continue;
    }
    if (isIdentStart(ch.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-")) j += 1;
      const word = content.slice(i, j);
      if (context === "selector") sink.push("tag", word);
      else if (context === "block") sink.push("property", word);
      else if (content[j] === "(") sink.push("function", word);
      else sink.push("plain", word);
      i = j;
      continue;
    }
    sink.push("plain", ch);
    i += 1;
  }
  return sink.tokens;
}

function indexOfIgnoreCase(haystack: string, needle: string, from: number): number {
  const h = haystack.length;
  const m = needle.length;
  for (let i = from; i + m <= h; i += 1) {
    let ok = true;
    for (let k = 0; k < m; k += 1) {
      if (haystack.charAt(i + k).toLowerCase() !== needle.charAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function scanHtml(content: string): Token[] {
  const sink = new Sink();
  const n = content.length;
  let i = 0;
  while (i < n) {
    if (content.startsWith("<!--", i)) {
      const end = content.indexOf("-->", i + 4);
      const j = end === -1 ? n : end + 3;
      sink.push("comment", content.slice(i, j));
      i = j;
      continue;
    }
    if (content[i] === "<") {
      if (/^<!doctype/i.test(content.slice(i, i + 9))) {
        const end = content.indexOf(">", i);
        const j = end === -1 ? n : end + 1;
        sink.push("keyword", content.slice(i, j));
        i = j;
        continue;
      }
      let j = i + 1;
      if (content[j] === "/") j += 1;
      const nameStart = j;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-" || content[j] === ":")) {
        j += 1;
      }
      if (j === nameStart) {
        sink.push("plain", "<");
        i += 1;
        continue;
      }
      const tagName = content.slice(nameStart, j).toLowerCase();
      sink.push("tag", content.slice(i, j));
      i = j;
      while (i < n && content[i] !== ">") {
        const ch = content.charAt(i);
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "/" || ch === "=") {
          sink.push("plain", ch);
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          let k = i + 1;
          while (k < n && content[k] !== ch) k += 1;
          if (k < n) k += 1;
          sink.push("string", content.slice(i, k));
          i = k;
          continue;
        }
        if (isIdentStart(ch.charCodeAt(0)) || ch === "-" || ch === ":") {
          let k = i + 1;
          while (k < n && (isIdent(content.charCodeAt(k)) || content[k] === "-" || content[k] === ":")) {
            k += 1;
          }
          sink.push("attr", content.slice(i, k));
          i = k;
          continue;
        }
        sink.push("plain", ch);
        i += 1;
      }
      if (i < n) {
        sink.push("plain", ">");
        i += 1;
      }
      if (tagName === "script" || tagName === "style") {
        const close = indexOfIgnoreCase(content, `</${tagName}`, i);
        const end = close === -1 ? n : close;
        if (end > i) {
          sink.push("plain", content.slice(i, end));
          i = end;
        }
      }
      continue;
    }
    sink.push("plain", content.charAt(i));
    i += 1;
  }
  return sink.tokens;
}

const SH_CONTROL = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "in", "function", "select", "return", "exit", "local", "export", "readonly", "set", "unset",
  "source",
]);

function scanSh(content: string): Token[] {
  const sink = new Sink();
  const n = content.length;
  let i = 0;
  let atCommandStart = true;
  while (i < n) {
    const ch = content.charAt(i);
    if (i === 0 && content.startsWith("#!")) {
      let j = 0;
      while (j < n && content[j] !== "\n") j += 1;
      sink.push("comment", content.slice(0, j));
      i = j;
      continue;
    }
    if (ch === "\n") {
      sink.push("plain", "\n");
      i += 1;
      atCommandStart = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      sink.push("plain", ch);
      i += 1;
      continue;
    }
    if (ch === "#") {
      const prev = i > 0 ? content[i - 1] : "";
      const prev2 = i > 1 ? content[i - 2] : "";
      if (prev === "$" || (prev === "{" && prev2 === "$")) {
        sink.push("plain", ch);
        i += 1;
        continue;
      }
      let j = i;
      while (j < n && content[j] !== "\n") j += 1;
      sink.push("comment", content.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (ch === '"' && content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      sink.push("string", content.slice(i, j));
      i = j;
      atCommandStart = false;
      continue;
    }
    if (ch === "$") {
      if (content[i + 1] === "(") {
        sink.push("variable", "$(");
        i += 2;
        atCommandStart = true;
        continue;
      }
      if (content[i + 1] === "{") {
        let j = i + 2;
        while (j < n && content[j] !== "}") j += 1;
        if (j < n) j += 1;
        sink.push("variable", content.slice(i, j));
        i = j;
        atCommandStart = false;
        continue;
      }
      if (isIdentStart(content.charCodeAt(i + 1))) {
        let j = i + 1;
        while (j < n && isIdent(content.charCodeAt(j))) j += 1;
        sink.push("variable", content.slice(i, j));
        i = j;
        atCommandStart = false;
        continue;
      }
      sink.push("plain", ch);
      i += 1;
      continue;
    }
    if (ch === "-" && (isIdentStart(content.charCodeAt(i + 1)) || content[i + 1] === "-")) {
      let j = i + 1;
      if (content[j] === "-") j += 1;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-")) j += 1;
      sink.push("property", content.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(ch.charCodeAt(0))) {
      const j = scanNumber(content, i);
      sink.push("number", content.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(ch.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && (isIdent(content.charCodeAt(j)) || content[j] === "-" || content[j] === ".")) {
        j += 1;
      }
      const word = content.slice(i, j);
      if (SH_CONTROL.has(word)) {
        sink.push("control", word);
        atCommandStart = false;
      } else if (atCommandStart) {
        sink.push("function", word);
        atCommandStart = false;
      } else {
        sink.push("plain", word);
      }
      i = j;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      sink.push("plain", ch);
      i += 1;
      atCommandStart = true;
      continue;
    }
    sink.push("plain", ch);
    i += 1;
  }
  return sink.tokens;
}

const YAML_BOOLS = new Set(["true", "false", "null", "yes", "no", "~"]);

interface ValueOptions {
  anchors: boolean;
  bools: ReadonlySet<string>;
}

function scanValueLine(line: string, start: number, sink: Sink, options: ValueOptions): void {
  const n = line.length;
  let i = start;
  while (i < n) {
    const ch = line.charAt(i);
    if (ch === " " || ch === "\t") {
      sink.push("plain", ch);
      i += 1;
      continue;
    }
    if (ch === "#" || ch === ";") {
      sink.push("comment", line.slice(i));
      return;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      sink.push("string", line.slice(i, j));
      i = j;
      continue;
    }
    if (options.anchors && (ch === "&" || ch === "*") && isIdentStart(line.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdent(line.charCodeAt(j))) j += 1;
      sink.push("type", line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "-" && isDigit(line.charCodeAt(i + 1))) {
      sink.push("plain", "-");
      i += 1;
      continue;
    }
    if (isDigit(ch.charCodeAt(0))) {
      const j = scanNumber(line, i);
      sink.push("number", line.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(ch.charCodeAt(0))) {
      let j = i + 1;
      while (j < n && isIdent(line.charCodeAt(j))) j += 1;
      const word = line.slice(i, j);
      sink.push(options.bools.has(word.toLowerCase()) ? "keyword" : "plain", word);
      i = j;
      continue;
    }
    sink.push("plain", ch);
    i += 1;
  }
}

function scanYamlLine(line: string, sink: Sink): void {
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === " " || line[i] === "\t")) {
    sink.push("plain", line.charAt(i));
    i += 1;
  }
  if (i < n && line[i] === "-" && (i + 1 >= n || line[i + 1] === " ")) {
    sink.push("plain", "-");
    i += 1;
    while (i < n && line[i] === " ") {
      sink.push("plain", line.charAt(i));
      i += 1;
    }
  }
  if (i >= n) return;
  if (line[i] === "#") {
    sink.push("comment", line.slice(i));
    return;
  }
  let j = i;
  while (j < n && (isIdent(line.charCodeAt(j)) || line[j] === "." || line[j] === "-")) j += 1;
  if (j > i) {
    let k = j;
    while (k < n && (line[k] === " " || line[k] === "\t")) k += 1;
    if (k < n && line[k] === ":") {
      sink.push("property", line.slice(i, j));
      sink.push("plain", line.slice(j, k + 1));
      i = k + 1;
    }
  }
  scanValueLine(line, i, sink, { anchors: true, bools: YAML_BOOLS });
}

function scanYaml(content: string): Token[] {
  const sink = new Sink();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) sink.push("plain", "\n");
    scanYamlLine(lines[index] ?? "", sink);
  }
  return sink.tokens;
}

function scanMdLine(line: string, sink: Sink): void {
  const n = line.length;
  if (/^#{1,6}\s/.test(line)) {
    sink.push("heading", line);
    return;
  }
  let i = 0;
  const marker = /^(\s*)([-*+]\s|\d+\.\s|>\s)/.exec(line);
  if (marker !== null) {
    if ((marker[1] ?? "") !== "") sink.push("plain", marker[1] ?? "");
    sink.push("keyword", marker[2] ?? "");
    i = marker[0].length;
  }
  while (i < n) {
    const ch = line.charAt(i);
    if (ch === "`") {
      let j = i + 1;
      while (j < n && line[j] !== "`") j += 1;
      if (j < n) j += 1;
      sink.push("string", line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2);
      if (end !== -1) {
        sink.push("keyword", line.slice(i, end + 2));
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && line[i + 1] !== "*") {
      const end = line.indexOf("*", i + 1);
      if (end !== -1) {
        sink.push("keyword", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = line.indexOf("]", i + 1);
      if (close !== -1 && line[close + 1] === "(") {
        const paren = line.indexOf(")", close + 2);
        if (paren !== -1) {
          sink.push("function", line.slice(i, close + 1));
          sink.push("string", line.slice(close + 1, paren + 1));
          i = paren + 1;
          continue;
        }
      }
    }
    sink.push("plain", ch);
    i += 1;
  }
}

function scanMd(content: string): Token[] {
  const sink = new Sink();
  const lines = content.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) sink.push("plain", "\n");
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      sink.push("comment", line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line !== "") sink.push("string", line);
      continue;
    }
    scanMdLine(line, sink);
  }
  return sink.tokens;
}

const TOML_BOOLS = new Set(["true", "false"]);

function scanTomlLine(line: string, sink: Sink): void {
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === " " || line[i] === "\t")) {
    sink.push("plain", line.charAt(i));
    i += 1;
  }
  if (i >= n) return;
  if (line[i] === "#" || line[i] === ";") {
    sink.push("comment", line.slice(i));
    return;
  }
  if (line[i] === "[") {
    const end = line.indexOf("]", i);
    const j = end === -1 ? n : end + 1;
    sink.push("type", line.slice(i, j));
    scanValueLine(line, j, sink, { anchors: false, bools: TOML_BOOLS });
    return;
  }
  let j = i;
  while (j < n && line[j] !== "=" && line[j] !== "#" && line[j] !== ";") j += 1;
  if (j < n && line[j] === "=") {
    let keyEnd = j;
    while (keyEnd > i && (line[keyEnd - 1] === " " || line[keyEnd - 1] === "\t")) keyEnd -= 1;
    sink.push("property", line.slice(i, keyEnd));
    sink.push("plain", line.slice(keyEnd, j + 1));
    i = j + 1;
  }
  scanValueLine(line, i, sink, { anchors: false, bools: TOML_BOOLS });
}

function scanToml(content: string): Token[] {
  const sink = new Sink();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) sink.push("plain", "\n");
    scanTomlLine(lines[index] ?? "", sink);
  }
  return sink.tokens;
}

function scanDiff(content: string): Token[] {
  const sink = new Sink();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) sink.push("plain", "\n");
    const line = lines[index] ?? "";
    if (line === "") continue;
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---")
    ) {
      sink.push("heading", line);
    } else if (line.startsWith("@@")) {
      sink.push("keyword", line);
    } else if (line.startsWith("+")) {
      sink.push("inserted", line);
    } else if (line.startsWith("-")) {
      sink.push("deleted", line);
    } else {
      sink.push("plain", line);
    }
  }
  return sink.tokens;
}

function scan(content: string, lang: LangId): Token[] {
  switch (lang) {
    case "ts":
    case "js":
      return scanCode(content, TS_OPTIONS);
    case "go":
      return scanCode(content, GO_OPTIONS);
    case "rust":
      return scanCode(content, RUST_OPTIONS);
    case "java":
      return scanCode(content, JAVA_OPTIONS);
    case "php":
      return scanCode(content, PHP_OPTIONS);
    case "py":
      return scanCode(content, PY_OPTIONS);
    case "sql":
      return scanCode(content, SQL_OPTIONS);
    case "json":
      return scanJson(content);
    case "css":
      return scanCss(content);
    case "html":
      return scanHtml(content);
    case "sh":
      return scanSh(content);
    case "yaml":
      return scanYaml(content);
    case "md":
      return scanMd(content);
    case "toml":
      return scanToml(content);
    case "diff":
      return scanDiff(content);
    case "plain":
      return [];
  }
}

/** Pecah token yang mungkin memuat newline menjadi satu array per baris. */
function toLines(tokens: readonly Token[], content: string): Token[][] {
  const lines: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        lines.push(current);
        current = [];
      }
      const part = parts[index] ?? "";
      if (part !== "") current.push({ text: part, kind: token.kind });
    }
  }
  lines.push(current);
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function plainLines(lines: readonly string[]): Token[][] {
  return lines.map((line) => (line === "" ? [] : [{ text: line, kind: "plain" as const }]));
}

/**
 * Token per baris untuk `content`. Baris kosong menjadi `[]`. Bila bahasa "plain"
 * atau jumlah baris melebihi `MAX_HIGHLIGHT_LINES`, semua token menjadi "plain".
 */
export function highlight(content: string, lang: LangId): Token[][] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const rawLines = normalized.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (lang === "plain" || rawLines.length > MAX_HIGHLIGHT_LINES) {
    return plainLines(rawLines);
  }
  return toLines(scan(normalized, lang), normalized);
}
