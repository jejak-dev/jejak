import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { jejakHome } from "../provider-store";
import { extractTarball, TarballError, verifyIntegrity } from "./tarball";

/**
 * Penyimpanan SDK yang dipasang pengguna.
 *
 * Tata letak: `<sdk>/<versi>/package/` berisi isi paket, `<sdk>/active.json`
 * menandai versi aktif, dan `<sdk>/<versi>/meta.json` menyimpan metadata
 * versi itu agar rollback bisa memulihkan integritas.
 */

export const SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";

export type SdkStoreErrorCode = "busy" | "no-previous" | "bad-version" | "not-found";

export class SdkStoreError extends Error {
  constructor(
    message: string,
    public readonly code: SdkStoreErrorCode,
  ) {
    super(message);
    this.name = "SdkStoreError";
  }
}

export interface ActiveSdkRecord {
  version: string;
  /** Waktu pemasangan dalam ISO-8601. */
  installedAt: string;
  /** Nilai SRI sha512 dari tarball yang dipasang. */
  integrity: string;
  /** Versi sebelumnya, bila ada, untuk rollback. */
  previous?: string;
}

export interface SdkStatus {
  installed: { version: string; installedAt: string; integrity: string } | null;
  previous: string | null;
}

/** Semver ketat; dipakai juga sebagai nama folder sehingga harus aman. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSdkVersion(version: string): boolean {
  return SEMVER.test(version);
}

/** Folder tempat SDK terpasang untuk env yang diberikan. */
export function sdkRoot(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "sdk");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
  const temp = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temp, body, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      // Berkas sementara mungkin sudah tidak ada; galat asli yang dilempar.
    }
    throw error;
  }
  await chmod(path, mode);
}

/** Membaca `active.json`; berkas rusak atau tidak ada -> `null`, bukan melempar. */
export async function readActive(root: string): Promise<ActiveSdkRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, "active.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { version, installedAt, integrity, previous } = parsed;
  if (typeof version !== "string" || !isValidSdkVersion(version)) return null;
  if (typeof installedAt !== "string" || installedAt === "") return null;
  if (typeof integrity !== "string" || integrity === "") return null;
  const record: ActiveSdkRecord = { version, installedAt, integrity };
  if (typeof previous === "string" && isValidSdkVersion(previous) && previous !== version) {
    record.previous = previous;
  }
  return record;
}

interface VersionMeta {
  version: string;
  installedAt: string;
  integrity: string;
}

async function readMeta(root: string, version: string): Promise<VersionMeta | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, version, "meta.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { installedAt, integrity } = parsed;
  if (typeof installedAt !== "string" || installedAt === "") return null;
  if (typeof integrity !== "string" || integrity === "") return null;
  return { version, installedAt, integrity };
}

/** Hanya versi aktif dan sebelumnya yang disimpan; sisanya dihapus. */
async function pruneVersions(root: string, keep: string[]): Promise<void> {
  const wanted = new Set(keep);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") || wanted.has(name)) continue;
    if (!isValidSdkVersion(name)) continue;
    const target = join(root, name);
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) continue;
    await rm(target, { recursive: true, force: true });
  }
}

export interface InstallOptions {
  /** Isi tarball gzip seperti diterima dari registry. */
  gz: Uint8Array;
  /** Nilai SRI sha512 dari metadata registry. */
  integrity: string;
  /** Nama dan versi yang diharapkan ada di dalam paket. */
  expected: { name: string; version: string };
  /** Waktu pemasangan ISO-8601; untuk pengujian. */
  now?: string;
}

/**
 * Memasang SDK dari tarball: verifikasi integritas, ekstrak ke folder
 * sementara, lalu pindahkan secara atomik ke `<root>/<versi>`.
 *
 * Folder sementara selalu dibersihkan bila tahap mana pun gagal.
 */
export async function installFromTarball(
  root: string,
  options: InstallOptions,
): Promise<{ version: string; installedAt: string }> {
  const version = options.expected.version;
  if (!isValidSdkVersion(version)) {
    throw new SdkStoreError(`Versi SDK tidak valid: ${version}`, "bad-version");
  }
  if (!verifyIntegrity(options.gz, options.integrity)) {
    throw new TarballError(
      "Integritas tarball tidak cocok dengan nilai SRI yang diharapkan.",
      "integrity",
    );
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const tempDir = join(root, `.tmp-${crypto.randomUUID()}`);
  const targetDir = join(root, version);
  let moved = false;
  try {
    await mkdir(tempDir, { mode: 0o700 });
    await chmod(tempDir, 0o700);

    // Isi paket ditulis ke `<temp>/package`, lalu `<temp>` dipindahkan
    // menjadi `<root>/<versi>` supaya hasil akhirnya `<versi>/package/`.
    await extractTarball(options.gz, join(tempDir, "package"), options.expected);

    const installedAt = options.now ?? new Date().toISOString();
    await writeJsonAtomic(
      join(tempDir, "meta.json"),
      { version, installedAt, integrity: options.integrity },
      0o600,
    );

    const active = await readActive(root);
    const previous =
      active !== null && active.version !== version ? active.version : active?.previous;

    // Memasang ulang versi yang sama diizinkan: folder lama dibuang dulu.
    await rm(targetDir, { recursive: true, force: true });
    await rename(tempDir, targetDir);
    moved = true;

    const record: ActiveSdkRecord = { version, installedAt, integrity: options.integrity };
    if (previous !== undefined && previous !== version) record.previous = previous;
    await writeJsonAtomic(join(root, "active.json"), record, 0o600);

    const keep = [version];
    if (record.previous !== undefined) keep.push(record.previous);
    await pruneVersions(root, keep);

    return { version, installedAt };
  } finally {
    if (!moved) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Status SDK terpasang; `installed` null bila paket tidak lengkap. */
export async function getStatus(root: string): Promise<SdkStatus> {
  const active = await readActive(root);
  if (active === null) return { installed: null, previous: null };
  const previous = active.previous ?? null;
  const hasSdk = await isFile(join(root, active.version, "package", "sdk.mjs"));
  if (!hasSdk) return { installed: null, previous };
  return {
    installed: {
      version: active.version,
      installedAt: active.installedAt,
      integrity: active.integrity,
    },
    previous,
  };
}

/** Mengaktifkan kembali versi sebelumnya (tukar aktif dan sebelumnya). */
export async function rollback(root: string): Promise<{ version: string }> {
  const active = await readActive(root);
  if (active === null || active.previous === undefined) {
    throw new SdkStoreError("Tidak ada versi sebelumnya untuk di-rollback.", "no-previous");
  }
  const target = active.previous;
  const hasSdk = await isFile(join(root, target, "package", "sdk.mjs"));
  if (!hasSdk) {
    throw new SdkStoreError("Versi sebelumnya tidak lengkap di disk.", "no-previous");
  }
  const meta = await readMeta(root, target);
  const record: ActiveSdkRecord = {
    version: target,
    installedAt: meta?.installedAt ?? new Date().toISOString(),
    integrity: meta?.integrity ?? active.integrity,
    previous: active.version,
  };
  await writeJsonAtomic(join(root, "active.json"), record, 0o600);
  return { version: target };
}

/**
 * Path absolut `sdk.mjs` versi aktif, atau `null`.
 *
 * Hanya diterima bila `realpath` berkas itu masih berada di bawah
 * `realpath(root)/<versi>/`; symlink yang keluar ditolak.
 */
export async function resolveActiveSdkEntry(root: string): Promise<string | null> {
  const active = await readActive(root);
  if (active === null) return null;
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    return null;
  }
  const versionDir = join(base, active.version);
  const target = join(versionDir, "package", "sdk.mjs");
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    return null;
  }
  if (!resolved.startsWith(versionDir + sep)) return null;
  if (!(await isFile(resolved))) return null;
  return resolved;
}

let installLockHeld = false;

/**
 * Kunci eksklusif dalam proses untuk pemasangan SDK.
 *
 * Melempar `SdkStoreError` berkode `busy` bila pemasangan lain sedang
 * berjalan (dipakai untuk jawaban 409 pada rute).
 */
export async function withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  if (installLockHeld) {
    throw new SdkStoreError("Pemasangan SDK sedang berjalan.", "busy");
  }
  installLockHeld = true;
  try {
    return await fn();
  } finally {
    installLockHeld = false;
  }
}
