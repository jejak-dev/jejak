import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { FileError } from "./path";

export interface SearchMatch {
  /** Path relatif terhadap root, selalu memakai "/" sebagai pemisah. */
  path: string;
  /** Nomor baris 1-based. */
  line: number;
  /** Baris yang cocok, dipotong maksimal 300 karakter. */
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** Jumlah berkas yang dipindai. */
  files: number;
  truncated: boolean;
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
}

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_DEADLINE_MS = 4000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 300;

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

interface State {
  root: string;
  needle: string;
  caseSensitive: boolean;
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

async function scanFile(state: State, fullPath: string, relPath: string): Promise<void> {
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
    const haystack = state.caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(state.needle)) continue;
    if (state.matches.length >= state.maxMatches) {
      state.truncated = true;
      return;
    }
    state.matches.push({
      path: relPath,
      line: index + 1,
      text: line.replace(/\r$/, "").slice(0, MAX_TEXT_CHARS),
    });
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
 * Pencarian teks literal (bukan regex) di seluruh berkas teks di bawah `root`.
 * Hanya membaca sistem berkas: tidak menjalankan proses luar, melewati symlink
 * dan folder yang lazim tidak relevan (node_modules, .git, dist, dst.).
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

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FileError("Folder kerja tidak ditemukan.", "tidak-ditemukan");
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const state: State = {
    root: realRoot,
    needle,
    caseSensitive,
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

  return { matches: state.matches, files: state.files, truncated: state.truncated };
}
