import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep, win32 } from "node:path";
import {
  parseUnifiedDiff,
  runGit,
  splitRawFileDiff,
  type ChangeStatus,
  type GitOptions,
} from "./changes";
import { FileError, normalizeRelative } from "./path";

export type RejectScope = "hunk" | "file";

export interface RejectInput {
  path: string;
  scope: RejectScope;
  hunkId?: string;
  diffId: string;
}

export interface RevertOptions {
  undoDir: string;
  now?: () => Date;
  git?: GitOptions;
}

export interface RejectResult {
  undoId: string;
  path: string;
  scope: RejectScope;
}

export class RevertError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RevertError";
  }
}

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_SNAPSHOTS = 20;

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DIFF_ARGS = ["-U3", "--relative", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Sama dengan pola nama repo workspace; dipakai untuk subfolder snapshot. */
const SNAPSHOT_REPO_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const UNSUPPORTED = "Jenis perubahan ini belum bisa ditolak lewat Jejak.";
const STALE = "Berkas berubah sejak diff ditampilkan. Muat ulang perubahan.";
const RUNNING = "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.";
const TOO_LARGE = "Berkas terlalu besar untuk ditolak dengan aman.";

interface SnapshotMeta {
  path: string;
  scope: RejectScope;
  createdAt: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  existedBefore: boolean;
}

interface ResolvedTarget {
  root: string;
  abs: string;
  rel: string;
  exists: boolean;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function invalid(message: string): FileError {
  return new FileError(message, "tidak-valid");
}

/**
 * Validasi path untuk operasi tulis. Berkas `D` tidak ada di disk, jadi untuk
 * target yang hilang yang diverifikasi adalah realpath direktori induk terdekat.
 * Symlink pada target sendiri selalu ditolak.
 */
export async function resolveWriteTarget(cwd: string, rel: unknown): Promise<ResolvedTarget> {
  if (typeof rel !== "string" || rel === "") {
    throw invalid("Path tidak valid.");
  }
  if (rel.includes("\0")) {
    throw invalid("Path tidak valid.");
  }
  if (isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw invalid("Path harus relatif terhadap folder kerja.");
  }
  const normalized = normalizeRelative(rel);
  if (normalized === "") {
    throw invalid("Path tidak valid.");
  }
  const segments = normalized.split("/");
  if (segments.includes(".git")) {
    throw invalid("Berkas di dalam .git tidak bisa diubah.");
  }

  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    throw new FileError("Folder kerja tidak ditemukan.", "tidak-ditemukan");
  }

  const abs = resolve(root, normalized);
  if (abs === root || !inside(root, abs)) {
    throw new FileError("path di luar folder kerja", "tidak-valid");
  }

  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      throw invalid("Path symlink tidak bisa diubah.");
    }
    if (info.isDirectory()) {
      throw invalid("Path bukan berkas.");
    }
    return { root, abs, rel: normalized, exists: true };
  } catch (error) {
    if (error instanceof FileError) throw error;
    if (!isNotFound(error)) {
      throw invalid("Path tidak dapat diperiksa.");
    }
  }

  // Target (mis. berkas terhapus) tidak ada: verifikasi induk terdekat yang ada.
  let parent = dirname(abs);
  while (true) {
    try {
      const parentReal = await realpath(parent);
      if (!inside(root, parentReal)) {
        throw new FileError("path di luar folder kerja", "tidak-valid");
      }
      const info = await stat(parentReal);
      if (!info.isDirectory()) {
        throw invalid("Path bukan berkas.");
      }
      break;
    } catch (error) {
      if (error instanceof FileError) throw error;
      if (!isNotFound(error)) {
        throw invalid("Path tidak dapat diperiksa.");
      }
      const next = dirname(parent);
      if (next === parent || !inside(root, next)) {
        throw invalid("Path tidak valid.");
      }
      parent = next;
    }
  }

  return { root, abs, rel: normalized, exists: false };
}

interface CurrentDiff {
  status: ChangeStatus;
  binary: boolean;
  diffId: string;
  hunks: Array<{ id: string; text: string }>;
  header: string;
}

/**
 * Apakah berkas tidak terlacak. `git diff HEAD` tidak pernah memuat berkas
 * tak terlacak, jadi perlu pemeriksaan terpisah untuk membedakannya dari
 * berkas yang berubah sejak diff ditampilkan.
 */
async function isUntracked(cwd: string, rel: string, options: RevertOptions): Promise<boolean> {
  const result = await runGit(
    ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--", rel],
    cwd,
    options.git ?? {},
    64 * 1024,
  );
  if (result.code !== 0 || result.timedOut) return false;
  return result.stdout
    .split("\0")
    .some((entry) => entry.startsWith("?? "));
}

async function readCurrentDiff(
  cwd: string,
  rel: string,
  options: RevertOptions,
): Promise<CurrentDiff> {
  const result = await runGit(
    ["--literal-pathspecs", "diff", "HEAD", ...DIFF_ARGS, "--", rel],
    cwd,
    options.git ?? {},
    MAX_OUTPUT_BYTES,
  );
  if (result.timedOut || result.truncated) {
    throw new RevertError("Perubahan tidak dapat dibaca.", 400);
  }
  if (result.code !== 0) {
    throw new RevertError(UNSUPPORTED, 400);
  }

  const parsed = parseUnifiedDiff(result.stdout);
  const file = parsed.files.find((item) => item.path === rel) ?? parsed.files[0];
  if (file === undefined) {
    if (await isUntracked(cwd, rel, options)) {
      throw new RevertError(UNSUPPORTED, 400);
    }
    throw new RevertError(STALE, 409);
  }
  const raw = splitRawFileDiff(result.stdout);
  if (raw === null) {
    throw new RevertError(STALE, 409);
  }
  return {
    status: file.status,
    binary: file.binary,
    diffId: file.diffId,
    hunks: raw.hunks,
    header: raw.header,
  };
}

function toRevertError(error: unknown): RevertError {
  if (error instanceof RevertError) return error;
  if (error instanceof FileError) {
    return new RevertError(error.message, error.code === "tidak-ditemukan" ? 404 : 400);
  }
  return new RevertError("Permintaan tidak valid.", 400);
}

async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Snapshot cwd memakai `<undoDir>/<sessionId>` (format lama, tetap valid).
 * Repo lain memakai `<undoDir>/<sessionId>/repo-<nama>` sehingga undoId dari
 * satu repo tidak pernah ditemukan saat dipakai pada repo lain.
 */
function sessionDir(options: RevertOptions, sessionId: string, repoName?: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new RevertError("Sesi tidak valid.", 400);
  }
  const root = resolve(options.undoDir, sessionId);
  if (repoName === undefined) return root;
  if (!SNAPSHOT_REPO_RE.test(repoName)) {
    throw new RevertError("Parameter repo tidak valid.", 400);
  }
  return resolve(root, `repo-${repoName}`);
}

async function writeMeta(dir: string, meta: SnapshotMeta): Promise<void> {
  await writeFile(resolve(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

async function readMeta(dir: string): Promise<SnapshotMeta | null> {
  try {
    const contents = await readFile(resolve(dir, "meta.json"), "utf8");
    const parsed = JSON.parse(contents) as Partial<SnapshotMeta>;
    if (
      typeof parsed.path !== "string" ||
      (parsed.scope !== "hunk" && parsed.scope !== "file") ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.existedBefore !== "boolean"
    ) {
      return null;
    }
    return {
      path: parsed.path,
      scope: parsed.scope,
      createdAt: parsed.createdAt,
      beforeSha256: typeof parsed.beforeSha256 === "string" ? parsed.beforeSha256 : null,
      afterSha256: typeof parsed.afterSha256 === "string" ? parsed.afterSha256 : null,
      existedBefore: parsed.existedBefore,
    };
  } catch {
    return null;
  }
}

async function pruneSnapshots(sessionRoot: string): Promise<void> {
  let names;
  try {
    names = await readdir(sessionRoot);
  } catch {
    return;
  }
  const entries: Array<{ name: string; createdAt: string }> = [];
  for (const name of names) {
    if (!UUID_V4_RE.test(name)) continue;
    const meta = await readMeta(resolve(sessionRoot, name));
    if (meta === null) continue;
    entries.push({ name, createdAt: meta.createdAt });
  }
  if (entries.length <= MAX_SNAPSHOTS) return;
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const entry of entries.slice(0, entries.length - MAX_SNAPSHOTS)) {
    await rm(resolve(sessionRoot, entry.name), { recursive: true, force: true });
  }
}

async function applyPatch(cwd: string, patch: string, options: RevertOptions, check: boolean): Promise<boolean> {
  const args = ["apply", "-R", ...(check ? ["--check"] : []), "--whitespace=nowarn"];
  const result = await runGit(args, cwd, options.git ?? {}, 64 * 1024, patch);
  return result.code === 0 && !result.timedOut;
}

async function restoreFile(cwd: string, rel: string, options: RevertOptions): Promise<boolean> {
  const result = await runGit(
    ["--literal-pathspecs", "restore", "--source=HEAD", "--worktree", "--", rel],
    cwd,
    options.git ?? {},
    64 * 1024,
  );
  return result.code === 0 && !result.timedOut;
}

export function parseRejectInput(body: unknown): RejectInput {
  const record = parseObject(body);
  const path = record.path;
  const scope = record.scope;
  const diffId = record.diffId;
  if (typeof path !== "string" || path === "") {
    throw new RevertError("Field path harus berupa teks.", 400);
  }
  if (scope !== "hunk" && scope !== "file") {
    throw new RevertError("Field scope harus 'hunk' atau 'file'.", 400);
  }
  if (typeof diffId !== "string" || !/^[0-9a-f]{64}$/i.test(diffId)) {
    throw new RevertError("Field diffId tidak valid.", 400);
  }
  const input: RejectInput = { path, scope, diffId };
  if (scope === "hunk") {
    if (typeof record.hunkId !== "string" || !/^[0-9a-f]{64}$/i.test(record.hunkId)) {
      throw new RevertError("Field hunkId tidak valid.", 400);
    }
    input.hunkId = record.hunkId;
  }
  return input;
}

export function parseUndoInput(body: unknown): string {
  const record = parseObject(body);
  const undoId = record.undoId;
  if (typeof undoId !== "string" || !UUID_V4_RE.test(undoId)) {
    throw new RevertError("Field undoId tidak valid.", 400);
  }
  return undoId;
}

function parseObject(body: unknown): Record<string, unknown> {
  let parsed: unknown;
  if (typeof body === "string") {
    if (body.trim() === "") {
      throw new RevertError("Body permintaan harus berupa JSON.", 400);
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new RevertError("Body permintaan harus berupa JSON yang valid.", 400);
    }
  } else {
    parsed = body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RevertError("Body permintaan harus berupa objek.", 400);
  }
  return parsed as Record<string, unknown>;
}

export async function rejectChange(
  sessionId: string,
  cwd: string,
  input: RejectInput,
  options: RevertOptions,
  repoName?: string,
): Promise<RejectResult> {
  let target: ResolvedTarget;
  try {
    target = await resolveWriteTarget(cwd, input.path);
  } catch (error) {
    throw toRevertError(error);
  }
  const current = await readCurrentDiff(cwd, target.rel, options);

  if (current.status !== "M" && current.status !== "D") {
    throw new RevertError(UNSUPPORTED, 400);
  }
  if (current.binary) {
    throw new RevertError(UNSUPPORTED, 400);
  }
  if (current.diffId !== input.diffId) {
    throw new RevertError(STALE, 409);
  }
  let patch: string | null = null;
  if (input.scope === "hunk") {
    const hunk = current.hunks.find((item) => item.id === input.hunkId);
    if (hunk === undefined) {
      throw new RevertError(STALE, 409);
    }
    patch = `${current.header}\n${hunk.text}\n`;
  }

  // Baca isi sekarang sebelum menyentuh apa pun.
  const before = target.exists ? await readBytesOrNull(target.abs) : null;
  if (before !== null && before.length > MAX_SNAPSHOT_BYTES) {
    throw new RevertError(TOO_LARGE, 400);
  }

  if (input.scope === "hunk") {
    // --check lebih dulu: bila gagal, tidak ada yang ditulis dan tidak ada snapshot.
    if (!(await applyPatch(cwd, patch!, options, true))) {
      throw new RevertError(STALE, 409);
    }
  }

  const undoId = crypto.randomUUID();
  const sessionRoot = sessionDir(options, sessionId, repoName);
  const snapshotDir = resolve(sessionRoot, undoId);
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  try {
    await chmod(sessionRoot, 0o700);
    await chmod(snapshotDir, 0o700);
  } catch {
    // Sebagian sistem berkas tidak mendukung chmod; berkas tetap 0600.
  }

  const meta: SnapshotMeta = {
    path: target.rel,
    scope: input.scope,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    beforeSha256: before === null ? null : sha256Bytes(before),
    afterSha256: null,
    existedBefore: before !== null,
  };

  let wrote = false;
  try {
    if (before !== null) {
      await writeFile(resolve(snapshotDir, "before.bin"), before, { mode: 0o600 });
    }
    await writeMeta(snapshotDir, meta);

    if (input.scope === "hunk") {
      if (!(await applyPatch(cwd, patch!, options, false))) {
        throw new RevertError(STALE, 409);
      }
    } else {
      if (!(await restoreFile(cwd, target.rel, options))) {
        throw new RevertError("Perubahan tidak dapat ditolak.", 400);
      }
    }
    wrote = true;

    const after = await readBytesOrNull(target.abs);
    meta.afterSha256 = after === null ? null : sha256Bytes(after);
    await writeMeta(snapshotDir, meta);
    await pruneSnapshots(sessionRoot);
  } catch (error) {
    if (!wrote) {
      await rm(snapshotDir, { recursive: true, force: true });
    }
    throw error;
  }

  return { undoId, path: target.rel, scope: input.scope };
}

export async function undoChange(
  sessionId: string,
  cwd: string,
  undoId: string,
  options: RevertOptions,
  repoName?: string,
): Promise<{ path: string }> {
  if (!UUID_V4_RE.test(undoId)) {
    throw new RevertError("Field undoId tidak valid.", 400);
  }
  const sessionRoot = sessionDir(options, sessionId, repoName);
  const snapshotDir = resolve(sessionRoot, undoId);
  const meta = await readMeta(snapshotDir);
  if (meta === null) {
    throw new RevertError("Snapshot tidak ditemukan.", 404);
  }

  let target: ResolvedTarget;
  try {
    target = await resolveWriteTarget(cwd, meta.path);
  } catch (error) {
    throw toRevertError(error);
  }
  const current = target.exists ? await readBytesOrNull(target.abs) : null;
  const currentSha = current === null ? null : sha256Bytes(current);
  if (currentSha !== meta.afterSha256) {
    throw new RevertError("Berkas berubah setelah ditolak; tidak bisa diurungkan otomatis.", 409);
  }

  if (meta.existedBefore) {
    let before: Uint8Array;
    try {
      before = await readFile(resolve(snapshotDir, "before.bin"));
    } catch {
      throw new RevertError("Snapshot tidak ditemukan.", 404);
    }

    let mode = 0o644;
    if (current !== null) {
      try {
        mode = (await stat(target.abs)).mode & 0o777;
      } catch {
        // Berkas menghilang di antara pembacaan; pakai mode bawaan.
      }
    }

    const tempPath = resolve(dirname(target.abs), `.jejak-undo-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, before, { mode });
      await rename(tempPath, target.abs);
    } catch {
      await rm(tempPath, { force: true });
      throw new RevertError("Berkas tidak dapat dipulihkan.", 400);
    }
  } else {
    await rm(target.abs, { force: true });
  }

  await rm(snapshotDir, { recursive: true, force: true });
  return { path: meta.path };
}

export const REVERT_MESSAGES = {
  RUNNING,
  STALE,
  UNSUPPORTED,
  TOO_LARGE,
} as const;