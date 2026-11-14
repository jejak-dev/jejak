/**
 * Pemeriksaan versi Jejak.
 *
 * Memastikan versi di `package.json`, `src-tauri/tauri.conf.json`, dan
 * `src-tauri/Cargo.toml` sama, serta tag rilis cocok dengan versi itu.
 * Versi berprarilis (mis. `1.0.0-beta.1`) menentukan kanal rilis `beta`.
 *
 * Fungsi murni diekspor supaya bisa diuji tanpa menyentuh berkas.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSemver, parseCargoPackage, parseSemver } from "./release";

/** Akar repo, dihitung dari lokasi skrip ini. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Kanal rilis menurut jenis versi. */
export type RilisChannel = "stable" | "beta";

/** Versi yang dibaca dari tiga berkas manifest. */
export interface ManifestVersions {
  /** Versi di `package.json`. */
  package: string;
  /** Versi di `src-tauri/tauri.conf.json`. */
  tauri: string;
  /** Versi paket di `src-tauri/Cargo.toml`. */
  cargo: string;
}

/** Hasil pemeriksaan versi. */
export interface VersionCheck {
  /** True bila seluruh pemeriksaan lulus. */
  ok: boolean;
  /** Daftar pesan galat; kosong bila `ok` true. */
  errors: string[];
  /** Versi yang berlaku bila semua manifest sama dan sah; null bila tidak. */
  version: string | null;
  /** Kanal rilis menurut versi itu; null bila versi belum pasti. */
  channel: RilisChannel | null;
}

/** Membaca berkas dan melempar galat jelas bila gagal. */
function baca(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Berkas tidak bisa dibaca: ${path}`);
  }
}

/** Membaca versi dari `package.json`. */
export function readPackageVersion(path: string): string {
  const data = JSON.parse(baca(path)) as { version?: unknown };
  if (typeof data.version !== "string") {
    throw new Error(`${path} tidak punya field version`);
  }
  return data.version;
}

/** Membaca versi dari `tauri.conf.json`. */
export function readTauriVersion(path: string): string {
  const data = JSON.parse(baca(path)) as { version?: unknown };
  if (typeof data.version !== "string") {
    throw new Error(`${path} tidak punya field version`);
  }
  return data.version;
}

/** Membaca versi paket dari `Cargo.toml`. */
export function readCargoVersion(path: string): string {
  const info = parseCargoPackage(baca(path));
  if (info.version === null) {
    throw new Error(`${path} bagian [package] tidak punya version`);
  }
  return info.version;
}

/**
 * Membaca versi dari tiga berkas manifest di dalam `root`.
 *
 * Melempar galat jelas bila salah satu berkas tidak bisa dibaca atau tidak
 * punya versi.
 */
export function readVersions(root: string = ROOT): ManifestVersions {
  return {
    package: readPackageVersion(join(root, "package.json")),
    tauri: readTauriVersion(join(root, "src-tauri", "tauri.conf.json")),
    cargo: readCargoVersion(join(root, "src-tauri", "Cargo.toml")),
  };
}

/**
 * Menentukan kanal rilis dari sebuah versi.
 *
 * Versi tanpa prarilis -> `stable`; versi berprarilis -> `beta`.
 * Melempar galat bila versi bukan semver sah.
 */
export function channelForVersion(version: string): RilisChannel {
  const parts = parseSemver(version);
  if (parts === null) {
    throw new Error(`Versi tidak valid: "${version}"`);
  }
  return parts.prerelease === null ? "stable" : "beta";
}

/**
 * Memeriksa apakah versi di semua manifest sama dan tag cocok.
 *
 * `tag` bila diberikan harus persis `v` + versi tersebut.
 */
export function checkVersions(
  versions: ManifestVersions,
  tag?: string,
): VersionCheck {
  const errors: string[] = [];
  const semua: readonly (readonly [string, string])[] = [
    ["package.json", versions.package],
    ["src-tauri/tauri.conf.json", versions.tauri],
    ["src-tauri/Cargo.toml", versions.cargo],
  ];

  for (const [nama, versi] of semua) {
    if (!isValidSemver(versi)) {
      errors.push(`${nama} punya versi tidak valid: "${versi}"`);
    }
  }

  const nilaiUnik = new Set(semua.map(([, versi]) => versi));
  if (nilaiUnik.size > 1) {
    const rincian = semua.map(([nama, versi]) => `${nama}=${versi}`).join(", ");
    errors.push(`Versi tidak sama di semua berkas: ${rincian}`);
  }

  let version: string | null = null;
  let channel: RilisChannel | null = null;
  if (nilaiUnik.size === 1) {
    const satu = semua[0]?.[1] ?? "";
    if (isValidSemver(satu)) {
      version = satu;
      channel = channelForVersion(satu);
    }
  }

  if (tag !== undefined && tag !== "") {
    const diharapkan = version === null ? null : `v${version}`;
    if (diharapkan === null) {
      errors.push(`Tag rilis "${tag}" tidak bisa dicocokkan: versi belum konsisten.`);
    } else if (tag !== diharapkan) {
      errors.push(`Tag rilis "${tag}" tidak cocok dengan versi "${diharapkan}".`);
    }
  }

  return { ok: errors.length === 0, errors, version, channel };
}

/** Argumen baris perintah yang sudah diurai. */
export interface ParsedArgs {
  /** Tag rilis yang diperiksa; undefined bila tidak diberikan. */
  tag?: string;
  /** True bila keluaran hanya boleh berisi kanal rilis. */
  printChannel: boolean;
  /** Pesan galat Bahasa Indonesia bila argumen tidak sah. */
  error?: string;
}

/** Petunjuk pemakaian skrip. */
export const USAGE =
  "Pakai: bun run scripts/check-version.ts [--tag vX.Y.Z] [--print-channel]";

/** Mengurai argumen baris perintah skrip. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let tag: string | undefined;
  let printChannel = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--print-channel") {
      printChannel = true;
      continue;
    }
    if (token === "--tag" || token.startsWith("--tag=")) {
      let nilai: string | undefined;
      if (token.startsWith("--tag=")) {
        nilai = token.slice("--tag=".length);
      } else {
        nilai = argv[index + 1];
        if (nilai === undefined || nilai === "" || nilai.startsWith("--")) {
          return { printChannel, error: "--tag butuh nilai." };
        }
        index += 1;
      }
      if (nilai === "") {
        return { printChannel, error: "--tag butuh nilai." };
      }
      tag = nilai;
      continue;
    }
    return { printChannel, error: `Argumen tidak dikenal: ${token}` };
  }

  return { tag, printChannel };
}

/** Alur skrip; mengembalikan kode keluar untuk skrip. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    console.error(USAGE);
    return 1;
  }

  let versions: ManifestVersions;
  try {
    versions = readVersions(ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const hasil = checkVersions(versions, parsed.tag);
  if (!hasil.ok) {
    for (const pesan of hasil.errors) {
      console.error(`Galat: ${pesan}`);
    }
    return 1;
  }

  if (parsed.printChannel) {
    console.log(hasil.channel);
  } else {
    console.log(`Versi konsisten: ${hasil.version} (kanal ${hasil.channel}).`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
