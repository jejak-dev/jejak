import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Parser dan ekstraktor tar untuk tarball SDK yang diunduh pengguna.
 *
 * Semua entri dari luar tidak dipercaya: penolakan didahulukan, validasi
 * seluruh arsip selesai sebelum satu byte ditulis, dan penulisan memakai
 * flag eksklusif (`wx`) supaya berkas yang sudah ada tidak pernah ditimpa.
 */

export type TarEntryType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  /** Nama entri seperti tersimpan di arsip (bukan setelah awalan dilepas). */
  path: string;
  type: TarEntryType;
  /** Ukuran isi untuk berkas; 0 untuk entri lain. */
  size: number;
  /** Mode dari header arsip (informasi saja; mode tulis ditentukan kode). */
  mode: number;
  /** Isi berkas; hanya untuk entri bertipe `file`. */
  data?: Uint8Array;
}

export interface TarballLimits {
  /** Maks jumlah entri dalam arsip. */
  maxEntries: number;
  /** Maks total ukuran tidak dimampatkan (byte). */
  maxTotalBytes: number;
  /** Maks ukuran satu berkas (byte). */
  maxFileBytes: number;
  /** Maks ukuran masukan terkompresi (byte). */
  maxCompressedBytes: number;
  /** Maks ukuran hasil dekompresi (byte). */
  maxUncompressedBytes: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxEntries: 2000,
  maxTotalBytes: 60 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 60 * 1024 * 1024,
};

export type TarballErrorCode =
  | "symlink"
  | "hardlink"
  | "bad-type"
  | "path-traversal"
  | "absolute-path"
  | "bad-name"
  | "outside-prefix"
  | "too-many-entries"
  | "too-large"
  | "file-too-large"
  | "missing-package-json"
  | "bad-package-json"
  | "name-mismatch"
  | "version-mismatch"
  | "missing-sdk"
  | "truncated"
  | "bad-checksum"
  | "bad-header"
  | "integrity"
  | "gzip"
  | "duplicate";

/** Galat yang stabil pada kode, supaya pemanggil bisa memetakan status HTTP. */
export class TarballError extends Error {
  constructor(
    message: string,
    public readonly code: TarballErrorCode,
  ) {
    super(message);
    this.name = "TarballError";
  }
}

const BLOCK_SIZE = 512;
const PREFIX = "package";

function resolveLimits(limits?: Partial<TarballLimits>): TarballLimits {
  return { ...DEFAULT_TARBALL_LIMITS, ...(limits ?? {}) };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------- integritas */

/**
 * Verifikasi SRI (sha512) terhadap isi tarball.
 *
 * Menerima satu atau beberapa token SRI yang dipisah spasi; hanya algoritma
 * sha512 yang dianggap. Token dengan algoritma lain diabaikan, bukan gagal
 * langsung, selama ada token sha512 yang cocok.
 */
export function verifyIntegrity(bytes: Uint8Array, sri: string): boolean {
  if (typeof sri !== "string") return false;
  const tokens = sri.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return false;

  let sawSha512 = false;
  let matched = false;
  for (const token of tokens) {
    const dash = token.indexOf("-");
    if (dash <= 0) continue;
    const algorithm = token.slice(0, dash).toLowerCase();
    if (algorithm !== "sha512") continue;
    sawSha512 = true;
    if (matchesSha512(bytes, token.slice(dash + 1))) matched = true;
  }
  return sawSha512 && matched;
}

function matchesSha512(bytes: Uint8Array, digest: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(digest)) return false;
  const normalized = digest.replace(/-/g, "+").replace(/_/g, "/");
  let expected: Buffer;
  try {
    expected = Buffer.from(normalized, "base64");
  } catch {
    return false;
  }
  // Panjang sha512 selalu 64 byte; perbandingan dilakukan atas panjang tetap.
  if (expected.length !== 64) return false;
  const actual = createHash("sha512").update(bytes).digest();
  return timingSafeEqual(actual, expected);
}

/** Menghitung SRI sha512 dari isi tarball (dipakai saat menguji dan memasang). */
export function computeIntegrity(bytes: Uint8Array): string {
  const digest = createHash("sha512").update(bytes).digest();
  return `sha512-${digest.toString("base64")}`;
}

/* ------------------------------------------------------------------- parser */

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function checksumOf(block: Uint8Array): { unsigned: number; signed: number } {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte < 128 ? byte : byte - 256;
  }
  return { unsigned, signed };
}

function parseOctalField(field: Uint8Array, label: string): number {
  if (field.length > 0 && ((field[0] ?? 0) & 0x80) !== 0) {
    // Bentuk base-256 GNU untuk nilai besar.
    let value = (field[0] ?? 0) & 0x7f;
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + (field[index] ?? 0);
    }
    return value;
  }
  let text = "";
  for (const byte of field) {
    if (byte === 0 || byte === 32) break;
    text += String.fromCharCode(byte);
  }
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new TarballError(`Header tar tidak valid: field ${label}.`, "bad-header");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TarballError(`Header tar tidak valid: field ${label}.`, "bad-header");
  }
  return value;
}

function readString(block: Uint8Array, start: number, length: number): string {
  const decoder = new TextDecoder("utf-8");
  const limit = Math.min(start + length, block.length);
  let end = start;
  while (end < limit && block[end] !== 0) end += 1;
  return decoder.decode(block.subarray(start, end));
}

function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const text = new TextDecoder("utf-8").decode(data);
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const lengthText = text.slice(offset, space);
    if (!/^[0-9]+$/.test(lengthText)) break;
    const length = Number.parseInt(lengthText, 10);
    if (length <= 0 || offset + length > text.length) break;
    const record = text.slice(space + 1, offset + length);
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      let value = record.slice(equals + 1);
      if (value.endsWith("\n")) value = value.slice(0, -1);
      result[key] = value;
    }
    offset += length;
  }
  return result;
}

function typeOf(flag: string): TarEntryType {
  if (flag === "0" || flag === "\0" || flag === "7") return "file";
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  return "other";
}

/**
 * Mengurai arsip tar (ustar/pax) menjadi daftar entri.
 *
 * Murni: tidak menyentuh berkas. Header pax `x`/`g` dipakai hanya untuk
 * membaca `path` dan `size` yang panjang; hasilnya tetap divalidasi sama
 * seperti entri biasa. Arsip terpotong atau checksum header rusak dilempar
 * sebagai `TarballError`.
 */
export function parseTarEntries(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder("utf-8");
  let offset = 0;
  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | undefined;
  let longName: string | undefined;
  let terminated = false;

  while (offset < tar.length) {
    if (tar.length - offset < BLOCK_SIZE) {
      throw new TarballError("Arsip terpotong: blok header tidak lengkap.", "truncated");
    }
    const block = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(block)) {
      terminated = true;
      break;
    }

    const stored = parseOctalField(block.subarray(148, 156), "checksum");
    const { unsigned, signed } = checksumOf(block);
    if (stored !== unsigned && stored !== signed) {
      throw new TarballError("Checksum header tar tidak cocok.", "bad-checksum");
    }

    const flag = String.fromCharCode(block[156] ?? 0);
    const size = parseOctalField(block.subarray(124, 136), "size");
    const mode = parseOctalField(block.subarray(100, 108), "mode");
    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);

    offset += BLOCK_SIZE;
    const padded = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset + size > tar.length || offset + padded > tar.length) {
      throw new TarballError("Arsip terpotong: isi entri tidak lengkap.", "truncated");
    }
    const data = tar.subarray(offset, offset + size);
    offset += padded;

    if (flag === "x" || flag === "g") {
      const records = parsePaxRecords(data);
      if (flag === "g") {
        globalPax = { ...globalPax, ...records };
      } else {
        nextPax = { ...(nextPax ?? {}), ...records };
      }
      continue;
    }
    if (flag === "L") {
      longName = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (flag === "K") {
      // Panjang tautan GNU; symlink anyways ditolak.
      continue;
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) };
    nextPax = undefined;
    const paxPath = pax.path;
    const paxSize = pax.size;
    const rawPath =
      paxPath !== undefined && paxPath !== ""
        ? paxPath
        : (longName ?? (prefix !== "" ? `${prefix}/${name}` : name));
    longName = undefined;
    // Nilai pax ditulis dalam desimal, bukan oktal seperti field header.
    // Isi sudah dipotong memakai ukuran header; ukuran pax yang berbeda berarti
    // batas per berkas bisa dilewati, jadi arsip seperti itu ditolak.
    if (paxSize !== undefined) {
      if (!/^[0-9]+$/.test(paxSize) || Number.parseInt(paxSize, 10) !== size) {
        throw new TarballError("Ukuran pax tidak cocok dengan ukuran header.", "bad-header");
      }
    }
    const effectiveSize = size;
    const type = typeOf(flag);
    const path = type === "dir" ? rawPath.replace(/\/+$/, "") : rawPath;

    const entry: TarEntry = { path, type, size: effectiveSize, mode };
    if (type === "file") entry.data = data;
    entries.push(entry);
  }

  if (!terminated) {
    throw new TarballError("Arsip terpotong: blok penutup tidak ada.", "truncated");
  }
  return entries;
}

/* --------------------------------------------------------------- validasi */

function validateEntryPath(path: string): void {
  if (/^[A-Za-z]:/.test(path)) {
    throw new TarballError(`Jalur dengan gaya drive ditolak: ${path}`, "absolute-path");
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new TarballError("Nama entri memuat karakter kontrol.", "bad-name");
  }
  if (path.includes("\\")) {
    throw new TarballError(`Nama entri memuat backslash: ${path}`, "bad-name");
  }
  if (path.startsWith("/")) {
    throw new TarballError(`Jalur absolut ditolak: ${path}`, "absolute-path");
  }
  for (const segment of path.split("/")) {
    if (segment === "..") {
      throw new TarballError(`Jalur keluar folder ditolak: ${path}`, "path-traversal");
    }
    if (segment === "" || segment === ".") {
      throw new TarballError(`Nama entri tidak valid: ${path}`, "bad-name");
    }
  }
  if (path.length > 1024) {
    throw new TarballError("Nama entri terlalu panjang.", "bad-name");
  }
}

/** Jalur relatif isi paket setelah awalan `package/` dilepas. */
function relativeOf(entry: TarEntry): string {
  if (entry.path === PREFIX) return "";
  if (!entry.path.startsWith(`${PREFIX}/`)) {
    throw new TarballError(`Entri di luar awalan package/: ${entry.path}`, "outside-prefix");
  }
  return entry.path.slice(PREFIX.length + 1);
}

function parsePackageJson(entry: TarEntry): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(entry.data ?? new Uint8Array(0));
  } catch {
    throw new TarballError("package.json tidak dapat dibaca.", "bad-package-json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TarballError("package.json bukan JSON yang valid.", "bad-package-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TarballError("package.json tidak berupa objek.", "bad-package-json");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Memvalidasi seluruh entri sebelum apa pun ditulis.
 *
 * `limits` boleh disempitkan untuk pengujian. Bila `expected` diberikan,
 * `package.json` harus bernama dan versinya sama persis.
 */
export function validateEntries(
  entries: TarEntry[],
  limits?: Partial<TarballLimits>,
  expected?: { name: string; version: string },
): void {
  const rules = resolveLimits(limits);
  if (entries.length > rules.maxEntries) {
    throw new TarballError(
      `Jumlah entri melebihi batas ${rules.maxEntries}.`,
      "too-many-entries",
    );
  }

  let total = 0;
  let packageJson: TarEntry | undefined;
  let hasSdk = false;

  for (const entry of entries) {
    if (entry.type === "symlink") {
      throw new TarballError(`Symlink ditolak: ${entry.path}`, "symlink");
    }
    if (entry.type === "hardlink") {
      throw new TarballError(`Hardlink ditolak: ${entry.path}`, "hardlink");
    }
    if (entry.type !== "file" && entry.type !== "dir") {
      throw new TarballError(`Jenis entri tidak didukung: ${entry.path}`, "bad-type");
    }

    validateEntryPath(entry.path);
    const relative = relativeOf(entry);
    if (relative === "" && entry.type === "file") {
      throw new TarballError(`Entri di luar awalan package/: ${entry.path}`, "outside-prefix");
    }

    if (entry.type === "file") {
      if (entry.size > rules.maxFileBytes) {
        throw new TarballError(
          `Berkas terlalu besar: ${entry.path} (${entry.size} byte)`,
          "file-too-large",
        );
      }
      total += entry.size;
      if (total > rules.maxTotalBytes) {
        throw new TarballError(
          `Total ukuran arsip melebihi batas ${rules.maxTotalBytes} byte.`,
          "too-large",
        );
      }
      if (relative === "package.json") packageJson = entry;
      if (relative === "sdk.mjs") hasSdk = true;
    }
  }

  if (packageJson === undefined) {
    throw new TarballError("package.json tidak ada di dalam paket.", "missing-package-json");
  }
  if (expected !== undefined) {
    const parsed = parsePackageJson(packageJson);
    if (parsed.name !== expected.name) {
      throw new TarballError(
        `Nama paket tidak cocok: diharapkan "${expected.name}".`,
        "name-mismatch",
      );
    }
    if (parsed.version !== expected.version) {
      throw new TarballError(
        `Versi paket tidak cocok: diharapkan "${expected.version}".`,
        "version-mismatch",
      );
    }
  }
  if (!hasSdk) {
    throw new TarballError("sdk.mjs tidak ada di dalam paket.", "missing-sdk");
  }
}

/* --------------------------------------------------------------- penulisan */

function gunzipLimited(gz: Uint8Array, rules: TarballLimits): Uint8Array {
  if (gz.length > rules.maxCompressedBytes) {
    throw new TarballError(
      `Ukuran unduhan melebihi batas ${rules.maxCompressedBytes} byte.`,
      "too-large",
    );
  }

  // Keterbatasan: `Bun.gunzipSync` tidak punya batas keluaran, jadi hasil
  // dekompresi dialokasikan penuh sebelum dicek. Yang bisa dicek lebih dulu
  // adalah footer gzip: ISIZE adalah ukuran keluaran (mod 2^32). Untuk bom
  // besar yang melewati 4 GiB nilai itu bisa membungkus, jadi cek setelah
  // dekompresi tetap wajib.
  if (gz.length >= 18 && gz[0] === 0x1f && gz[1] === 0x8b) {
    const view = new DataView(gz.buffer, gz.byteOffset + gz.byteLength - 4, 4);
    const isize = view.getUint32(0, true);
    if (isize > rules.maxUncompressedBytes) {
      throw new TarballError(
        "Ukuran hasil dekompresi melebihi batas (dicek dari footer gzip).",
        "too-large",
      );
    }
  }

  let output: Uint8Array;
  try {
    // Tipe Bun menuntut buffer bertipe ArrayBuffer; cast ini hanya untuk tipe.
    output = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>);
  } catch (error) {
    throw new TarballError(`Gzip tidak valid: ${errorMessage(error)}`, "gzip");
  }
  if (output.length > rules.maxUncompressedBytes) {
    throw new TarballError(
      `Ukuran hasil dekompresi melebihi batas ${rules.maxUncompressedBytes} byte.`,
      "too-large",
    );
  }
  return output;
}

function safeTarget(base: string, relative: string): string {
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new TarballError(`Target di luar folder tujuan: ${relative}`, "path-traversal");
  }
  return target;
}

/**
 * Membuat folder bertingkat tanpa mengikuti symlink yang sudah ada.
 * Setiap komponen dicek dengan `lstat` sebelum dibuat.
 */
async function ensureDirectories(base: string, relative: string): Promise<void> {
  if (relative === "" || relative === ".") return;
  let current = base;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    let exists = true;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TarballError(
          `Folder tujuan berisi symlink atau berkas: ${segment}`,
          "path-traversal",
        );
      }
    } catch (error) {
      if (error instanceof TarballError) throw error;
      if (!isNotFound(error)) throw error;
      exists = false;
    }
    if (!exists) {
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
}

async function writeEntries(entries: TarEntry[], destDir: string): Promise<void> {
  const base = resolve(destDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await lstat(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new TarballError("Folder tujuan bukan direktori biasa.", "path-traversal");
  }
  await chmod(base, 0o700);

  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const relative = relativeOf(entry);
    if (relative === "") continue;
    const target = safeTarget(base, relative);
    await ensureDirectories(base, dirname(relative) === "." ? "" : dirname(relative));
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TarballError(`Folder tujuan bukan direktori biasa: ${relative}`, "path-traversal");
    }
    await chmod(target, 0o700);
  }

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const relative = relativeOf(entry);
    if (relative === "") continue;
    const target = safeTarget(base, relative);
    await ensureDirectories(base, dirname(relative) === "." ? "" : dirname(relative));
    try {
      await writeFile(target, entry.data ?? new Uint8Array(0), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new TarballError(`Entri duplikat: ${relative}`, "duplicate");
      }
      throw error;
    }
    await chmod(target, 0o600);
  }
}

/**
 * Mengekstrak tarball gzip ke `destDir`.
 *
 * Isi paket ditulis langsung ke `destDir` (awalan `package/` dilepas), jadi
 * hasilnya `destDir/package.json` dan `destDir/sdk.mjs`. Tidak ada skrip
 * yang dijalankan dan tidak ada berkas yang ditimpa.
 */
export async function extractTarball(
  gz: Uint8Array,
  destDir: string,
  expected: { name: string; version: string },
  limits?: Partial<TarballLimits>,
): Promise<{ entries: number; bytes: number }> {
  const rules = resolveLimits(limits);
  const tar = gunzipLimited(gz, rules);
  const entries = parseTarEntries(tar);
  validateEntries(entries, rules, expected);
  await writeEntries(entries, destDir);

  let bytes = 0;
  for (const entry of entries) {
    if (entry.type === "file") bytes += entry.size;
  }
  return { entries: entries.length, bytes };
}
