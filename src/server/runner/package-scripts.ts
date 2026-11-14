import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isWindows } from "../platform";
import { hasControlChar, hashCommand } from "./runner-store";

/** Batas ukuran `package.json` yang boleh dibaca (256 KB). */
export const PACKAGE_JSON_MAX_BYTES = 256 * 1024;
/** Batas jumlah script yang ditampilkan. */
export const PACKAGE_SCRIPTS_MAX = 100;
/** Panjang maksimum nama script. */
export const SCRIPT_NAME_MAX = 60;

/** Pengelola paket bawaan bila tidak ada lockfile. */
export const DEFAULT_PACKAGE_RUNNER = "bun run";

export interface PackageScript {
  id: string;
  label: string;
  command: string;
  /** Isi script apa adanya (dipakai untuk invalidate konfirmasi). */
  body: string;
}

const LOCKFILES: ReadonlyArray<{ file: string; runner: string }> = [
  { file: "bun.lock", runner: "bun run" },
  { file: "bun.lockb", runner: "bun run" },
  { file: "pnpm-lock.yaml", runner: "pnpm run" },
  { file: "yarn.lock", runner: "yarn run" },
  { file: "package-lock.json", runner: "npm run" },
];

const SAFE_NAME = /^[A-Za-z0-9:_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pengelola paket dari lockfile di folder proyek. */
export function detectPackageRunner(cwd: string): string {
  for (const entry of LOCKFILES) {
    if (existsSync(join(cwd, entry.file))) return entry.runner;
  }
  return DEFAULT_PACKAGE_RUNNER;
}

/**
 * Nama script di-quote bila memuat karakter di luar `[A-Za-z0-9:_.-]`.
 * POSIX memakai kutip tunggal; Windows memakai kutip ganda gaya cmd.exe.
 */
export function quoteScriptName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (SAFE_NAME.test(name)) return name;
  if (isWindows(platform)) return `"${name.replace(/"/g, '""')}"`;
  return `'${name.replace(/'/g, `'\\''`)}'`;
}

/** Id turunan script: `p_` + 8 hex pertama SHA-256(nama). */
export function scriptId(name: string): string {
  return `p_${hashCommand(name).slice(0, 8)}`;
}

/**
 * Script `package.json` di folder tertentu (bukan folder induk).
 * Berkas tak ada, rusak, atau bukan objek -> daftar kosong.
 */
export function readPackageScripts(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): PackageScript[] {
  const path = join(cwd, "package.json");
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return [];
    size = stat.size;
  } catch {
    return [];
  }
  if (size > PACKAGE_JSON_MAX_BYTES) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const scripts = parsed.scripts;
  if (!isRecord(scripts)) return [];

  const runner = detectPackageRunner(cwd);
  const result: PackageScript[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (result.length >= PACKAGE_SCRIPTS_MAX) break;
    if (typeof value !== "string") continue;
    if (name === "" || name.length > SCRIPT_NAME_MAX) continue;
    if (hasControlChar(name)) continue;
    result.push({
      id: scriptId(name),
      label: name,
      command: `${runner} ${quoteScriptName(name, platform)}`,
      body: value,
    });
  }
  return result;
}
