import { constants } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { FileError, resolveInside } from "./path";
import { MAX_FILE_BYTES } from "./read";

export type WriteErrorStatus = 400 | 404 | 409 | 413;

export class WriteError extends Error {
  constructor(
    message: string,
    public readonly status: WriteErrorStatus,
  ) {
    super(message);
    this.name = "WriteError";
  }
}

export interface SaveTextInput {
  path: unknown;
  content: unknown;
  /** Wajib ada saat rute dipakai; tanpa nilai ditolak 400. */
  baseVersion?: unknown;
}

export interface SaveTextResult {
  path: string;
  version: string;
  size: number;
}

const TOO_LARGE = "Berkas terlalu besar untuk disunting.";
const STALE = "Berkas berubah di disk. Muat ulang sebelum menyimpan.";
const BINARY = "Berkas biner tidak bisa disunting.";
const BINARY_PROBE_BYTES = 8 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/i;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasNullByte(bytes: Uint8Array, limit = bytes.length): boolean {
  const max = Math.min(bytes.length, limit);
  for (let index = 0; index < max; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

interface CurrentFile {
  bytes: Uint8Array;
  mode: number;
}

async function readCurrent(target: string): Promise<CurrentFile> {
  let handle;
  try {
    // O_NONBLOCK mencegah open menggantung bila path ternyata FIFO.
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new WriteError("Path tidak ditemukan.", 404);
  }

  try {
    let info;
    try {
      info = await handle.stat();
    } catch {
      throw new WriteError("Path tidak ditemukan.", 404);
    }
    if (!info.isFile()) {
      throw new WriteError("Path bukan berkas biasa.", 400);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new WriteError(TOO_LARGE, 400);
    }
    const buffer = new Uint8Array(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    if (hasNullByte(bytes, BINARY_PROBE_BYTES)) {
      throw new WriteError(BINARY, 400);
    }
    try {
      decoder.decode(bytes);
    } catch {
      throw new WriteError(BINARY, 400);
    }
    return { bytes, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function validateContent(content: unknown): Uint8Array {
  if (typeof content !== "string") {
    throw new WriteError("Field content harus berupa teks.", 400);
  }
  if (content.includes("\0")) {
    throw new WriteError("Isi berkas tidak valid.", 400);
  }
  const bytes = encoder.encode(content);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new WriteError(TOO_LARGE, 413);
  }
  return bytes;
}

function validateBaseVersion(baseVersion: unknown): string {
  if (typeof baseVersion !== "string" || !SHA256_RE.test(baseVersion)) {
    throw new WriteError("Field baseVersion tidak valid.", 400);
  }
  return baseVersion.toLowerCase();
}

function toWriteError(error: unknown): WriteError {
  if (error instanceof WriteError) return error;
  if (error instanceof FileError) {
    return new WriteError(error.message, error.code === "tidak-ditemukan" ? 404 : 400);
  }
  return new WriteError("Permintaan tidak valid.", 400);
}

/**
 * Menyimpan isi berkas teks yang sudah ada (tidak membuat berkas baru).
 *
 * Konkurensi optimistik memakai `baseVersion` (sha256 isi di disk saat ini),
 * penulisan atomik lewat berkas sementara + rename di folder yang sama, dan
 * mode berkas asli dipertahankan. Checkpoint/undo tidak disentuh: git menjadi
 * jaring pengaman untuk perubahan ini.
 */
export async function saveTextFile(
  root: string,
  input: SaveTextInput,
): Promise<SaveTextResult> {
  try {
    const resolved = await resolveInside(root, input.path);

    let info;
    try {
      info = await lstat(resolved.target);
    } catch {
      throw new WriteError("Path tidak ditemukan.", 404);
    }
    if (!info.isFile()) {
      throw new WriteError("Path bukan berkas biasa.", 400);
    }

    const contentBytes = validateContent(input.content);
    const baseVersion = validateBaseVersion(input.baseVersion);
    const current = await readCurrent(resolved.target);
    if (sha256Bytes(current.bytes) !== baseVersion) {
      throw new WriteError(STALE, 409);
    }

    const version = sha256Bytes(contentBytes);
    const tempPath = resolve(dirname(resolved.target), `.jejak-save-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, contentBytes, { mode: current.mode });
      await rename(tempPath, resolved.target);
    } catch {
      await rm(tempPath, { force: true });
      throw new WriteError("Berkas tidak dapat disimpan.", 400);
    }

    return { path: resolved.path, version, size: contentBytes.length };
  } catch (error) {
    throw toWriteError(error);
  }
}
