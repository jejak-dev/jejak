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
}

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_BODY_MAX = 2000;
export const MEMORY_PROJECT_KEY_MAX = 1024;
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMemoryId(value: string): boolean {
  return UUID_V4.test(value);
}

export function hasControlCharacters(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

export function projectFolderKey(projectKey: string): string {
  return createHash("sha256").update(projectKey, "utf8").digest("hex").slice(0, 16);
}

export function relativeMemoryPath(
  memory: Pick<Memory, "id" | "layer" | "projectKey">,
): string {
  if (memory.layer === "profile") {
    return posix.join("profile", `${memory.id}.md`);
  }
  if (memory.projectKey === null || memory.projectKey === "") {
    throw new Error("Memory proyek membutuhkan projectKey.");
  }
  return posix.join("projects", projectFolderKey(memory.projectKey), `${memory.id}.md`);
}

export function absoluteMemoryPath(
  dir: string,
  memory: Pick<Memory, "id" | "layer" | "projectKey">,
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
    "---",
  ];
  return `${lines.join("\n")}\n${memory.body}\n`;
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
  if (id !== expectedName) return failure("id tidak cocok dengan nama berkas");

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

  const body = split.body.trim();
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

async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

interface ProjectMapping {
  projectKey: string | null;
  error?: string;
}

async function readProjectMapping(folder: string): Promise<ProjectMapping> {
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

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
  }
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
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

export async function writeMemoryFile(dir: string, memory: Memory): Promise<WrittenMemoryFile> {
  if (!isMemoryId(memory.id)) {
    throw new Error("Id memory harus UUID v4.");
  }
  const relPath = relativeMemoryPath(memory);
  const absPath = join(dir, ...relPath.split("/"));
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

export async function deleteMemoryFile(dir: string, memory: Memory): Promise<void> {
  try {
    await unlink(absoluteMemoryPath(dir, memory));
  } catch {
    // Berkas sudah tidak ada; tidak ada yang perlu dihapus.
  }
}
