import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { findSecret } from "./secret-guard";

export type MemoryLayer = "profile" | "project";
export type MemoryStatus = "proposed" | "active" | "rejected" | "archived";
export type MemoryConfidence = "confirmed" | "from_code" | "inferred";
export type MemoryOriginKind = "manual" | "session" | "file" | "interview";

export interface MemoryOrigin {
  kind: MemoryOriginKind;
  sessionId?: string;
  /**
   * Daftar id sesi sumber; dipakai memory gabungan ringkasan sesi proyek.
   */
  sessionIds?: string[];
  file?: string;
  fileSha256?: string;
  commit?: string;
  /** Nama orang yang mengonfirmasi (kind `interview`). */
  by?: string;
  at: string;
}

export interface Memory {
  id: string;
  layer: MemoryLayer;
  projectKey: string | null;
  title: string;
  body: string;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  origin: MemoryOrigin;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  /** Id memory yang direvisi oleh memory ini; `null` untuk memory biasa. */
  replaces: string | null;
}

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_BODY_MAX = 2000;
export const MEMORY_PROJECT_KEY_MAX = 1024;
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;
/** Panjang maksimum slug pada nama berkas dan folder. */
export const MEMORY_SLUG_MAX = 48;
/** Nama berkas index yang tidak boleh dipindai sebagai memory. */
export const MEMORY_INDEX_FILE = "INDEX.md";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMemoryId(value: string): boolean {
  return UUID_V4.test(value);
}

export function hasControlCharacters(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

/**
 * Folder proyek versi lama (hash 16 hex). Masih dipakai saat migrasi layouts.
 */
export function projectFolderKey(projectKey: string): string {
  return createHash("sha256").update(projectKey, "utf8").digest("hex").slice(0, 16);
}

/**
 * Mengubah teks menjadi slug: huruf kecil, hanya huruf/angka ASCII, sisanya
 * menjadi `-`. Berurutan `-` diringkas, tepi tidak boleh `-`, panjang maksimum
 * `maxLength`. Bila hasil kosong, dikembalikan string kosong.
 */
export function slugifyRaw(text: string, maxLength: number = MEMORY_SLUG_MAX): string {
  let slug = "";
  for (const char of text.toLowerCase()) {
    const code = char.codePointAt(0) ?? 0;
    const asciiLetter = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;
    slug += asciiLetter || digit ? char : "-";
  }
  slug = slug.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/, "");
  }
  return slug;
}

/** Slug yang selalu terisi; teks kosong memakai `fallback`. */
export function slugify(
  text: string,
  maxLength: number = MEMORY_SLUG_MAX,
  fallback = "memory",
): string {
  const slug = slugifyRaw(text, maxLength);
  return slug === "" ? fallback : slug;
}

/** Nama berkas memory: `<slug>-<8 hex pertama id>.md`. */
export function memoryFileName(memory: Pick<Memory, "id" | "title">): string {
  return `${slugify(memory.title)}-${memory.id.slice(0, 8)}.md`;
}

/** Segmen terakhir projectKey yang tak kosong, tanpa akhiran `.git`. */
export function projectDisplayName(projectKey: string): string {
  const withoutGit = projectKey.endsWith(".git") ? projectKey.slice(0, -4) : projectKey;
  const segments = withoutGit.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.length === 0 ? "" : segments[segments.length - 1]!;
}

/** Folder proyek versi baru: `<slug-nama-proyek>-<8 hex pertama sha256 projectKey>`. */
export function projectFolderName(projectKey: string): string {
  const slug = slugify(projectDisplayName(projectKey), MEMORY_SLUG_MAX, "proyek");
  const hash = createHash("sha256").update(projectKey, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Path relatif memory. Nama berkas memakai slug judul plus 8 hex pertama id;
 * nama ini ditetapkan sekali saat berkas dibuat dan tidak berubah saat judul diedit.
 */
export function relativeMemoryPath(
  memory: Pick<Memory, "id" | "layer" | "projectKey" | "title">,
): string {
  if (memory.layer === "profile") {
    return posix.join("profile", memoryFileName(memory));
  }
  if (memory.projectKey === null || memory.projectKey === "") {
    throw new Error("Memory proyek membutuhkan projectKey.");
  }
  return posix.join("projects", projectFolderName(memory.projectKey), memoryFileName(memory));
}

export function absoluteMemoryPath(
  dir: string,
  memory: Pick<Memory, "id" | "layer" | "projectKey" | "title">,
): string {
  return join(dir, ...relativeMemoryPath(memory).split("/"));
}

export function serializeMemory(memory: Memory): string {
  const lines = [
    "---",
    `id: ${memory.id}`,
    `layer: ${memory.layer}`,
    `status: ${memory.status}`,
    `confidence: ${memory.confidence}`,
    `title: ${JSON.stringify(memory.title)}`,
    `origin: ${JSON.stringify(memory.origin)}`,
    `created: ${memory.createdAt}`,
    `updated: ${memory.updatedAt}`,
    `decided: ${memory.decidedAt === null ? "null" : memory.decidedAt}`,
  ];
  // Baris `replaces` hanya ditulis bila memory ini merevisi memory lain.
  if (memory.replaces !== null) lines.push(`replaces: ${memory.replaces}`);
  lines.push("---");
  const frontmatter = `${lines.join("\n")}\n`;
  // Judul berbaris baru tidak bisa ditulis sebagai H1 tanpa merusak isi.
  if (memory.title.includes("\n") || memory.title.includes("\r")) {
    return `${frontmatter}${memory.body}\n`;
  }
  return `${frontmatter}# ${memory.title}\n\n${memory.body}\n`;
}

export type ParseMemoryResult =
  | { ok: true; memory: Memory }
  | { ok: false; reason: string };

function failure(reason: string): ParseMemoryResult {
  return { ok: false, reason };
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

function isDateText(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function parseOrigin(raw: string): MemoryOrigin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "manual" && kind !== "session" && kind !== "file" && kind !== "interview") {
    return null;
  }
  const at = record.at;
  if (typeof at !== "string" || !isDateText(at)) {
    return null;
  }
  const origin: MemoryOrigin = { kind, at };
  for (const key of ["sessionId", "file", "fileSha256", "commit", "by"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    origin[key] = value;
  }
  if (kind === "file" && (origin.file === undefined || origin.fileSha256 === undefined)) {
    return null;
  }
  if (kind === "interview" && (origin.by === undefined || origin.by.length > 60)) return null;
  const sessionIds = record.sessionIds;
  if (sessionIds !== undefined) {
    if (!Array.isArray(sessionIds)) return null;
    const ids: string[] = [];
    for (const value of sessionIds) {
      if (typeof value !== "string" || value.trim() === "") return null;
      const id = value.trim();
      if (!ids.includes(id)) ids.push(id);
    }
    origin.sessionIds = ids;
  }
  if (origin.file !== undefined) {
    if (origin.file.includes("\0") || origin.file.length > MEMORY_PROJECT_KEY_MAX) return null;
  }
  if (origin.fileSha256 !== undefined && !/^[0-9a-f]{64}$/.test(origin.fileSha256)) {
    return null;
  }
  return origin;
}

function splitFrontmatter(
  text: string,
): { fields: Map<string, string>; body: string } | null {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const lines = normalized.slice(4).split("\n");
  let close = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close === -1) return null;

  const fields = new Map<string, string>();
  for (let index = 0; index < close; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const match = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (match === null) return null;
    fields.set(match[1]!, match[2]!);
  }
  return { fields, body: lines.slice(close + 1).join("\n") };
}

export interface ParseMemoryContext {
  fileName: string;
  layer: MemoryLayer;
  projectKey: string | null;
}

/**
 * Nama berkas memory sah bila sama dengan `id` (format lama) atau berbentuk
 * `<sesuatu>-<8 hex pertama id>` (format baru). Perbandingan id8 case-insensitive.
 */
export function isValidMemoryFileName(baseName: string, id: string): boolean {
  if (baseName === id) return true;
  const match = /^(.+)-([0-9a-f]{8})$/i.exec(baseName);
  if (match === null) return false;
  return match[2]!.toLowerCase() === id.slice(0, 8).toLowerCase();
}

export function parseMemory(text: string, context: ParseMemoryContext): ParseMemoryResult {
  const split = splitFrontmatter(text);
  if (split === null) {
    return failure("frontmatter tidak ditemukan atau tidak valid");
  }
  const fields = split.fields;

  const idRaw = fields.get("id");
  if (idRaw === undefined) return failure("kunci id tidak ditemukan");
  const id = unquote(idRaw);
  const expectedName = context.fileName.endsWith(".md")
    ? context.fileName.slice(0, -3)
    : context.fileName;
  if (!isMemoryId(id)) return failure("id bukan UUID v4");
  if (!isValidMemoryFileName(expectedName, id)) {
    return failure("nama berkas tidak cocok dengan id memory");
  }

  const layerRaw = fields.get("layer");
  if (layerRaw === undefined) return failure("kunci layer tidak ditemukan");
  const layer = unquote(layerRaw);
  if (layer !== "profile" && layer !== "project") return failure("layer tidak valid");
  if (layer !== context.layer) return failure("layer tidak cocok dengan folder");
  if (layer === "project" && (context.projectKey === null || context.projectKey === "")) {
    return failure("pemetaan proyek tidak ditemukan");
  }

  const statusRaw = fields.get("status");
  if (statusRaw === undefined) return failure("kunci status tidak ditemukan");
  const status = unquote(statusRaw);
  if (
    status !== "proposed" &&
    status !== "active" &&
    status !== "rejected" &&
    status !== "archived"
  ) {
    return failure("status tidak valid");
  }

  const confidenceRaw = fields.get("confidence");
  if (confidenceRaw === undefined) return failure("kunci confidence tidak ditemukan");
  const confidence = unquote(confidenceRaw);
  if (
    confidence !== "confirmed" &&
    confidence !== "from_code" &&
    confidence !== "inferred"
  ) {
    return failure("confidence tidak valid");
  }

  const titleRaw = fields.get("title");
  if (titleRaw === undefined) return failure("kunci title tidak ditemukan");
  const title = unquote(titleRaw).trim();

  const originRaw = fields.get("origin");
  if (originRaw === undefined) return failure("kunci origin tidak ditemukan");
  const origin = parseOrigin(originRaw);
  if (origin === null) return failure("origin tidak valid");

  const createdRaw = fields.get("created");
  if (createdRaw === undefined) return failure("kunci created tidak ditemukan");
  const createdAt = unquote(createdRaw);
  if (!isDateText(createdAt)) return failure("created tidak valid");

  const updatedRaw = fields.get("updated");
  if (updatedRaw === undefined) return failure("kunci updated tidak ditemukan");
  const updatedAt = unquote(updatedRaw);
  if (!isDateText(updatedAt)) return failure("updated tidak valid");

  const decidedRaw = fields.get("decided");
  let decidedAt: string | null = null;
  if (decidedRaw !== undefined) {
    const value = unquote(decidedRaw);
    if (value !== "" && value !== "null") {
      if (!isDateText(value)) return failure("decided tidak valid");
      decidedAt = value;
    }
  }

  // `replaces` opsional: berkas lama tidak punya baris ini.
  const replacesRaw = fields.get("replaces");
  let replaces: string | null = null;
  if (replacesRaw !== undefined) {
    const value = unquote(replacesRaw);
    if (value !== "" && value !== "null") {
      if (!isMemoryId(value)) return failure("replaces tidak valid");
      replaces = value;
    }
  }

  // Isi berkas baru diawali H1 judul; awalan itu dibuang agar isi kembali
  // seperti aslinya. Berkas lama tanpa H1 tetap terbaca apa adanya.
  let body = split.body;
  const heading = `# ${title}\n\n`;
  if (body.startsWith(heading)) {
    body = body.slice(heading.length);
  }
  body = body.trim();
  if (title === "" || title.length > MEMORY_TITLE_MAX) {
    return failure(`judul harus 1-${MEMORY_TITLE_MAX} karakter`);
  }
  if (body === "" || body.length > MEMORY_BODY_MAX) {
    return failure(`isi harus 1-${MEMORY_BODY_MAX} karakter`);
  }
  if (hasControlCharacters(title) || hasControlCharacters(body)) {
    return failure("memuat karakter kontrol yang tidak diizinkan");
  }

  const secret = findSecret(title) ?? findSecret(body);
  if (secret !== null) {
    return failure(`berkas memuat rahasia (${secret})`);
  }

  return {
    ok: true,
    memory: {
      id,
      layer,
      projectKey: layer === "profile" ? null : context.projectKey,
      title,
      body,
      status,
      confidence,
      origin,
      staleReason: null,
      createdAt,
      updatedAt,
      decidedAt,
      replaces,
    },
  };
}

export interface ScannedMemoryFile {
  relPath: string;
  absPath: string;
  layer: MemoryLayer;
  projectKey: string | null;
  projectError?: string;
}

export async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export interface ProjectMapping {
  projectKey: string | null;
  error?: string;
}

export async function readProjectMapping(folder: string): Promise<ProjectMapping> {
  let contents: string;
  try {
    contents = await readFile(join(folder, "_project.json"), "utf8");
  } catch {
    return { projectKey: null, error: "pemetaan proyek tidak ditemukan" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { projectKey: null, error: "pemetaan proyek tidak valid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { projectKey: null, error: "pemetaan proyek tidak valid" };
  }
  const projectKey = (parsed as { projectKey?: unknown }).projectKey;
  if (typeof projectKey !== "string" || projectKey.trim() === "") {
    return { projectKey: null, error: "pemetaan proyek tidak valid" };
  }
  return { projectKey };
}

/**
 * Memindai `<dir>/profile/*.md` dan `<dir>/projects/*\/*.md` tanpa menulis apa pun.
 */
export async function scanMemoryFiles(dir: string): Promise<ScannedMemoryFile[]> {
  const files: ScannedMemoryFile[] = [];

  const profileDir = join(dir, "profile");
  for (const entry of await safeReaddir(profileDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === MEMORY_INDEX_FILE) continue;
    files.push({
      relPath: posix.join("profile", entry.name),
      absPath: join(profileDir, entry.name),
      layer: "profile",
      projectKey: null,
    });
  }

  const projectsDir = join(dir, "projects");
  for (const entry of await safeReaddir(projectsDir)) {
    if (!entry.isDirectory()) continue;
    const folder = join(projectsDir, entry.name);
    const mapping = await readProjectMapping(folder);
    for (const file of await safeReaddir(folder)) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      if (file.name === MEMORY_INDEX_FILE) continue;
      const scanned: ScannedMemoryFile = {
        relPath: posix.join("projects", entry.name, file.name),
        absPath: join(folder, file.name),
        layer: "project",
        projectKey: mapping.projectKey,
      };
      if (mapping.error !== undefined) scanned.projectError = mapping.error;
      files.push(scanned);
    }
  }

  files.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return files;
}

export type ReadMemoryFileResult =
  | { ok: true; memory: Memory; sha256: string }
  | { ok: false; reason: string };

function safeRelativeParts(relPath: string): string[] | null {
  if (relPath.includes("\0") || relPath.startsWith("/")) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts;
}

export async function readMemoryFile(
  dir: string,
  relPath: string,
  layer: MemoryLayer,
  projectKey: string | null,
): Promise<ReadMemoryFileResult> {
  const parts = safeRelativeParts(relPath);
  if (parts === null) return { ok: false, reason: "path berkas tidak valid" };

  const target = join(dir, ...parts);
  let info;
  try {
    info = await stat(target);
  } catch {
    return { ok: false, reason: "berkas tidak ditemukan" };
  }
  if (!info.isFile()) return { ok: false, reason: "bukan berkas biasa" };
  if (info.size > MEMORY_FILE_MAX_BYTES) return { ok: false, reason: "berkas terlalu besar" };

  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return { ok: false, reason: "berkas tidak dapat dibaca" };
  }

  const parsed = parseMemory(bytes.toString("utf8"), {
    fileName: basename(target),
    layer,
    projectKey,
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    memory: parsed.memory,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
  }
}

export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Berkas sementara mungkin sudah tidak ada; error asli yang dilempar.
    }
    throw error;
  }
}

async function ensureProjectMapping(folder: string, projectKey: string): Promise<void> {
  const mappingPath = join(folder, "_project.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(mappingPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { projectKey?: unknown }).projectKey === projectKey
    ) {
      return;
    }
  } catch {
    // Berkas belum ada atau rusak; tulis ulang di bawah.
  }
  await writeFileAtomic(mappingPath, `${JSON.stringify({ projectKey })}\n`);
}

export interface WrittenMemoryFile {
  relPath: string;
  absPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

/**
 * Menulis berkas memory. Bila `existingRelPath` diberikan, path itu dipakai
 * apa adanya supaya nama berkas tidak berubah ketika judul diedit.
 */
export async function writeMemoryFile(
  dir: string,
  memory: Memory,
  existingRelPath?: string,
): Promise<WrittenMemoryFile> {
  if (!isMemoryId(memory.id)) {
    throw new Error("Id memory harus UUID v4.");
  }
  const relPath = existingRelPath ?? relativeMemoryPath(memory);
  const parts = safeRelativeParts(relPath);
  if (parts === null) {
    throw new Error("Path memory tidak valid.");
  }
  const absPath = join(dir, ...parts);
  const folder = dirname(absPath);

  await ensureDirectory(dir);
  await ensureDirectory(folder);
  if (memory.layer === "project" && memory.projectKey !== null) {
    await ensureProjectMapping(folder, memory.projectKey);
  }

  const content = serializeMemory(memory);
  await writeFileAtomic(absPath, content);

  const info = await stat(absPath);
  return {
    relPath,
    absPath,
    sha256: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** Menghapus berkas memory pada path relatif yang tercatat. */
export async function deleteMemoryFile(dir: string, relPath: string): Promise<void> {
  const parts = safeRelativeParts(relPath);
  if (parts === null) return;
  try {
    await unlink(join(dir, ...parts));
  } catch {
    // Berkas sudah tidak ada; tidak ada yang perlu dihapus.
  }
}
