import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { FileError, resolveInside } from "./path";

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content?: string;
  /** sha256 hex dari seluruh byte; hanya diisi bila teks utuh (tidak terpotong/biner). */
  version?: string;
}

export const MAX_FILE_BYTES = 256 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

function hasNullByte(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/**
 * Memangkas byte sisa karakter UTF-8 yang terpotong di ujung buffer.
 */
export function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let index = bytes.length - 1;
  let continuation = 0;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) {
    continuation += 1;
    index -= 1;
  }
  if (index < 0) return bytes;

  const lead = bytes[index]!;
  let needed: number;
  if ((lead & 0x80) === 0) needed = 1;
  else if ((lead & 0xe0) === 0xc0) needed = 2;
  else if ((lead & 0xf0) === 0xe0) needed = 3;
  else if ((lead & 0xf8) === 0xf0) needed = 4;
  else return bytes;

  return continuation + 1 < needed ? bytes.subarray(0, index) : bytes;
}

export async function readTextFile(cwd: string, rel: unknown): Promise<FileContent> {
  const resolved = await resolveInside(cwd, rel);

  let handle;
  try {
    // O_NONBLOCK mencegah open menggantung bila path ternyata FIFO.
    handle = await open(resolved.target, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new FileError("Path tidak ditemukan.", "tidak-ditemukan");
  }

  try {
    let info;
    try {
      info = await handle.stat();
    } catch {
      throw new FileError("Path tidak ditemukan.", "tidak-ditemukan");
    }
    if (!info.isFile()) {
      throw new FileError("Path bukan berkas biasa.", "tidak-valid");
    }

    const buffer = new Uint8Array(MAX_FILE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0);
    const truncated = info.size > bytesRead;
    let bytes: Uint8Array = buffer.subarray(0, bytesRead);
    if (truncated) {
      bytes = trimIncompleteUtf8(bytes);
    }

    if (hasNullByte(bytes)) {
      return { path: resolved.path, size: info.size, binary: true, truncated };
    }

    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      return { path: resolved.path, size: info.size, binary: true, truncated };
    }

    return {
      path: resolved.path,
      size: info.size,
      binary: false,
      truncated,
      content,
      ...(truncated ? {} : { version: createHash("sha256").update(bytes).digest("hex") }),
    };
  } finally {
    await handle.close();
  }
}
