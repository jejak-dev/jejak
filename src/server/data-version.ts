/**
 * Penjaga versi data Jejak.
 *
 * Pembaruan aplikasi mengganti versi tanpa menyentuh data pengguna di
 * `JEJAK_HOME`. Modul ini mencatat versi aplikasi yang terakhir menyentuh
 * data, mencadangkan data sebelum naik versi, dan menolak data yang dibuat
 * aplikasi yang lebih baru.
 *
 * Isi berkas versi: `<JEJAK_HOME>/data-version.json`
 * dengan bentuk `{"appVersion":"x.y.z","updatedAt":"ISO"}`.
 */
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** Nama berkas versi data di dalam `JEJAK_HOME`. */
export const DATA_VERSION_FILE = "data-version.json";

/** Jumlah cadangan versi yang disimpan. */
export const MAX_BACKUPS = 3;

/** Versi semver yang dipakai untuk data yang dibuat sebelum fitur ini. */
export const LEGACY_VERSION = "0.0.0";

/** Galat tingkat aplikasi saat data tak bisa dipakai. */
export type DataVersionErrorCode = "newer" | "backup";

export class DataVersionError extends Error {
  readonly code: DataVersionErrorCode;

  constructor(code: DataVersionErrorCode, message: string) {
    super(message);
    this.name = "DataVersionError";
    this.code = code;
  }
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pengenal pra-rilis; kosong untuk versi rilis. */
  prerelease: string[];
}

export type DataPrepAction = "fresh" | "same" | "upgraded" | "legacy";

export interface DataPrepResult {
  action: DataPrepAction;
  /** Versi data sebelumnya; `0.0.0` untuk data lama. */
  from?: string;
  /** Folder cadangan yang dibuat; tak ada bila cadangan dilewati. */
  backupDir?: string;
}

export interface PrepareDataDirOptions {
  /** Folder data Jejak (`JEJAK_HOME`). */
  home: string;
  /** Versi aplikasi yang sedang berjalan, mis. `1.2.3`. */
  appVersion: string;
  /** Sumber waktu untuk `updatedAt`; default jam sistem. */
  now?: () => Date;
  /** Lingkungan untuk membaca `JEJAK_SKIP_BACKUP`; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Saluran peringatan; default `console.error`. */
  warn?: (line: string) => void;
}

/** Hasil pemeriksaan versi data untuk `jejak doctor` (hanya membaca). */
export interface DataVersionInspection {
  status: "ok" | "peringatan" | "gagal";
  detail: string;
}

const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Urai versi semver.
 *
 * Metadata build (`+...`) diabaikan; sufiks pra-rilis disimpan terpisah.
 */
export function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const pre = match[4];
  return {
    major,
    minor,
    patch,
    prerelease: pre === undefined || pre === "" ? [] : pre.split("."),
  };
}

/** Bandingkan dua pengenal pra-rilis menurut aturan semver. */
function comparePrerelease(a: string[], b: string[]): number {
  // Versi rilis selalu lebih besar daripada pra-rilis.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Pengenal numerik selalu lebih rendah daripada pengenal alfanumerik.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Bandingkan dua versi semver.
 *
 * Mengembalikan bilangan negatif bila `a` lebih tua, nol bila sama, dan
 * positif bila `a` lebih baru. Versi tak valid melempar galat.
 */
export function compareSemver(a: string, b: string): number {
  const kiri = parseSemver(a);
  const kanan = parseSemver(b);
  if (kiri === null) throw new Error(`Versi semver tidak valid: "${a}"`);
  if (kanan === null) throw new Error(`Versi semver tidak valid: "${b}"`);
  if (kiri.major !== kanan.major) return kiri.major < kanan.major ? -1 : 1;
  if (kiri.minor !== kanan.minor) return kiri.minor < kanan.minor ? -1 : 1;
  if (kiri.patch !== kanan.patch) return kiri.patch < kanan.patch ? -1 : 1;
  return comparePrerelease(kiri.prerelease, kanan.prerelease);
}

/** Bandingkan dua versi; `null` bila salah satunya tak valid. */
function compareSemverAman(a: string, b: string): number | null {
  const kiri = parseSemver(a);
  const kanan = parseSemver(b);
  if (kiri === null || kanan === null) return null;
  return compareSemver(a, b);
}

function pesanGalat(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bacaBerkasOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Berkas data tingkat atas: `*.json` dan `*.db` (tanpa `-wal`/`-shm`). */
const POLA_BERKAS_DATA = /\.(json|db)$/i;

async function berkasDataTingkatAtas(home: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        POLA_BERKAS_DATA.test(entry.name) &&
        !entry.name.endsWith("-wal") &&
        !entry.name.endsWith("-shm"),
    )
    .map((entry) => entry.name)
    .sort();
}

/** True bila ada data pengguna di `home` (berkas versi data tak dihitung). */
export async function adaDataDi(home: string): Promise<boolean> {
  const names = await berkasDataTingkatAtas(home);
  return names.some((name) => name !== DATA_VERSION_FILE);
}

/** Tulis berkas versi data secara atomik dengan izin 0600. */
async function tulisBerkasVersi(
  home: string,
  appVersion: string,
  now: () => Date,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, DATA_VERSION_FILE);
  const body = `${JSON.stringify(
    { appVersion, updatedAt: now().toISOString() },
    null,
    2,
  )}\n`;
  const temp = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Berkas sementara mungkin sudah hilang; galat asli yang penting.
    }
    throw error;
  }
  await chmod(path, 0o600);
}

/** Salin basis data secara konsisten lewat `VACUUM INTO`. */
async function salinBasisData(src: string, dest: string): Promise<void> {
  let db: Database | undefined;
  try {
    db = new Database(src, { readonly: true });
    db.run("VACUUM INTO ?", [dest]);
    return;
  } catch {
    // Basis data tak bisa dibuka atau rusak: salin berkas mentah.
  } finally {
    try {
      db?.close();
    } catch {
      // Koneksi sudah tertutup.
    }
  }
  await copyFile(src, dest);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await copyFile(`${src}${suffix}`, `${dest}${suffix}`);
    } catch {
      // Berkas.sidecar tak ada; lewati.
    }
  }
}

/** Buang cadangan versi lama; simpan paling banyak `MAX_BACKUPS`. */
async function pangkasCadangan(backupRoot: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(backupRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const nama = entries
    .filter((entry) => entry.isDirectory() && parseSemver(entry.name) !== null)
    .map((entry) => entry.name);
  if (nama.length <= MAX_BACKUPS) return;
  const urut = nama.sort((a, b) => compareSemverAman(a, b) ?? 0);
  const buang = urut.slice(0, urut.length - MAX_BACKUPS);
  for (const name of buang) {
    await rm(join(backupRoot, name), { recursive: true, force: true });
  }
}

/**
 * Buat cadangan data tingkat atas ke `<home>/backup/<versi>/`.
 *
 * Hanya berkas `*.json` dan `*.db` tingkat atas yang disalin; subfolder
 * (worktree, checkpoint, workspace, memory) tidak ikut.
 */
async function buatCadangan(home: string, versi: string): Promise<string> {
  const backupRoot = join(home, "backup");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  const target = join(backupRoot, versi);
  // Cadangan versi yang sama ditimpa: hapus lalu buat ulang.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);

  for (const name of await berkasDataTingkatAtas(home)) {
    const src = join(home, name);
    const dest = join(target, name);
    if (name.endsWith(".db")) {
      await salinBasisData(src, dest);
    } else {
      await copyFile(src, dest);
    }
    await chmod(dest, 0o600);
  }

  await pangkasCadangan(backupRoot);
  return target;
}

/**
 * Siapkan folder data sebelum penyimpanan dibuka.
 *
 * Dipanggil sekali saat `jejak serve` mulai. Hasil:
 * - `fresh`: folder data masih kosong; berkas versi ditulis.
 * - `same`: versi data sama dengan versi aplikasi; tak ada yang ditulis.
 * - `upgraded`: versi data lebih tua; data dicadangkan lalu versi diperbarui.
 * - `legacy`: data dibuat sebelum fitur ini (dianggap versi `0.0.0`).
 */
export async function prepareDataDir(
  opts: PrepareDataDirOptions,
): Promise<DataPrepResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const home = opts.home;
  const appVersion = opts.appVersion;

  if (parseSemver(appVersion) === null) {
    throw new Error(`Versi aplikasi "${appVersion}" bukan semver yang valid.`);
  }

  const versionPath = join(home, DATA_VERSION_FILE);
  const raw = await bacaBerkasOrNull(versionPath);

  if (raw === null) {
    if (!(await adaDataDi(home))) {
      await tulisBerkasVersi(home, appVersion, now);
      return { action: "fresh" };
    }
    const backupDir = await naikVersi(home, LEGACY_VERSION, appVersion, env, now);
    return { action: "legacy", from: LEGACY_VERSION, ...(backupDir === undefined ? {} : { backupDir }) };
  }

  let recorded: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { appVersion?: unknown };
    const nilai = parsed?.appVersion;
    if (typeof nilai === "string" && parseSemver(nilai) !== null) {
      recorded = nilai;
    }
  } catch {
    recorded = null;
  }

  if (recorded === null) {
    warn(
      `Peringatan: berkas versi data di ${versionPath} rusak atau tak terbaca; ` +
        "data diperlakukan sebagai data lama.",
    );
    if (!(await adaDataDi(home))) {
      await tulisBerkasVersi(home, appVersion, now);
      return { action: "fresh" };
    }
    const backupDir = await naikVersi(home, LEGACY_VERSION, appVersion, env, now);
    return { action: "legacy", from: LEGACY_VERSION, ...(backupDir === undefined ? {} : { backupDir }) };
  }

  const perbandingan = compareSemverAman(recorded, appVersion);
  if (perbandingan === null) {
    throw new Error(`Versi data "${recorded}" bukan semver yang valid.`);
  }
  if (perbandingan === 0) {
    return { action: "same" };
  }
  if (perbandingan < 0) {
    const backupDir = await naikVersi(home, recorded, appVersion, env, now);
    return { action: "upgraded", from: recorded, ...(backupDir === undefined ? {} : { backupDir }) };
  }
  throw new DataVersionError(
    "newer",
    `Data di ${home} dibuat Jejak ${recorded} (lebih baru dari ${appVersion}). ` +
      "Perbarui Jejak ke versi yang lebih baru, atau pakai JEJAK_HOME lain. " +
      "Tidak ada yang diubah.",
  );
}

/**
 * Cadangkan data lalu perbarui berkas versi.
 *
 * `JEJAK_SKIP_BACKUP=1` melewati cadangan (berkas versi tetap diperbarui).
 * Galat cadangan melempar `DataVersionError` dengan kode `backup` dan berkas
 * versi tak diubah.
 */
async function naikVersi(
  home: string,
  from: string,
  appVersion: string,
  env: Record<string, string | undefined>,
  now: () => Date,
): Promise<string | undefined> {
  const skip = env.JEJAK_SKIP_BACKUP?.trim() === "1";
  let backupDir: string | undefined;
  if (!skip) {
    try {
      backupDir = await buatCadangan(home, from);
    } catch (error) {
      throw new DataVersionError(
        "backup",
        `Gagal mencadangkan data sebelum naik versi: ${pesanGalat(error)}. ` +
          "Berkas versi data tidak diubah.",
      );
    }
  }
  await tulisBerkasVersi(home, appVersion, now);
  return backupDir;
}

/**
 * Periksa versi data tanpa mengubah apa pun (dipakai `jejak doctor`).
 */
export async function inspectDataVersion(opts: {
  home: string;
  appVersion: string;
}): Promise<DataVersionInspection> {
  const { home, appVersion } = opts;
  const versionPath = join(home, DATA_VERSION_FILE);
  const raw = await bacaBerkasOrNull(versionPath);

  if (raw === null) {
    if (await adaDataDi(home)) {
      return {
        status: "peringatan",
        detail:
          `berkas versi data belum ada di ${versionPath}; data dibuat sebelum fitur ini ` +
          `dan belum bisa dipastikan versinya (aplikasi ${appVersion})`,
      };
    }
    return {
      status: "ok",
      detail: `${home}; belum ada data, versi data akan dicatat saat server berjalan`,
    };
  }

  let recorded: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { appVersion?: unknown };
    const nilai = parsed?.appVersion;
    if (typeof nilai === "string" && parseSemver(nilai) !== null) {
      recorded = nilai;
    }
  } catch {
    recorded = null;
  }

  if (recorded === null) {
    return {
      status: "peringatan",
      detail: `${versionPath} rusak atau tak terbaca; versi data tak bisa dipastikan`,
    };
  }

  const perbandingan = compareSemverAman(recorded, appVersion);
  if (perbandingan === null) {
    return {
      status: "peringatan",
      detail: `${versionPath} memuat versi "${recorded}" yang bukan semver valid`,
    };
  }
  if (perbandingan === 0) {
    return { status: "ok", detail: `${home}; versi data ${recorded}` };
  }
  if (perbandingan < 0) {
    return {
      status: "peringatan",
      detail:
        `data dibuat Jejak ${recorded}, lebih lama dari aplikasi ${appVersion}; ` +
        "tidak ada cadangan otomatis (data tetap dibaca)",
    };
  }
  return {
    status: "gagal",
    detail:
      `data dibuat Jejak ${recorded} (lebih baru dari aplikasi ${appVersion}); ` +
      "perbarui Jejak atau pakai JEJAK_HOME lain",
  };
}
