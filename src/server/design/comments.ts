import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SLUG_RE, resolveDesignDir } from "./manifest";

/** Satu komentar yang ditempel pada elemen halaman desain. */
export interface DesignComment {
  id: string;
  slug: string;
  selector: string;
  text: string;
  status: "open" | "done";
  createdAt: number;
}

/** Galat komentar desain dengan status HTTP yang sesuai. */
export class DesignCommentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "DesignCommentError";
  }
}

const MAX_COMMENTS = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SELECTOR_LENGTH = 500;
const MAX_TEXT_LENGTH = 1000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ID_RE = /^c_[0-9a-f]{10}$/;
const ADD_FIELDS = new Set(["slug", "selector", "text"]);
const UPDATE_FIELDS = new Set(["status", "text"]);

const NOT_CREATED = "Desain belum dibuat.";
const INVALID_FILE = "Berkas komentar tidak valid.";
const CORRUPT = "Berkas komentar rusak.";
const TOO_LARGE = "Berkas komentar melebihi 256 KB.";
const PAGE_NOT_FOUND = "Halaman tidak ditemukan.";
const COMMENT_NOT_FOUND = "Komentar tidak ditemukan.";
const LIMIT_REACHED = "Batas 200 komentar tercapai.";
const INVALID_BODY = "Body permintaan harus berupa objek.";
const UNKNOWN_FIELD = "Field tidak dikenal.";
const INVALID_SELECTOR = "Selector tidak valid.";
const INVALID_TEXT = "Teks komentar tidak valid.";
const INVALID_STATUS = "Status komentar tidak valid.";
const SAVE_FAILED = "Komentar tidak dapat disimpan.";

interface CommentsFile {
  comments: DesignComment[];
  mtime: number;
  mode: number;
}

interface AddInput {
  slug: string;
  selector: string;
  text: string;
}

interface UpdateInput {
  status?: "open" | "done";
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is "open" | "done" {
  return value === "open" || value === "done";
}

/** Menyaring satu entri yang dibaca dari disk; `undefined` bila bentuknya salah. */
function parseComment(value: unknown): DesignComment | undefined {
  if (!isRecord(value)) return undefined;
  const { id, slug, selector, text, status, createdAt } = value;
  if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return undefined;
  if (typeof selector !== "string" || selector.trim() === "") return undefined;
  if (typeof text !== "string") return undefined;
  if (!isStatus(status)) return undefined;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  return { id, slug, selector, text, status, createdAt };
}

function validateText(value: unknown): string {
  if (typeof value !== "string") throw new DesignCommentError(INVALID_TEXT, 400);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TEXT_LENGTH) {
    throw new DesignCommentError(INVALID_TEXT, 400);
  }
  return trimmed;
}

function validateSelector(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_SELECTOR_LENGTH ||
    CONTROL_RE.test(value)
  ) {
    throw new DesignCommentError(INVALID_SELECTOR, 400);
  }
  return value;
}

/** Memvalidasi body `POST comments`; kunci tak dikenal ditolak. */
function validateAddInput(input: unknown): AddInput {
  if (!isRecord(input)) throw new DesignCommentError(INVALID_BODY, 400);
  for (const key of Object.keys(input)) {
    if (!ADD_FIELDS.has(key)) throw new DesignCommentError(UNKNOWN_FIELD, 400);
  }
  const { slug } = input;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new DesignCommentError("Slug halaman tidak valid.", 400);
  }
  return { slug, selector: validateSelector(input.selector), text: validateText(input.text) };
}

/** Memvalidasi body `PATCH comments/:id`; minimal satu field harus ada. */
function validateUpdateInput(input: unknown): UpdateInput {
  if (!isRecord(input)) throw new DesignCommentError(INVALID_BODY, 400);
  for (const key of Object.keys(input)) {
    if (!UPDATE_FIELDS.has(key)) throw new DesignCommentError(UNKNOWN_FIELD, 400);
  }
  const result: UpdateInput = {};
  if (input.status !== undefined) {
    if (!isStatus(input.status)) throw new DesignCommentError(INVALID_STATUS, 400);
    result.status = input.status;
  }
  if (input.text !== undefined) result.text = validateText(input.text);
  if (result.status === undefined && result.text === undefined) {
    throw new DesignCommentError("Tidak ada field yang diubah.", 400);
  }
  return result;
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new DesignCommentError(COMMENT_NOT_FOUND, 404);
  }
}

/**
 * Membaca `design/comments.json`. Folder desain tak ada atau berkas tak ada
 * dianggap kosong; berkas bukan berkas biasa, terlalu besar, atau rusak
 * dilempar sebagai galat. Entri yang bentuknya salah disaring diam-diam.
 */
async function readCommentsFile(designDir: string): Promise<CommentsFile> {
  const path = join(designDir, "comments.json");
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { comments: [], mtime: 0, mode: 0o644 };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DesignCommentError(INVALID_FILE, 400);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new DesignCommentError(TOO_LARGE, 413);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DesignCommentError(INVALID_FILE, 400);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DesignCommentError(CORRUPT, 409);
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.comments)) {
    throw new DesignCommentError(CORRUPT, 409);
  }
  const comments: DesignComment[] = [];
  for (const entry of raw.comments) {
    const comment = parseComment(entry);
    if (comment !== undefined) comments.push(comment);
  }
  return { comments, mtime: Math.round(info.mtimeMs), mode: info.mode & 0o777 };
}

/**
 * Menulis `design/comments.json` secara atomik lewat berkas sementara di
 * folder yang sama. Mode berkas lama dipertahankan.
 */
async function writeComments(
  designDir: string,
  comments: DesignComment[],
  mode: number,
): Promise<void> {
  const text = `${JSON.stringify({ version: 1, comments }, null, 2)}\n`;
  const tempPath = join(designDir, `.jejak-comments-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, { mode });
    // mode pada writeFile tunduk pada umask; chmod memastikan mode lama utuh.
    await chmod(tempPath, mode);
    await rename(tempPath, join(designDir, "comments.json"));
  } catch {
    await rm(tempPath, { force: true });
    throw new DesignCommentError(SAVE_FAILED, 400);
  }
}

async function resolveDirOrThrow(root: string): Promise<string> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) throw new DesignCommentError(NOT_CREATED, 404);
  return designDir;
}

/** Halaman harus ada sebagai berkas biasa (bukan symlink). */
async function ensurePageExists(designDir: string, slug: string): Promise<void> {
  let info;
  try {
    info = await lstat(join(designDir, "pages", `${slug}.html`));
  } catch {
    throw new DesignCommentError(PAGE_NOT_FOUND, 404);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DesignCommentError(PAGE_NOT_FOUND, 404);
  }
}

// Antrean promise per path: baca-ubah-tulis yang bersamaan tidak saling menimpa.
const locks = new Map<string, Promise<void>>();

function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(path, settled);
  void settled.then(() => {
    if (locks.get(path) === settled) locks.delete(path);
  });
  return run;
}

/** Daftar komentar beserta mtime berkasnya; kosong bila belum ada. */
export async function listComments(
  root: string,
): Promise<{ comments: DesignComment[]; mtime: number }> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) return { comments: [], mtime: 0 };
  const file = await readCommentsFile(designDir);
  return { comments: file.comments, mtime: file.mtime };
}

/** Menambahkan satu komentar baru di akhir daftar. */
export async function addComment(root: string, input: unknown): Promise<DesignComment> {
  const entry = validateAddInput(input);
  const designDir = await resolveDirOrThrow(root);
  await ensurePageExists(designDir, entry.slug);
  return withLock(join(designDir, "comments.json"), async () => {
    const file = await readCommentsFile(designDir);
    if (file.comments.length >= MAX_COMMENTS) {
      throw new DesignCommentError(LIMIT_REACHED, 409);
    }
    const comment: DesignComment = {
      id: `c_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      slug: entry.slug,
      selector: entry.selector,
      text: entry.text,
      status: "open",
      createdAt: Date.now(),
    };
    await writeComments(designDir, [...file.comments, comment], file.mode);
    return comment;
  });
}

/** Memperbarui status dan/atau teks satu komentar. */
export async function updateComment(
  root: string,
  id: string,
  input: unknown,
): Promise<DesignComment> {
  validateId(id);
  const patch = validateUpdateInput(input);
  const designDir = await resolveDirOrThrow(root);
  return withLock(join(designDir, "comments.json"), async () => {
    const file = await readCommentsFile(designDir);
    const index = file.comments.findIndex((comment) => comment.id === id);
    if (index === -1) throw new DesignCommentError(COMMENT_NOT_FOUND, 404);
    const current = file.comments[index]!;
    const updated: DesignComment = {
      ...current,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.text === undefined ? {} : { text: patch.text }),
    };
    const comments = file.comments.slice();
    comments[index] = updated;
    await writeComments(designDir, comments, file.mode);
    return updated;
  });
}

/** Menghapus satu komentar. */
export async function deleteComment(root: string, id: string): Promise<void> {
  validateId(id);
  const designDir = await resolveDirOrThrow(root);
  await withLock(join(designDir, "comments.json"), async () => {
    const file = await readCommentsFile(designDir);
    const index = file.comments.findIndex((comment) => comment.id === id);
    if (index === -1) throw new DesignCommentError(COMMENT_NOT_FOUND, 404);
    const comments = file.comments.slice();
    comments.splice(index, 1);
    await writeComments(designDir, comments, file.mode);
  });
}
