import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isValidSdkVersion, readActive } from "./sdk-store";

/**
 * Penyimpanan CLI bawaan SDK.
 *
 * Paket pendamping platform (`@anthropic-ai/claude-agent-sdk-<platform>`)
 * berisi binary `claude`. Binary itu tidak pernah dibundel Jejak: pengguna
 * mengunduhnya sendiri lewat persetujuan eksplisit.
 *
 * Tata letak: `<sdk>/<versi-SDK>/cli/<claude|claude.exe>` plus
 * `<sdk>/<versi-SDK>/cli/meta.json` yang mencatat asal dan ukuran berkas.
 */

export const CLI_PACKAGE_SCOPE = "@anthropic-ai";
export const CLI_PACKAGE_BASENAME = "claude-agent-sdk";

/** Platform yang bisa dipakai Jejak. */
export type CliPlatform = "darwin-arm64" | "darwin-x64" | "win32-x64";

/** Daftar platform yang didukung; dipakai sebagai daftar putih. */
export const CLI_PLATFORMS: readonly CliPlatform[] = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
];

/** Platform paket pendamping untuk platform Jejak; `null` bila tidak didukung. */
export function cliPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CliPlatform | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin-arm64";
    if (arch === "x64") return "darwin-x64";
    return null;
  }
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

/** Nama berkas binary CLI untuk platform tertentu. */
export function cliExecutableName(plat: CliPlatform): string {
  return plat === "win32-x64" ? "claude.exe" : "claude";
}

/** Nama paket pendamping platform; dipakai untuk metadata registry. */
export function cliPackageName(plat: CliPlatform): string {
  return `${CLI_PACKAGE_SCOPE}/${CLI_PACKAGE_BASENAME}-${plat}`;
}

/** Folder CLI milik satu versi SDK. */
export function cliDir(root: string, version: string): string {
  return join(root, version, "cli");
}

/** Metadata CLI yang terpasang; isi berkas `meta.json`. */
export interface CliMeta {
  version: string;
  platform: CliPlatform;
  /** Nilai SRI sha512 dari tarball asal. */
  integrity: string;
  /** Waktu pemasangan dalam ISO-8601. */
  installedAt: string;
  /** Ukuran binary CLI dalam byte. */
  size: number;
}

/** Hasil resolusi CLI terkelola. */
export interface ManagedCli {
  path: string;
  version: string;
  platform: CliPlatform;
}

/** Opsi resolusi; `runVersion` dipakai untuk memastikan binary masih hidup. */
export interface ResolveManagedOptions {
  /** Pembaca versi; bila diberikan, binary wajib menjawab `--version`. */
  runVersion?: (path: string, timeoutMs: number) => Promise<string | null>;
  /** Batas waktu `--version` dalam milidetik. */
  timeoutMs?: number;
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

/** Baca `meta.json`; rusak, tak ada, atau tidak lengkap -> `null`. */
export async function readCliMeta(
  root: string,
  version: string,
): Promise<CliMeta | null> {
  if (!isValidSdkVersion(version)) return null;
  let raw: string;
  try {
    raw = await readFile(join(cliDir(root, version), "meta.json"), "utf8");
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
  const platform = parsed.platform;
  const { integrity, installedAt, size } = parsed;
  if (typeof platform !== "string") return null;
  if (!CLI_PLATFORMS.includes(platform as CliPlatform)) return null;
  if (typeof integrity !== "string" || integrity === "") return null;
  if (typeof installedAt !== "string" || installedAt === "") return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  return {
    version,
    platform: platform as CliPlatform,
    integrity,
    installedAt,
    size,
  };
}

/**
 * Cari CLI bawaan yang terpasang untuk versi SDK aktif.
 *
 * Versi aktif dibaca dari `active.json`; metadata dan binary harus ada.
 * Kerusakan apa pun -> `null`, tidak pernah melempar.
 */
export async function resolveManagedCli(
  root: string,
  options: ResolveManagedOptions = {},
): Promise<ManagedCli | null> {
  try {
    const active = await readActive(root);
    if (active === null) return null;
    const meta = await readCliMeta(root, active.version);
    if (meta === null) return null;
    const path = join(cliDir(root, active.version), cliExecutableName(meta.platform));
    if (!(await isFile(path))) return null;
    if (options.runVersion !== undefined) {
      const version = await options.runVersion(path, options.timeoutMs ?? 10_000);
      if (version === null) return null;
    }
    return { path, version: meta.version, platform: meta.platform };
  } catch {
    return null;
  }
}

/** Status CLI bawaan; `installed` null bila belum terpasang atau rusak. */
export async function readCliStatus(
  root: string,
): Promise<{ installed: Omit<CliMeta, "integrity"> | null }> {
  const active = await readActive(root);
  if (active === null) return { installed: null };
  const meta = await readCliMeta(root, active.version);
  if (meta === null) return { installed: null };
  const path = join(cliDir(root, active.version), cliExecutableName(meta.platform));
  if (!(await isFile(path))) return { installed: null };
  return {
    installed: {
      version: meta.version,
      platform: meta.platform,
      installedAt: meta.installedAt,
      size: meta.size,
    },
  };
}

/** Hapus folder CLI milik satu versi SDK; dipakai saat pemasangan gagal. */
export async function removeCli(root: string, version: string): Promise<void> {
  if (!isValidSdkVersion(version)) return;
  await rm(cliDir(root, version), { recursive: true, force: true });
}
