import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { runGit } from "./changes";
import { FileError } from "./path";

export interface SearchMatch {
  /** Path relatif terhadap root, selalu memakai "/" sebagai pemisah. */
  path: string;
  /** Nomor baris 1-based. */
  line: number;
  /** Baris yang cocok, dipotong maksimal 300 karakter. */
  text: string;
  /**
   * Rentang karakter kecocokan di dalam `text` (indeks karakter UTF-16, mulai 0,
   * akhir eksklusif); tak ada bila tak diketahui.
   */
  ranges?: { start: number; end: number }[];
}

export interface SearchResult {
  matches: SearchMatch[];
  /**
   * Jumlah berkas yang dipindai. Pada mode git berarti jumlah berkas berbeda
   * yang punya kecocokan, bukan jumlah berkas yang diperiksa git.
   */
  files: number;
  truncated: boolean;
  /** Mesin yang dipakai: "git" (git grep) atau "scan" (pemindai berkas). */
  engine: "git" | "scan";
}

export interface SearchOptions {
  /** Default false (tidak peka huruf besar-kecil). */
  caseSensitive?: boolean;
  /** Default 200. */
  maxMatches?: number;
  /** Default 5000. */
  maxFiles?: number;
  /** Default 4000 ms; 0 membuat pencarian langsung terpotong. */
  deadlineMs?: number;
  /** Default false: pola dicari sebagai literal, bukan regex. */
  regex?: boolean;
  /** Default false: pola hanya cocok sebagai satu kata utuh. */
  wholeWord?: boolean;
  /** Glob sertakan (opsional); dikosongkan berarti semua berkas. */
  include?: string[];
  /** Glob kecualikan (opsional). */
  exclude?: string[];
}

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_DEADLINE_MS = 4000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 300;
const MAX_RANGES_PER_LINE = 20;
const MAX_GLOB_PATTERNS = 10;
const MAX_GLOB_LENGTH = 200;
/** Batas keluaran git grep per perintah (2 MiB). */
const GIT_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

const INVALID_GLOB = "Pola berkas tidak valid.";
const INVALID_REGEX = "Pola regex tidak valid.";
const REGEX_NEEDS_GIT = "Regex memerlukan repo git.";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".venv",
  "target",
  "vendor",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });

function hasNullByte(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/** Teks UTF-8 yang valid dan tanpa NUL di awal berkas; selain itu dianggap biner. */
function isText(bytes: Uint8Array): string | null {
  if (hasNullByte(bytes)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function invalidGlob(): FileError {
  return new FileError(INVALID_GLOB, "tidak-valid");
}

/**
 * Membersihkan satu pola glob: membuang awalan "./" dan "/", lalu menolak
 * segmen ".." supaya pola tak pernah keluar dari folder kerja.
 */
function normalizeGlobPattern(pattern: string): string {
  if (pattern.length < 1 || pattern.length > MAX_GLOB_LENGTH) throw invalidGlob();
  if (pattern.includes("\0") || /[\r\n]/.test(pattern)) throw invalidGlob();
  let value = pattern;
  for (;;) {
    if (value.startsWith("./")) {
      value = value.slice(2);
      continue;
    }
    if (value.startsWith("/")) {
      value = value.slice(1);
      continue;
    }
    break;
  }
  if (value.length < 1 || value.length > MAX_GLOB_LENGTH) throw invalidGlob();
  if (value.split("/").includes("..")) throw invalidGlob();
  return value;
}

/** Validasi daftar glob: maksimal 10 pola, tiap pola 1..200 karakter. */
function normalizeGlobList(patterns: string[] | undefined): string[] {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || patterns.length > MAX_GLOB_PATTERNS) throw invalidGlob();
  const result: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw invalidGlob();
    result.push(normalizeGlobPattern(pattern));
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/**
 * Pola RegExp dari literal yang di-escape. Dengan `wholeWord`, batas kata
 * ditambahkan hanya bila ujung literal berupa karakter kata.
 */
function literalPattern(needle: string, wholeWord: boolean): string {
  const escaped = escapeRegExp(needle);
  if (!wholeWord) return escaped;
  const first = needle[0] ?? "";
  const last = needle[needle.length - 1] ?? "";
  const prefix = isWordChar(first) ? "\\b" : "";
  const suffix = isWordChar(last) ? "\\b" : "";
  return `${prefix}${escaped}${suffix}`;
}

/** Menemukan seluruh kemunculan `needle` di dalam `text` (maks 20 rentang). */
function locateLiteralRanges(
  text: string,
  needle: string,
  caseSensitive: boolean,
  limit: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  if (target === "") return ranges;
  let cursor = 0;
  while (ranges.length < MAX_RANGES_PER_LINE) {
    const index = haystack.indexOf(target, cursor);
    if (index === -1) break;
    const start = index;
    const end = index + target.length;
    cursor = end;
    if (start >= limit) break;
    ranges.push({ start, end: Math.min(end, limit) });
  }
  return ranges;
}

/** Menemukan kemunculan literal dengan batas kata (maks 20 rentang). */
function locateWordRanges(
  finder: RegExp,
  text: string,
  limit: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  finder.lastIndex = 0;
  let match = finder.exec(text);
  while (match !== null && ranges.length < MAX_RANGES_PER_LINE) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= limit) break;
    ranges.push({ start, end: Math.min(end, limit) });
    if (match[0].length === 0) finder.lastIndex += 1;
    match = finder.exec(text);
  }
  return ranges;
}

/**
 * Rentang kemunculan pola literal di dalam satu baris. Dengan `wholeWord`
 * hanya kemunculan berujung batas kata yang dihitung, sama seperti `git grep -w`.
 */
function locateMatches(
  text: string,
  needle: string,
  caseSensitive: boolean,
  limit: number,
  wholeWord: boolean,
): { start: number; end: number }[] {
  if (!wholeWord) return locateLiteralRanges(text, needle, caseSensitive, limit);
  const flags = caseSensitive ? "" : "i";
  return locateWordRanges(new RegExp(literalPattern(needle, true), `${flags}g`), text, limit);
}

interface State {
  root: string;
  needle: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Penguji batas kata; null bila pola dicari tanpa batas kata. */
  tester: RegExp | null;
  include: Bun.Glob[];
  exclude: Bun.Glob[];
  matches: SearchMatch[];
  files: number;
  truncated: boolean;
  maxMatches: number;
  maxFiles: number;
  deadline: number;
}

function outOfTime(state: State): boolean {
  return Date.now() >= state.deadline;
}

/** Berkas lolos bila (include kosong atau cocok salah satu) dan tak ada exclude yang cocok. */
function allowedByGlobs(state: State, relPath: string): boolean {
  if (state.include.length > 0 && !state.include.some((glob) => glob.match(relPath))) return false;
  return !state.exclude.some((glob) => glob.match(relPath));
}

async function scanFile(state: State, fullPath: string, relPath: string): Promise<void> {
  if (!allowedByGlobs(state, relPath)) return;
  let info;
  try {
    info = await lstat(fullPath);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  if (state.files >= state.maxFiles) {
    state.truncated = true;
    return;
  }
  state.files += 1;
  if (info.size > MAX_SEARCH_FILE_BYTES) return;

  let bytes: Uint8Array;
  try {
    bytes = await readFile(fullPath);
  } catch {
    return;
  }
  const text = isText(bytes);
  if (text === null) return;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const found = state.tester === null
      ? (state.caseSensitive ? line : line.toLowerCase()).includes(state.needle)
      : state.tester.test(line);
    if (!found) continue;
    if (state.matches.length >= state.maxMatches) {
      state.truncated = true;
      return;
    }
    const full = line.replace(/\r$/, "");
    const clipped = full.slice(0, MAX_TEXT_CHARS);
    const match: SearchMatch = { path: relPath, line: index + 1, text: clipped };
    const ranges = locateMatches(
      full,
      state.needle,
      state.caseSensitive,
      clipped.length,
      state.wholeWord,
    );
    if (ranges.length > 0) match.ranges = ranges;
    state.matches.push(match);
  }
}

async function scanDir(state: State, dir: string): Promise<void> {
  if (state.truncated || outOfTime(state)) {
    state.truncated = true;
    return;
  }

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => compareNames(a.name, b.name));

  for (const dirent of dirents) {
    if (state.truncated) return;
    if (outOfTime(state)) {
      state.truncated = true;
      return;
    }
    // Symlink selalu dilewati, baik ke berkas maupun folder.
    if (dirent.isSymbolicLink()) continue;

    const fullPath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      await scanDir(state, fullPath);
      continue;
    }
    if (!dirent.isFile()) continue;

    const rel = relative(state.root, fullPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    await scanFile(state, fullPath, rel.split(sep).join("/"));
  }
}

/**
 * Pencarian teks di dalam folder kerja. Bila folder kerja berada di repo git,
 * pencarian memakai `git grep` (menghormati .gitignore, mendukung regex POSIX,
 * dan bisa dibunuh saat tenggat habis). Di luar repo git, berkas dipindai
 * langsung dan regex tidak tersedia.
 */
export async function searchText(
  root: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const caseSensitive = options.caseSensitive ?? false;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const regex = options.regex ?? false;
  const wholeWord = options.wholeWord ?? false;
  const include = normalizeGlobList(options.include);
  const exclude = normalizeGlobList(options.exclude);

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FileError("Folder kerja tidak ditemukan.", "tidak-ditemukan");
  }

  const gitResult = await searchWithGit(realRoot, query, {
    regex,
    wholeWord,
    caseSensitive,
    include,
    exclude,
    maxMatches,
    deadlineMs,
  });
  if (gitResult !== null) return gitResult;

  // Regex tak bisa dijalankan di proses server, jadi butuh repo git.
  if (regex) throw new FileError(REGEX_NEEDS_GIT, "tidak-valid");

  const needle = caseSensitive ? query : query.toLowerCase();
  const flags = caseSensitive ? "" : "i";
  // Regex batas kata memakai query asli; huruf besar-kecil ditangani flag "i".
  const wordPattern = literalPattern(query, true);
  const state: State = {
    root: realRoot,
    needle,
    caseSensitive,
    wholeWord,
    tester: wholeWord ? new RegExp(wordPattern, flags) : null,
    include: include.map((pattern) => new Bun.Glob(pattern)),
    exclude: exclude.map((pattern) => new Bun.Glob(pattern)),
    matches: [],
    files: 0,
    truncated: false,
    maxMatches,
    maxFiles,
    deadline: Date.now() + deadlineMs,
  };
  if (outOfTime(state)) {
    state.truncated = true;
  } else {
    await scanDir(state, realRoot);
  }

  return { matches: state.matches, files: state.files, truncated: state.truncated, engine: "scan" };
}

interface GitHit {
  path: string;
  line: number;
  /** Kolom (offset byte mulai 1) dari kecocokan pertama pada baris itu. */
  column: number;
  text: string;
}

/**
 * Mengurai keluaran `git grep -z`: `path\0baris\0kolom\0teks\n` untuk tiap
 * catatan. Pemisah NUL membuat nama berkas berisi ":" atau spasi tetap aman.
 */
function parseGitHits(stdout: string): GitHit[] {
  const hits: GitHit[] = [];
  const tokens = stdout.split("\0");
  let path = tokens[0] ?? "";
  for (let index = 1; index + 2 < tokens.length; index += 3) {
    const textToken = tokens[index + 2] ?? "";
    const newline = textToken.indexOf("\n");
    // Catatan tanpa "\n" berarti keluaran terpotong; buang sisa.
    if (newline === -1) break;
    const line = Number(tokens[index]);
    const column = Number(tokens[index + 1]);
    const text = textToken.slice(0, newline);
    // Path berikutnya menyusul setelah "\n" pada teks catatan ini.
    const nextPath = textToken.slice(newline + 1);
    if (Number.isInteger(line) && line >= 1) {
      hits.push({ path, line, column: Number.isFinite(column) ? column : 1, text });
    }
    path = nextPath;
  }
  return hits;
}

/** Git yang dibangun tanpa PCRE menolak `-P` dengan pesan ini. */
const NO_PCRE = /not compiled|perl-compatible|pcre/i;

function isNotARepo(stderr: string): boolean {
  return stderr.includes("not a git repository");
}

/** Git melaporkan pola regex yang rusak lewat pesan galat; pesan ini dikenali di sini. */
function isInvalidPattern(stderr: string): boolean {
  return /not balanced|unbalanced|unmatched|unterminated|no terminating|invalid|malformed|bad regex|regular expression|pattern|missing|parenthes|fatal: (command-line|-e option)/i.test(
    stderr,
  );
}

interface GitSearchOptions {
  regex: boolean;
  wholeWord: boolean;
  caseSensitive: boolean;
  include: string[];
  exclude: string[];
  maxMatches: number;
  deadlineMs: number;
}

function gitGrepArgs(
  options: GitSearchOptions,
  query: string,
  regexFlag: "-P" | "-E",
): { main: string[]; only: string[] } {
  const flags = [
    "grep",
    "-n",
    "-I",
    "--column",
    "-z",
    "--no-color",
    "--untracked",
    "--exclude-standard",
  ];
  flags.push(options.regex ? regexFlag : "-F");
  if (!options.caseSensitive) flags.push("-i");
  if (options.wholeWord) flags.push("-w");
  const pattern = ["-e", query, "--"];
  const paths: string[] = [];
  for (const include of options.include) paths.push(`:(glob)${include}`);
  for (const exclude of options.exclude) paths.push(`:(exclude,glob)${exclude}`);
  if (options.include.length === 0) paths.push(".");
  return {
    main: [...flags, ...pattern, ...paths],
    only: [...flags, "-o", ...pattern, ...paths],
  };
}

/**
 * Menjalankan `git grep`; untuk regex, `git grep -o` juga dijalankan (paralel)
 * untuk mengetahui tiap kemunculan. Mengembalikan null bila git tak bisa
 * dipakai (bukan repo git), supaya pemindai berkas dipakai sebagai cadangan.
 */
async function searchWithGit(
  realRoot: string,
  query: string,
  options: GitSearchOptions,
): Promise<SearchResult | null> {
  const timeoutMs = Math.max(1, options.deadlineMs);
  const run = async (regexFlag: "-P" | "-E") => {
    const args = gitGrepArgs(options, query, regexFlag);
    const [mainRun, onlyRun] = await Promise.all([
      runGit(args.main, realRoot, { timeoutMs }, GIT_OUTPUT_MAX_BYTES),
      // Untuk pola literal, kemunculannya bisa dihitung sendiri; `-o` hanya perlu
      // kalau polanya regex (pola tak boleh dijalankan di proses server).
      options.regex
        ? runGit(args.only, realRoot, { timeoutMs }, GIT_OUTPUT_MAX_BYTES)
        : Promise.resolve(null),
    ]);
    return { main: mainRun, only: onlyRun };
  };
  // Regex memakai PCRE (`\d`, `\w`, lookahead); git tanpa PCRE jatuh ke POSIX ERE.
  let { main, only } = await run("-P");
  if (options.regex && main.code !== 0 && main.code !== 1 && NO_PCRE.test(main.stderr)) {
    ({ main, only } = await run("-E"));
  }

  if (isNotARepo(main.stderr)) return null;
  if (options.regex && isInvalidPattern(main.stderr)) {
    throw new FileError(INVALID_REGEX, "tidak-valid");
  }
  const failed = main.code !== 0 && main.code !== 1;
  if (failed && !main.truncated && !main.timedOut) return null;

  // Kumpulan kemunculan per baris dari keluaran `-o` (hanya untuk regex).
  const occurrences = new Map<string, GitHit[]>();
  if (only !== null && only.code === 0 && !only.timedOut) {
    for (const hit of parseGitHits(only.stdout)) {
      const key = `${hit.path}\0${hit.line}`;
      const list = occurrences.get(key);
      if (list === undefined) {
        occurrences.set(key, [hit]);
      } else if (list.length < MAX_RANGES_PER_LINE) {
        list.push(hit);
      }
    }
  }

  const hits = parseGitHits(main.stdout);
  const matches: SearchMatch[] = [];
  let truncated = main.truncated || main.timedOut;
  for (const hit of hits) {
    if (matches.length >= options.maxMatches) {
      truncated = true;
      break;
    }
    const full = hit.text.replace(/\r$/, "");
    const clipped = full.slice(0, MAX_TEXT_CHARS);
    const match: SearchMatch = { path: hit.path, line: hit.line, text: clipped };
    const ranges = options.regex
      ? placeOccurrences(full, occurrences.get(`${hit.path}\0${hit.line}`), clipped.length)
      : locateMatches(full, query, options.caseSensitive, clipped.length, options.wholeWord);
    if (ranges.length > 0) match.ranges = ranges;
    matches.push(match);
  }

  const files = new Set(matches.map((match) => match.path)).size;
  return { matches, files, truncated, engine: "git" };
}

/**
 * Menentukan rentang karakter tiap kemunculan dalam satu baris dari keluaran
 * `git grep -o`. Kolom `-o` untuk kemunculan kedua dan seterusnya tidak bisa
 * dipercaya (relatif ke kemunculan sebelumnya), jadi hanya teks kecocokannya
 * yang dipakai: dicari berurutan di baris mulai dari akhir kemunculan lalu.
 */
function placeOccurrences(
  text: string,
  records: GitHit[] | undefined,
  limit: number,
): { start: number; end: number }[] {
  if (records === undefined) return [];
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const record of records) {
    if (record.text.length === 0) continue;
    const start = text.indexOf(record.text, cursor);
    if (start === -1 || start >= limit) break;
    const end = start + record.text.length;
    ranges.push({ start, end: Math.min(end, limit) });
    cursor = end;
    if (ranges.length >= MAX_RANGES_PER_LINE) break;
  }
  return ranges;
}
