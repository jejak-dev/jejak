import { realpath } from "node:fs/promises";
import { isAbsolute, posix, resolve, sep, win32 } from "node:path";

export type FileErrorCode = "tidak-valid" | "tidak-ditemukan";

export class FileError extends Error {
  constructor(
    message: string,
    public readonly code: FileErrorCode,
  ) {
    super(message);
    this.name = "FileError";
  }
}

export interface ResolvedPath {
  /** Realpath dari cwd (folder kerja). */
  root: string;
  /** Realpath dari target; selalu berada di dalam root. */
  target: string;
  /** Path relatif ternormalisasi untuk ditampilkan ke klien ("/" sebagai pemisah). */
  path: string;
}

const OUTSIDE = "path di luar folder kerja";

/**
 * Menormalkan path relatif dan menolak segmen yang keluar dari folder kerja.
 * Dipakai juga sebelum menyusun path untuk pesan/galat.
 */
export function normalizeRelative(rel: string): string {
  const normalized = posix.normalize(rel.replace(/\\/g, "/"));
  const segments = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (segments.includes("..")) {
    throw new FileError(OUTSIDE, "tidak-valid");
  }
  return segments.join("/");
}

function validate(rel: unknown): string {
  if (typeof rel !== "string") {
    throw new FileError("Path harus berupa teks.", "tidak-valid");
  }
  if (rel.includes("\0")) {
    throw new FileError("Path tidak valid.", "tidak-valid");
  }
  if (isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw new FileError("Path harus relatif terhadap folder kerja.", "tidak-valid");
  }
  return normalizeRelative(rel);
}

/**
 * Menyelesaikan path relatif terhadap cwd dan memastikan hasil realpath-nya
 * tetap berada di dalam folder kerja. Symlink yang menunjuk keluar ditolak.
 */
export async function resolveInside(cwd: string, rel: unknown): Promise<ResolvedPath> {
  const normalized = validate(rel);

  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    throw new FileError("Folder kerja tidak ditemukan.", "tidak-ditemukan");
  }

  const candidate = resolve(root, normalized);

  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new FileError("Path tidak ditemukan.", "tidak-ditemukan");
  }

  if (target !== root && !target.startsWith(root + sep)) {
    throw new FileError(OUTSIDE, "tidak-valid");
  }

  return { root, target, path: normalized };
}
