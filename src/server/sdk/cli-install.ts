import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { defaultRunVersion } from "./claude-locator";
import {
  CLI_PACKAGE_BASENAME,
  CLI_PACKAGE_SCOPE,
  CLI_PLATFORMS,
  cliExecutableName,
  cliPackageName,
  cliPlatform,
  type CliPlatform,
} from "./cli-store";
import { REGISTRY_ORIGIN, RegistryError, type FetchLike } from "./registry";
import {
  getStatus,
  isValidSdkVersion,
  SdkStoreError,
  withInstallLock,
} from "./sdk-store";

/**
 * Pemasangan CLI bawaan SDK lewat unduhan streaming.
 *
 * Paket pendamping platform (`@anthropic-ai/claude-agent-sdk-<platform>`)
 * berisi binary `claude` berukuran besar. Binary itu tidak pernah dibundel
 * Jejak dan hanya dipasang setelah pengguna menyetujui lewat Pengaturan.
 *
 * Alur: metadata registry -> unduhan streaming ke berkas sementara ->
 * ekstrak streaming ke folder sementara -> verifikasi `--version` -> pindahkan
 * secara atomik ke `<sdk>/<versi>/cli`.
 */

export type CliInstallErrorCode =
  | "unsupported"
  | "no-sdk"
  | "metadata"
  | "mismatch"
  | "redirect"
  | "timeout"
  | "too-large"
  | "integrity"
  | "bad-archive"
  | "unsafe-entry"
  | "verify"
  | "disk"
  | "busy";

/** Galat instalasi CLI; pesan tanpa jalur internal dan tanpa jejak tumpukan. */
export class CliInstallError extends Error {
  constructor(
    message: string,
    public readonly code: CliInstallErrorCode,
  ) {
    super(message);
    this.name = "CliInstallError";
  }
}

/** Kemajuan unduhan; `total` null bila server tak menyebut ukuran berkas. */
export interface CliInstallProgress {
  received: number;
  total: number | null;
}

/** Batas ukuran dan waktu untuk jalur pemasangan CLI. */
export interface CliInstallLimits {
  /** Maks ukuran tarball terkompresi (byte). */
  maxDownload: number;
  /** Maks ukuran binary CLI (byte). */
  maxExecutable: number;
  /** Maks ukuran berkas pendukung di arsip (byte). */
  maxOtherFile: number;
  /** Maks total ukuran hasil ekstraksi (byte). */
  maxTotalBytes: number;
  /** Maks jumlah entri arsip. */
  maxEntries: number;
  /** Maks ukuran hasil ekstraksi yang diumumkan registry (byte). */
  maxUnpackedSize: number;
  /** Batas diam tanpa data (milidetik). */
  idleTimeoutMs: number;
  /** Batas total unduhan (milidetik). */
  totalTimeoutMs: number;
  /** Batas waktu pembacaan metadata (milidetik). */
  metadataTimeoutMs: number;
  /** Maks ukuran respons metadata (byte). */
  metadataMaxBytes: number;
  /** Selang minimal antar laporan kemajuan (milidetik). */
  progressIntervalMs: number;
}

export const DEFAULT_CLI_INSTALL_LIMITS: CliInstallLimits = {
  maxDownload: 400 * 1024 * 1024,
  maxExecutable: 600 * 1024 * 1024,
  maxOtherFile: 64 * 1024,
  maxTotalBytes: 650 * 1024 * 1024,
  maxEntries: 16,
  maxUnpackedSize: 650 * 1024 * 1024,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 20 * 60_000,
  metadataTimeoutMs: 20_000,
  metadataMaxBytes: 1024 * 1024,
  progressIntervalMs: 250,
};

/** Penulis berkas sementara; bentuk minimal untuk penyuntikan saat tes. */
export interface CliWriteStream {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(callback: () => void): void;
  on(event: "error" | "close", listener: (error?: Error) => void): void;
  destroy(): void;
}

/** Opsi pemasangan CLI. */
export interface InstallCliOptions {
  /** Akar penyimpanan SDK; biasanya `<JEJAK_HOME>/sdk`. */
  root: string;
  /** Versi SDK aktif; CLI hanya boleh dipasang untuk versi ini. */
  version: string;
  /** Platform target; bawaan platform proses ini. */
  platform?: string | null;
  /** `fetch` pengganti untuk pengujian; bawaannya `fetch` global. */
  fetch?: FetchLike;
  /** Pembaca versi binary; bawaan `defaultRunVersion`. */
  runVersion?: (path: string, timeoutMs: number) => Promise<string | null>;
  /** Batas ukuran dan waktu; untuk pengujian. */
  limits?: Partial<CliInstallLimits>;
  /** Laporan kemajuan unduhan. */
  onProgress?: (progress: CliInstallProgress) => void;
  /** Waktu ISO-8601 untuk metadata; untuk pengujian. */
  now?: () => string;
  /** Pembuat stream berkas sementara; untuk pengujian galat disk. */
  openWriteStream?: (path: string) => CliWriteStream;
}

/** Hasil pemasangan CLI yang berhasil. */
export interface CliInstallResult {
  version: string;
  platform: CliPlatform;
  installedAt: string;
  size: number;
}

const BLOCK_SIZE = 512;
const CHUNK_SIZE = 64 * 1024;
const STALE_TEMP_MS = 60 * 60_000;

/** Nama berkas pendukung yang boleh ada di dalam arsip. */
const ALLOWED_OTHER_FILES = ["package.json", "LICENSE.md", "README.md"] as const;

/* -------------------------------------------------------------- kemajuan */

let progressState: CliInstallProgress | null = null;

/** Kemajuan pemasangan CLI yang sedang berjalan; null bila tidak ada. */
export function getCliInstallProgress(): CliInstallProgress | null {
  return progressState;
}

/* ---------------------------------------------------------------- helper */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isDiskFull(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Galat disk dibungkus jadi pesan yang bisa dibaca pengguna.
 *
 * Galat lain diteruskan apa adanya supaya rute menjawab 500 umum tanpa
 * membocorkan jalur internal.
 */
function asCliError(error: unknown): unknown {
  if (error instanceof CliInstallError) return error;
  if (isDiskFull(error)) {
    return new CliInstallError(
      "Ruang disk tidak cukup. Siapkan sekitar 1 GB ruang kosong lalu coba lagi.",
      "disk",
    );
  }
  return error;
}

function resolveLimits(limits?: Partial<CliInstallLimits>): CliInstallLimits {
  return { ...DEFAULT_CLI_INSTALL_LIMITS, ...(limits ?? {}) };
}

/* --------------------------------------------------------------- metadata */

/** Metadata paket pendamping platform yang sudah divalidasi. */
export interface CliPackageMetadata {
  version: string;
  platform: CliPlatform;
  integrity: string;
  unpackedSize: number;
}

/** URL metadata versi; dibangun sendiri dari nama paket dan versi tervalidasi. */
export function buildCliMetadataUrl(plat: CliPlatform, version: string): string {
  return `${REGISTRY_ORIGIN}/${CLI_PACKAGE_SCOPE}%2F${CLI_PACKAGE_BASENAME}-${plat}/${version}`;
}

/** URL tarball; dibangun sendiri, bukan diambil dari metadata. */
export function buildCliTarballUrl(plat: CliPlatform, version: string): string {
  return `${REGISTRY_ORIGIN}/${CLI_PACKAGE_SCOPE}/${CLI_PACKAGE_BASENAME}-${plat}/-/${CLI_PACKAGE_BASENAME}-${plat}-${version}.tgz`;
}

function expectedOs(plat: CliPlatform): string {
  return plat === "win32-x64" ? "win32" : "darwin";
}

function expectedCpu(plat: CliPlatform): string {
  return plat === "darwin-arm64" ? "arm64" : "x64";
}

/** Daftar nilai field `os`/`cpu` dari metadata; string tunggal ikut diterima. */
function platformList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Validasi nilai SRI sha512; hanya sha512 dengan base64 sah yang diterima. */
export function isValidIntegrity(integrity: unknown): integrity is string {
  if (typeof integrity !== "string") return false;
  if (!integrity.startsWith("sha512-")) return false;
  const base64 = integrity.slice("sha512-".length).replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  return decoded.length === 64;
}

/** Baca body respons bertahap dengan batas ukuran. */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new RegistryError("Ukuran respons registry melebihi batas.", "too-large");
    }
    return new Uint8Array(buffer);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("melebihi batas ukuran");
        } catch {
          // Stream mungkin sudah tertutup; galat batas yang penting.
        }
        throw new RegistryError("Ukuran respons registry melebihi batas.", "too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Ambil metadata paket pendamping platform.
 *
 * Tanpa kredensial dan tanpa cookie; pengalihan ditolak. Galat dilempar
 * sebagai `RegistryError` supaya rute bisa memetakan 404 dan 502.
 */
export async function fetchCliMetadata(options: {
  plat: CliPlatform;
  version: string;
  fetch?: FetchLike;
  limits?: Partial<CliInstallLimits>;
}): Promise<CliPackageMetadata> {
  const limits = resolveLimits(options.limits);
  if (!isValidSdkVersion(options.version)) {
    throw new RegistryError("Versi bukan semver yang valid.", "invalid");
  }
  const fetchImpl = options.fetch ?? fetch;
  const url = buildCliMetadataUrl(options.plat, options.version);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RegistryError("Registry npm tidak merespons tepat waktu.", "timeout"));
    }, limits.metadataTimeoutMs);
  });

  let response: Response;
  try {
    response = await Promise.race([fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "manual",
    }), timeoutPromise]);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    if (isAbortError(error)) {
      throw new RegistryError("Registry npm tidak merespons tepat waktu.", "timeout");
    }
    throw new RegistryError("Gagal menghubungi registry npm.", "network");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new RegistryError(
      "Registry npm mengalihkan permintaan ke alamat lain; pengalihan ditolak.",
      "redirect",
    );
  }
  if (response.status === 404) {
    throw new RegistryError("Paket pendamping platform tidak ditemukan.", "not-found");
  }
  if (response.status !== 200) {
    throw new RegistryError("Registry npm menjawab dengan status tak terduga.", "bad-response");
  }

  const bytes = await readLimited(response, limits.metadataMaxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryError("Metadata registry bukan JSON yang valid.", "bad-response");
  }
  if (!isRecord(parsed)) {
    throw new RegistryError("Bentuk metadata registry tidak dikenal.", "bad-response");
  }

  const expectedName = cliPackageName(options.plat);
  if (parsed.name !== expectedName) {
    throw new RegistryError("Nama paket pendamping tidak cocok.", "bad-response");
  }
  if (parsed.version !== options.version) {
    throw new RegistryError("Versi paket pendamping tidak cocok.", "bad-response");
  }
  if (!platformList(parsed.os).includes(expectedOs(options.plat))) {
    throw new RegistryError("Metadata paket tidak cocok dengan platform ini.", "bad-response");
  }
  if (!platformList(parsed.cpu).includes(expectedCpu(options.plat))) {
    throw new RegistryError("Metadata paket tidak cocok dengan arsitektur ini.", "bad-response");
  }
  const dist = parsed.dist;
  if (!isRecord(dist)) {
    throw new RegistryError("Metadata versi tidak memuat dist.", "bad-response");
  }
  if (!isValidIntegrity(dist.integrity)) {
    throw new RegistryError("Metadata versi tidak memuat nilai integritas yang sah.", "bad-response");
  }
  const unpackedSize = dist.unpackedSize;
  if (typeof unpackedSize !== "number" || !Number.isFinite(unpackedSize) || unpackedSize < 0) {
    throw new RegistryError("Metadata versi tidak memuat ukuran yang sah.", "bad-response");
  }
  if (unpackedSize > limits.maxUnpackedSize) {
    throw new RegistryError("Ukuran paket melebihi batas yang diizinkan.", "too-large");
  }

  return {
    version: options.version,
    platform: options.plat,
    integrity: dist.integrity,
    unpackedSize,
  };
}

/* ------------------------------------------------------- pembaca tar streaming */

interface TarHeader {
  name: string;
  prefix: string;
  size: number;
  typeflag: string;
}

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

function parseOctalField(field: Uint8Array): number {
  if (field.length > 0 && ((field[0] ?? 0) & 0x80) !== 0) {
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
    throw new CliInstallError("Header arsip tidak valid.", "bad-archive");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliInstallError("Header arsip tidak valid.", "bad-archive");
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

/** Pembaca tarstreaming: blok header 512 byte dan isi per entri. */
class TarReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private iterator: AsyncIterator<Uint8Array>;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(minimum: number): Promise<boolean> {
    while (this.buffer.length < minimum) {
      if (this.ended) return false;
      const { done, value } = await this.iterator.next();
      if (done) {
        this.ended = true;
        return false;
      }
      if (value === undefined || value.length === 0) continue;
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer, 0);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
    return true;
  }

  /** Blok header berikutnya; `null` bila arsip habis. */
  async readBlock(): Promise<Uint8Array | null> {
    if (!(await this.fill(BLOCK_SIZE))) {
      if (this.buffer.length > 0) {
        throw new CliInstallError("Arsip terpotong: blok header tidak lengkap.", "bad-archive");
      }
      return null;
    }
    const block = this.buffer.subarray(0, BLOCK_SIZE);
    this.buffer = this.buffer.subarray(BLOCK_SIZE);
    return block;
  }

  /** Potongan isi entri sepanjang `size` byte. */
  async readChunk(size: number): Promise<Uint8Array> {
    if (size <= 0) return new Uint8Array(0);
    if (!(await this.fill(size))) {
      throw new CliInstallError("Arsip terpotong: isi entri tidak lengkap.", "bad-archive");
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  /** Lewati `size` byte tanpa menyimpan isinya. */
  async skip(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      const step = Math.min(remaining, CHUNK_SIZE);
      await this.readChunk(step);
      remaining -= step;
    }
  }
}

function parseHeader(block: Uint8Array): TarHeader {
  const stored = parseOctalField(block.subarray(148, 156));
  const { unsigned, signed } = checksumOf(block);
  if (stored !== unsigned && stored !== signed) {
    throw new CliInstallError("Checksum header arsip tidak cocok.", "bad-archive");
  }
  return {
    name: readString(block, 0, 100),
    prefix: readString(block, 345, 155),
    size: parseOctalField(block.subarray(124, 136)),
    typeflag: String.fromCharCode(block[156] ?? 0),
  };
}

/* --------------------------------------------------------------- unduhan */

/** Penunda dengan pembatalan; dipakai sebagai jaring pengaman. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Tutup stream penulis dan tunggu FD benar-benar tertutup.
 *
 * Tanpa ini berkas sementara bisa reopened setelah dihapus, sehingga sisa
 * unduhan menggantung di disk.
 */
async function closeWriteStream(
  stream: CliWriteStream,
  closed: Promise<void>,
): Promise<void> {
  try {
    stream.destroy();
  } catch {
    // Stream mungkin sudah tertutup.
  }
  const jaring = delay(500);
  try {
    await Promise.race([closed, jaring.promise]);
  } finally {
    jaring.cancel();
  }
}

/** Unduh tarball ke berkas sementara sambil menghitung sha512. */
async function downloadTarball(options: {
  url: string;
  target: string;
  integrity: string;
  fetchImpl: FetchLike;
  limits: CliInstallLimits;
  openWriteStream?: (path: string) => CliWriteStream;
  onProgress?: (progress: CliInstallProgress) => void;
}): Promise<void> {
  const { limits } = options;
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      credentials: "omit",
      redirect: "manual",
    });
  } catch (error) {
    throw new CliInstallError(
      `Gagal menghubungi registry npm: ${errorMessage(error)}`,
      "metadata",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new CliInstallError(
      "Registry npm mengalihkan permintaan ke alamat lain; pengalihan ditolak.",
      "redirect",
    );
  }
  if (response.status !== 200) {
    throw new CliInstallError(
      "Registry npm menjawab dengan status tak terduga.",
      "metadata",
    );
  }

  const lengthHeader = response.headers.get("content-length");
  const parsedLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  const total = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null;

  const hasher = new Bun.CryptoHasher("sha512");
  const started = Date.now();
  let lastData = started;
  let received = 0;
  let lastReport = 0;

  const stream =
    options.openWriteStream?.(options.target) ??
    createWriteStream(options.target, { flags: "wx", mode: 0o600 });
  let streamError: Error | null = null;
  let tandaiTutup: (() => void) | undefined;
  const streamClosed = new Promise<void>((resolve) => {
    tandaiTutup = resolve;
  });
  stream.on("error", (error) => {
    streamError = error ?? new Error("Gagal menulis berkas sementara.");
  });
  stream.on("close", () => {
    tandaiTutup?.();
  });
  const report = (): void => {
    if (options.onProgress === undefined) return;
    const now = Date.now();
    if (now - lastReport < limits.progressIntervalMs) return;
    lastReport = now;
    options.onProgress({ received, total });
  };

  const write = async (chunk: Uint8Array): Promise<void> => {
    if (streamError !== null) throw streamError;
    await new Promise<void>((resolve, reject) => {
      stream.write(chunk, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
    if (streamError !== null) throw streamError;
  };

  let berhasil = false;
  try {
    const body = response.body;
    if (body === null) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      received = buffer.byteLength;
      if (received > limits.maxDownload) {
        throw new CliInstallError("Ukuran unduhan melebihi batas yang diizinkan.", "too-large");
      }
      hasher.update(buffer);
      await write(buffer);
      report();
    } else {
      const reader = body.getReader();
      for (;;) {
        const idle = limits.idleTimeoutMs - (Date.now() - lastData);
        if (idle <= 0 || Date.now() - started > limits.totalTimeoutMs) {
          try {
            await reader.cancel("batas waktu terlampaui");
          } catch {
            // Stream mungkin sudah tertutup.
          }
          throw new CliInstallError(
            "Unduhan CLI bawaan terlalu lama berjalan; unduhan dibatalkan.",
            "timeout",
          );
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new CliInstallError("Unduhan CLI bawaan terlalu lama menganggur.", "timeout"));
          }, idle);
        });
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([reader.read(), timeoutPromise]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        if (result.done) break;
        const chunk = result.value;
        if (chunk === undefined) continue;
        lastData = Date.now();
        received += chunk.byteLength;
        if (received > limits.maxDownload) {
          try {
            await reader.cancel("melebihi batas ukuran");
          } catch {
            // Stream mungkin sudah tertutup; galat batas yang penting.
          }
          throw new CliInstallError("Ukuran unduhan melebihi batas yang diizinkan.", "too-large");
        }
        hasher.update(chunk);
        await write(chunk);
        report();
      }
      try {
        await reader.cancel();
      } catch {
        // Stream sudah habis.
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.end(() => resolve());
    });

    const actual = Buffer.from(hasher.digest("hex"), "hex");
    const expected = Buffer.from(
      options.integrity.slice("sha512-".length).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    if (expected.length !== 64 || actual.length !== 64 || !timingSafeEqual(expected, actual)) {
      throw new CliInstallError(
        "Integritas unduhan tidak cocok dengan metadata registry. Unduhan ditolak.",
        "integrity",
      );
    }
    berhasil = true;
  } catch (error) {
    if (isDiskFull(error)) {
      throw new CliInstallError(
        "Ruang disk tidak cukup. Siapkan sekitar 1 GB ruang kosong lalu coba lagi.",
        "disk",
      );
    }
    throw error;
  } finally {
    // Stream ditutup dulu supaya berkas tak reopened setelah dihapus.
    await closeWriteStream(stream, streamClosed);
    if (!berhasil) {
      await rm(options.target, { force: true }).catch(() => undefined);
    }
  }
}

/* --------------------------------------------------------------- ekstraksi */

/** Hasil ekstraksi arsip CLI. */
interface ExtractResult {
  /** Ukuran binary CLI dalam byte. */
  executableSize: number;
}

async function extractCliArchive(options: {
  archive: string;
  destDir: string;
  plat: CliPlatform;
  limits: CliInstallLimits;
}): Promise<ExtractResult> {
  const { limits } = options;
  const exeName = cliExecutableName(options.plat);
  const source = createReadStream(options.archive).pipe(createGunzip());
  const reader = new TarReader(source as unknown as AsyncIterable<Uint8Array>);

  await mkdir(options.destDir, { recursive: true, mode: 0o700 });
  await chmod(options.destDir, 0o700);

  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | undefined;
  let entries = 0;
  let totalBytes = 0;
  let executableSize = 0;
  let terminated = false;

  const allowedOther = new Set<string>(ALLOWED_OTHER_FILES);

  while (!terminated) {
    const block = await reader.readBlock();
    if (block === null) {
      throw new CliInstallError("Arsip terpotong: blok penutup tidak ada.", "bad-archive");
    }
    if (isZeroBlock(block)) {
      terminated = true;
      break;
    }

    const header = parseHeader(block);
    const padding = (BLOCK_SIZE - (header.size % BLOCK_SIZE)) % BLOCK_SIZE;

    if (header.typeflag === "x" || header.typeflag === "g") {
      const records: Record<string, string> = {};
      let left = header.size;
      while (left > 0) {
        const step = Math.min(left, CHUNK_SIZE);
        const chunk = await reader.readChunk(step);
        const text = new TextDecoder("utf-8").decode(chunk);
        Object.assign(records, parsePaxRecords(new TextEncoder().encode(text)));
        left -= step;
      }
      await reader.skip(padding);
      if (header.typeflag === "g") {
        globalPax = { ...globalPax, ...records };
      } else {
        nextPax = { ...(nextPax ?? {}), ...records };
      }
      continue;
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) };
    nextPax = undefined;
    const rawPath =
      pax.path !== undefined && pax.path !== ""
        ? pax.path
        : header.prefix !== ""
          ? `${header.prefix}/${header.name}`
          : header.name;
    if (pax.size !== undefined) {
      if (!/^[0-9]+$/.test(pax.size) || Number.parseInt(pax.size, 10) !== header.size) {
        throw new CliInstallError(
          "Ukuran pax tidak cocok dengan ukuran header arsip.",
          "bad-archive",
        );
      }
    }

    const isDir = header.typeflag === "5";
    const isFile = header.typeflag === "0" || header.typeflag === "\0" || header.typeflag === "7";
    if (!isDir && !isFile) {
      throw new CliInstallError(
        "Arsip memuat entri dengan jenis yang tidak diizinkan.",
        "unsafe-entry",
      );
    }

    const path = isDir ? rawPath.replace(/\/+$/, "") : rawPath;
    if (path === "package") {
      if (!isDir) {
        throw new CliInstallError("Entri arsip tidak diizinkan.", "unsafe-entry");
      }
      await reader.skip(header.size + padding);
      continue;
    }
    const expected = `package/${exeName}`;
    const isExecutable = path === expected;
    const isOther = path.startsWith("package/") && allowedOther.has(path.slice("package/".length));
    if (!isExecutable && !isOther) {
      throw new CliInstallError(
        "Arsip memuat berkas yang tidak diizinkan.",
        "unsafe-entry",
      );
    }

    entries += 1;
    if (entries > limits.maxEntries) {
      throw new CliInstallError("Jumlah entri arsip melebihi batas.", "unsafe-entry");
    }

    const maxSize = isExecutable ? limits.maxExecutable : limits.maxOtherFile;
    if (header.size > maxSize) {
      throw new CliInstallError("Berkas di arsip melebihi batas ukuran.", "too-large");
    }
    totalBytes += header.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new CliInstallError("Total ukuran arsip melebihi batas.", "too-large");
    }

    const target = join(options.destDir, path.slice("package/".length));
    const handle = await open(target, "wx", 0o600);
    let written = 0;
    try {
      while (written < header.size) {
        const step = Math.min(CHUNK_SIZE, header.size - written);
        const chunk = await reader.readChunk(step);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          offset += result.bytesWritten;
        }
        written += chunk.length;
      }
    } finally {
      await handle.close();
    }
    if (written !== header.size) {
      throw new CliInstallError(
        "Jumlah byte tertulis tidak sama dengan ukuran header arsip.",
        "bad-archive",
      );
    }
    await reader.skip(padding);
    await chmod(target, 0o600);
    if (isExecutable) executableSize = written;
  }

  if (executableSize === 0) {
    throw new CliInstallError("Arsip tidak memuat binary CLI.", "bad-archive");
  }
  await chmod(join(options.destDir, exeName), 0o700);
  return { executableSize };
}

/* ------------------------------------------------------------------ sweep */

/** Hapus sisa pemasangan yang basi (lebih dari satu jam). */
async function sweepStaleTemps(
  versionDir: string,
  now: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(versionDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".cli-")) continue;
    const target = join(versionDir, name);
    const info = await stat(target).catch(() => undefined);
    if (info === undefined) continue;
    if (now - info.mtimeMs < STALE_TEMP_MS) continue;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------- pemasangan */

async function installCliLocked(options: InstallCliOptions): Promise<CliInstallResult> {
  const limits = resolveLimits(options.limits);
  const requestedPlatform =
    options.platform === undefined ? cliPlatform() : options.platform;
  const plat =
    requestedPlatform !== null &&
    CLI_PLATFORMS.includes(requestedPlatform as CliPlatform)
      ? (requestedPlatform as CliPlatform)
      : null;
  if (plat === null) {
    throw new CliInstallError(
      "Platform ini tidak mendukung CLI bawaan SDK.",
      "unsupported",
    );
  }

  if (!isValidSdkVersion(options.version)) {
    throw new CliInstallError("Versi SDK tidak valid.", "mismatch");
  }

  const status = await getStatus(options.root);
  if (status.installed === null) {
    throw new CliInstallError(
      "Pasang SDK dulu sebelum memasang CLI bawaan.",
      "no-sdk",
    );
  }
  if (status.installed.version !== options.version) {
    throw new CliInstallError(
      "Versi CLI harus sama dengan versi SDK yang terpasang.",
      "mismatch",
    );
  }

  const versionDir = join(options.root, options.version);
  await mkdir(versionDir, { recursive: true, mode: 0o700 });
  await sweepStaleTemps(versionDir, Date.now());

  let metadata: CliPackageMetadata;
  try {
    metadata = await fetchCliMetadata({
      plat,
      version: options.version,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      limits,
    });
  } catch (error) {
    if (error instanceof RegistryError) {
      if (error.code === "redirect") {
        throw new CliInstallError(error.message, "redirect");
      }
      if (error.code === "timeout") {
        throw new CliInstallError(
          "Registry npm tidak merespons tepat waktu. Coba lagi nanti.",
          "timeout",
        );
      }
      if (error.code === "too-large") {
        throw new CliInstallError(
          "Ukuran metadata registry melebihi batas yang diizinkan.",
          "too-large",
        );
      }
      throw new CliInstallError(
        "Metadata paket CLI bawaan tidak bisa dibaca dari registry npm.",
        "metadata",
      );
    }
    throw error;
  }

  const suffix = crypto.randomUUID();
  const tempArchive = join(versionDir, `.cli-${suffix}.tgz.tmp`);
  const tempDir = join(versionDir, `.cli-${suffix}`);
  let installed = false;

  try {
    await downloadTarball({
      url: buildCliTarballUrl(plat, options.version),
      target: tempArchive,
      integrity: metadata.integrity,
      fetchImpl: options.fetch ?? fetch,
      limits,
      ...(options.openWriteStream === undefined
        ? {}
        : { openWriteStream: options.openWriteStream }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });

    const extracted = await extractCliArchive({
      archive: tempArchive,
      destDir: tempDir,
      plat,
      limits,
    });

    const runVersion = options.runVersion ?? defaultRunVersion;
    const version = await runVersion(join(tempDir, cliExecutableName(plat)), 10_000);
    if (version === null) {
      throw new CliInstallError(
        "Binary CLI bawaan tidak menjawab --version; pemasangan ditolak.",
        "verify",
      );
    }

    const installedAt = options.now?.() ?? new Date().toISOString();
    await writeFile(
      join(tempDir, "meta.json"),
      `${JSON.stringify({
        version: options.version,
        platform: plat,
        integrity: metadata.integrity,
        installedAt,
        size: extracted.executableSize,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(join(tempDir, "meta.json"), 0o600);

    const target = join(versionDir, "cli");
    const backup = join(versionDir, `.cli-lama-${suffix}`);
    let backedUp = false;
    const targetExists = await stat(target).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (targetExists) {
      await rename(target, backup);
      backedUp = true;
    }
    try {
      await rename(tempDir, target);
      installed = true;
    } catch (error) {
      if (backedUp) {
        await rename(backup, target).catch(() => undefined);
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      version: options.version,
      platform: plat,
      installedAt,
      size: extracted.executableSize,
    };
  } catch (error) {
    throw asCliError(error);
  } finally {
    await rm(tempArchive, { force: true }).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (!installed) progressState = null;
  }
}

/**
 * Pasang CLI bawaan SDK untuk versi SDK aktif.
 *
 * Satu pemasangan berjalan pada satu waktu; panggilan kedua saat masih
 * berjalan gagal dengan kode `busy`.
 */
export async function installCli(
  options: InstallCliOptions,
): Promise<CliInstallResult> {
  try {
    const result = await withInstallLock(async () => {
      progressState = { received: 0, total: null };
      try {
        return await installCliLocked({
          ...options,
          onProgress: (progress) => {
            progressState = progress;
            options.onProgress?.(progress);
          },
        });
      } finally {
        progressState = null;
      }
    });
    return result;
  } catch (error) {
    if (error instanceof SdkStoreError && error.code === "busy") {
      throw new CliInstallError(
        "Pemasangan lain sedang berjalan. Coba lagi sebentar lagi.",
        "busy",
      );
    }
    throw error;
  }
}
