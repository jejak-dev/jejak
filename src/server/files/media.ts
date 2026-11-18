import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { FileError, resolveInside } from "./path";

/** Batas ukuran berkas media yang dilayani. */
export const MAX_MEDIA_BYTES = 300 * 1024 * 1024;

const NOT_MEDIA = "Jenis berkas bukan media yang didukung.";
const NOT_FILE = "Path bukan berkas biasa.";
const TOO_LARGE = "Ukuran media melebihi batas.";

// SVG sengaja tidak ada di daftar: bisa memuat skrip.
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export interface MediaResult {
  status: number;
  headers: Record<string, string>;
  body: Blob;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Membaca satu range byte dari header `Range`. Null berarti range tidak sah
 * (416). Hanya satu range yang didukung.
 */
function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (match === null) return null;
  const spec = match[1]!.trim();
  if (spec === "" || spec.includes(",")) return null;
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  // bytes=-n: n byte terakhir.
  if (rawStart === "") {
    if (!/^\d+$/.test(rawEnd)) return null;
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  if (!/^\d+$/.test(rawStart)) return null;
  const start = Number(rawStart);
  let end: number;
  if (rawEnd === "") {
    end = size - 1;
  } else if (/^\d+$/.test(rawEnd)) {
    end = Number(rawEnd);
  } else {
    return null;
  }
  if (start >= size || start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Menyiapkan berkas media di dalam folder kerja untuk dikirim ke klien.
 * Hanya ekstensi media yang diizinkan; `Range` didukung agar video bisa
 * di-seek.
 */
export async function openMedia(
  root: string,
  rel: unknown,
  rangeHeader?: string | null,
): Promise<MediaResult> {
  const resolved = await resolveInside(root, rel);
  const type = MEDIA_TYPES[extname(resolved.target).toLowerCase()];
  if (type === undefined) {
    throw new FileError(NOT_MEDIA, "tidak-valid");
  }

  let info;
  try {
    info = await stat(resolved.target);
  } catch {
    throw new FileError("Path tidak ditemukan.", "tidak-ditemukan");
  }
  if (!info.isFile()) {
    throw new FileError(NOT_FILE, "tidak-valid");
  }
  if (info.size > MAX_MEDIA_BYTES) {
    throw new FileError(TOO_LARGE, "tidak-valid");
  }

  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=60",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
  };

  if (rangeHeader === undefined || rangeHeader === null || rangeHeader.trim() === "") {
    headers["content-length"] = String(info.size);
    return { status: 200, headers, body: Bun.file(resolved.target) };
  }

  const range = parseRange(rangeHeader, info.size);
  if (range === null) {
    headers["content-range"] = `bytes */${info.size}`;
    headers["content-length"] = "0";
    return { status: 416, headers, body: new Blob([]) };
  }

  headers["content-range"] = `bytes ${range.start}-${range.end}/${info.size}`;
  headers["content-length"] = String(range.end - range.start + 1);
  return {
    status: 206,
    headers,
    body: Bun.file(resolved.target).slice(range.start, range.end + 1),
  };
}
