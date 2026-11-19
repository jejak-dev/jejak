import { realpathSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import nodePath, { basename, dirname, join, resolve } from "node:path";

/** Batas jumlah berkas memory yang dibaca dari satu folder. */
export const CLAUDE_MEMORY_MAX_FILES = 200;
/** Batas ukuran satu berkas memory (64 KB). */
export const CLAUDE_MEMORY_FILE_MAX_BYTES = 64 * 1024;
/** Nama berkas index Claude Code; tidak ditampilkan sebagai memory. */
export const CLAUDE_MEMORY_INDEX_FILE = "MEMORY.md";

/** Jenis memory Claude Code yang dikenali. */
export type ClaudeMemoryType = "user" | "feedback" | "project" | "reference" | "unknown";

const CLAUDE_MEMORY_TYPES: readonly ClaudeMemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
];

export interface ClaudeMemoryItem {
  /** Nama berkas relatif di dalam folder memory (bukan path absolut). */
  file: string;
  title: string;
  description: string;
  type: ClaudeMemoryType;
  body: string;
  /** Waktu ubah berkas (ISO), dari mtime berkas. */
  updatedAt: string;
  /** True bila isi berkas dipotong karena melebihi batas ukuran. */
  truncated: boolean;
  /** Id memory Jejak bila berkas ini ditulis Jejak (frontmatter `jejak_id`). */
  jejakId?: string;
}

export interface ClaudeMemoryListing {
  /** False bila folder tidak ada atau tidak terbaca. */
  dirExists: boolean;
  /** Isi indeks `MEMORY.md` bila ada. */
  index?: string;
  items: ClaudeMemoryItem[];
}

/** Satu folder memory yang dicek, beserta labelnya. */
export interface ClaudeMemoryDir {
  label: string;
  dirExists: boolean;
  items: ClaudeMemoryItem[];
}

/** Hasil pembacaan memory Claude Code untuk satu proyek. */
export interface ClaudeMemoryResponse {
  /** Label proyek yang dibaca. */
  project: string;
  /** Folder yang dicek; bisa lebih dari satu untuk worktree. */
  dirs: ClaudeMemoryDir[];
}

/** Proyek Jejak yang dikenal: kunci proyek -> path absolut. */
export interface ClaudeProjectEntry {
  /** Kunci proyek (path folder kerja seperti pada data Jejak). */
  key: string;
  /** Path absolut yang dipakai untuk menghitung slug Claude Code. */
  path: string;
  /** Path alternatif (mis. tanpa resolusi symlink) yang juga mungkin dipakai. */
  altPaths?: string[];
  /** Kunci alternatif yang menunjuk proyek yang sama. */
  aliases?: string[];
  /** Path repo asal bila proyek ini worktree Jejak. */
  originPath?: string;
  /** Path repo asal tanpa resolusi symlink. */
  originAltPath?: string;
}

/** Sesi Jejak yang dipakai untuk menyusun daftar proyek. */
export interface ClaudeProjectSeed {
  cwd: string;
  worktree?: { path: string; repoRoot: string };
}

/**
 * Slug folder proyek Claude Code: path absolut dengan setiap karakter
 * non-alfanumerik diganti `-`.
 */
export function claudeProjectSlug(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** Root konfigurasi Claude Code: `CLAUDE_CONFIG_DIR` atau `~/.claude`. */
export function claudeConfigRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return join(home, ".claude");
}

/** Folder memory Claude Code untuk satu path proyek. */
export function claudeMemoryDir(configRoot: string, projectPath: string): string {
  return join(configRoot, "projects", claudeProjectSlug(projectPath), "memory");
}

/** Path absolut ternormalisasi; sama dengan input bila tak bisa di-resolve. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Frontmatter Claude Code: kunci sederhana di baris atas dan blok
 * `metadata:` dengan kunci anak yang menjorot. Kunci tak dikenal diabaikan.
 */
export function parseFrontmatter(
  text: string,
): { fields: Map<string, string>; body: string } | null {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const lines = normalized.slice(4).split("\n");
  let close = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "---") {
      close = index;
      break;
    }
  }
  if (close === -1) return null;

  const fields = new Map<string, string>();
  let section: string | null = null;
  for (let index = 0; index < close; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (match === null) continue;
    const indent = match[1]!.length;
    const key = match[2]!;
    const value = match[3]!;
    if (indent === 0) {
      if (value.trim() === "") {
        section = key;
      } else {
        section = null;
        fields.set(key, value);
      }
      continue;
    }
    if (section !== null) fields.set(`${section}.${key}`, value);
  }
  return { fields, body: lines.slice(close + 1).join("\n") };
}

function titleFromFile(fileName: string): string {
  return fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
}

function typeFrom(fields: Map<string, string>): ClaudeMemoryType {
  const raw = fields.get("metadata.type") ?? fields.get("type") ?? "";
  const value = unquote(raw).toLowerCase();
  return CLAUDE_MEMORY_TYPES.find((entry) => entry === value) ?? "unknown";
}

/**
 * Ubah isi satu berkas memory Claude Code menjadi item. Frontmatter rusak
 * atau tak ada: judul dari nama berkas dan tipe `unknown`.
 */
export function parseClaudeMemory(
  fileName: string,
  text: string,
  updatedAt: string,
): ClaudeMemoryItem {
  const split = parseFrontmatter(text);
  const fallbackTitle = titleFromFile(fileName);
  if (split === null) {
    return {
      file: fileName,
      title: fallbackTitle,
      description: "",
      type: "unknown",
      body: text.trim(),
      updatedAt,
      truncated: false,
    };
  }
  const name = unquote(split.fields.get("name") ?? "");
  const description = unquote(split.fields.get("description") ?? "");
  // Berkas yang ditulis Jejak memuat `jejak_id` di frontmatter.
  const jejakRaw = unquote(
    split.fields.get("metadata.jejak_id") ?? split.fields.get("jejak_id") ?? "",
  );
  const item: ClaudeMemoryItem = {
    file: fileName,
    title: name === "" ? fallbackTitle : name,
    description,
    type: typeFrom(split.fields),
    body: split.body.trim(),
    updatedAt,
    truncated: false,
  };
  if (jejakRaw !== "") item.jejakId = jejakRaw;
  return item;
}

/** Baca isi berkas dengan batas ukuran; True bila isinya dipotong. */
async function readLimited(
  path: string,
): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(CLAUDE_MEMORY_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > CLAUDE_MEMORY_FILE_MAX_BYTES;
    const text = buffer
      .subarray(0, Math.min(bytesRead, CLAUDE_MEMORY_FILE_MAX_BYTES))
      .toString("utf8");
    return { text, truncated };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function safeReaddir(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * True bila `target` sama dengan `dir` atau berada di bawahnya. Memakai
 * pemisah path platform (`\\` di Windows); `pathApi` bisa diganti untuk tes.
 */
export function isInsideDir(
  dir: string,
  target: string,
  pathApi: Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const rel = pathApi.relative(pathApi.resolve(dir), pathApi.resolve(target));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`)) return false;
  return !pathApi.isAbsolute(rel);
}

const insideDir = isInsideDir;

/**
 * Gabungkan beberapa daftar memory; berkas dengan nama sama digabung satu
 * kali. `dirExists` true bila salah satu folder terbaca.
 */
export function mergeClaudeListings(
  listings: readonly ClaudeMemoryListing[],
): ClaudeMemoryListing {
  const seen = new Set<string>();
  const items: ClaudeMemoryItem[] = [];
  let dirExists = false;
  let index: string | undefined;
  for (const listing of listings) {
    if (listing.dirExists) dirExists = true;
    if (listing.index !== undefined && index === undefined) index = listing.index;
    for (const item of listing.items) {
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      items.push(item);
    }
  }
  items.sort((left, right) => {
    const a = Date.parse(left.updatedAt);
    const b = Date.parse(right.updatedAt);
    if (Number.isNaN(a) || Number.isNaN(b)) return left.file.localeCompare(right.file);
    if (a !== b) return b - a;
    return left.file.localeCompare(right.file);
  });
  const merged: ClaudeMemoryListing = { dirExists, items };
  if (index !== undefined) merged.index = index;
  return merged;
}

/**
 * Daftar memory Claude Code di satu folder. Folder tak ada atau tak terbaca
 * menghasilkan `dirExists: false`, bukan galat. Tidak ada berkas yang ditulis.
 */
export async function listClaudeMemories(dir: string): Promise<ClaudeMemoryListing> {
  const entries = await safeReaddir(dir);
  if (entries === null) return { dirExists: false, items: [] };

  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    // Hanya berkas biasa; symlink dan folder diabaikan.
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === CLAUDE_MEMORY_INDEX_FILE) continue;
    const path = join(dir, entry.name);
    if (!insideDir(dir, path)) continue;
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    candidates.push({ name: entry.name, mtimeMs: info.mtimeMs });
  }

  candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.name.localeCompare(right.name);
  });

  const items: ClaudeMemoryItem[] = [];
  for (const candidate of candidates.slice(0, CLAUDE_MEMORY_MAX_FILES)) {
    const read = await readLimited(join(dir, candidate.name));
    if (read === null) continue;
    const item = parseClaudeMemory(
      candidate.name,
      read.text,
      new Date(candidate.mtimeMs).toISOString(),
    );
    item.truncated = read.truncated;
    items.push(item);
  }

  let index: string | undefined;
  const indexPath = join(dir, CLAUDE_MEMORY_INDEX_FILE);
  if (insideDir(dir, indexPath)) {
    try {
      const info = await stat(indexPath);
      if (info.isFile()) {
        const raw = await readFile(indexPath, "utf8");
        index = raw.slice(0, CLAUDE_MEMORY_FILE_MAX_BYTES);
      }
    } catch {
      index = undefined;
    }
  }

  const listing: ClaudeMemoryListing = { dirExists: true, items };
  if (index !== undefined) listing.index = index;
  return listing;
}

/**
 * Susun daftar proyek Jejak dari data sesi yang sudah ada. Worktree Jejak
 * juga menyimpan repo asalnya supaya folder memory Claude Code di repo
 * asal ikut dibaca.
 */
export function claudeProjectEntries(
  seeds: readonly ClaudeProjectSeed[],
  extraCwds: readonly string[] = [],
): ClaudeProjectEntry[] {
  const entries: ClaudeProjectEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: ClaudeProjectEntry): void => {
    const id = `${entry.key}\u0000${entry.path}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push(entry);
  };

  for (const seed of seeds) {
    const path = canonicalPath(seed.cwd);
    const aliases = path === seed.cwd ? [] : [path];
    const altPaths = path === seed.cwd ? [] : [seed.cwd];
    // Repo asal hanya relevan bila folder kerja memang berada di dalam
    // worktree Jejak.
    const worktree = seed.worktree;
    const isWorktree =
      worktree !== undefined &&
      isInsideDir(worktree.path, seed.cwd);
    const originPath =
      isWorktree && worktree !== undefined ? canonicalPath(worktree.repoRoot) : undefined;
    const originAltPath =
      originPath === undefined || worktree === undefined
        ? undefined
        : originPath === worktree.repoRoot
          ? undefined
          : worktree.repoRoot;
    push({
      key: seed.cwd,
      path,
      ...(altPaths.length === 0 ? {} : { altPaths }),
      ...(aliases.length === 0 ? {} : { aliases }),
      ...(originPath === undefined ? {} : { originPath }),
      ...(originAltPath === undefined ? {} : { originAltPath }),
    });
  }

  for (const cwd of extraCwds) {
    if (cwd.trim() === "") continue;
    const path = canonicalPath(cwd);
    const aliases = path === cwd ? [] : [path];
    const altPaths = path === cwd ? [] : [cwd];
    push({
      key: cwd,
      path,
      ...(altPaths.length === 0 ? {} : { altPaths }),
      ...(aliases.length === 0 ? {} : { aliases }),
    });
  }
  return entries;
}

/**
 * Cari proyek yang kuncinya cocok. Alias (path ternormalisasi) juga
 * diterima; `undefined` bila proyek tak dikenal.
 */
export function resolveClaudeProject(
  entries: readonly ClaudeProjectEntry[],
  key: string,
): ClaudeProjectEntry | undefined {
  const direct = entries.find((entry) => entry.key === key);
  if (direct !== undefined) return direct;
  const alias = entries.find((entry) => entry.aliases?.includes(key) === true);
  if (alias !== undefined) return alias;
  const canonicalKey = canonicalPath(key);
  return entries.find((entry) => canonicalPath(entry.path) === canonicalKey);
}

/** Label folder tanpa membocorkan struktur disk penuh. */
export function claudeProjectLabel(path: string): string {
  const name = basename(path);
  return name === "" ? path : name;
}

/**
 * Repo asal dari sebuah worktree git. Worktree menyimpan berkas `.git` yang
 * menunjuk ke `.git/worktrees/<nama>`; berkas `commondir` di sana menunjuk
 * ke `.git` utama, jadi repo asal bisa diketahui tanpa menulis apa pun.
 */
export async function claudeWorktreeOrigin(
  worktreePath: string,
): Promise<string | undefined> {
  let pointer: string;
  try {
    pointer = (await readFile(join(worktreePath, ".git"), "utf8")).trim();
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  if (match === null) return undefined;
  const gitDir = resolve(worktreePath, match[1]!.trim());

  let commonRaw: string;
  try {
    commonRaw = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
  } catch {
    return undefined;
  }
  if (commonRaw === "") return undefined;
  const mainGitDir = resolve(gitDir, commonRaw);
  if (basename(mainGitDir) !== ".git") return undefined;
  const repoRoot = dirname(mainGitDir);
  try {
    const info = await stat(repoRoot);
    if (!info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return repoRoot;
}
