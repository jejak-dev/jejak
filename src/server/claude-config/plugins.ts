import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Ringkasan plugin Claude Code yang sudah dipasang lewat Claude Code. */
export interface PluginInfo {
  /** Bentuk "nama@marketplace"; sama dengan kunci berkas pemasangan. */
  id: string;
  name: string;
  marketplace: string;
  description: string;
  version: string;
  author: string;
  /** Path absolut folder plugin. */
  path: string;
  /** Jumlah SKILL.md di bawah folder skills. */
  skills: number;
  /** Jumlah berkas .md di folder commands. */
  commands: number;
  /** Jumlah berkas .md di folder agents. */
  agents: number;
  /** Apakah `hooks/hooks.json` ada. */
  hasHooks: boolean;
}

export const MAX_PLUGINS = 100;
export const MAX_PLUGIN_FILE_BYTES = 1024 * 1024;
export const MAX_PLUGIN_META_BYTES = 64 * 1024;
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}$/;

/** Versi berkas pemasangan yang Jejak paham. */
const KNOWN_FILE_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

/**
 * Baca `~/.claude/plugins/installed_plugins.json`.
 *
 * Berkas tak ada, JSON rusak, atau versi tak dikenal menghasilkan daftar
 * kosong tanpa melempar galat.
 */
function readInstalledFile(home: string): Record<string, Record<string, unknown>[]> {
  const path = join(home, ".claude", "plugins", "installed_plugins.json");
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return {};
  }
  if (size > MAX_PLUGIN_FILE_BYTES) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  if (parsed.version !== KNOWN_FILE_VERSION) return {};
  const plugins = parsed.plugins;
  if (!isRecord(plugins)) return {};

  const result: Record<string, Record<string, unknown>[]> = {};
  for (const [key, value] of Object.entries(plugins)) {
    if (!Array.isArray(value)) continue;
    const entries = value.filter(isRecord);
    if (entries.length === 0) continue;
    result[key] = entries;
  }
  return result;
}

/** Metadata plugin; `undefined` bila berkas tak ada atau rusak. */
function readMetadata(installPath: string): Record<string, unknown> | undefined {
  const path = join(installPath, ".claude-plugin", "plugin.json");
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  if (size > MAX_PLUGIN_META_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === "string" ? value : "";
}

/** `author` boleh berupa string atau objek `{ name }`. */
function metaAuthor(meta: Record<string, unknown> | undefined): string {
  const value = meta?.author;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.name === "string") return value.name;
  return "";
}

/** Jumlah berkas `.md` langsung di dalam folder. */
function countMarkdown(root: string, folder: string): number {
  try {
    return readdirSync(join(root, folder), { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

/** Jumlah subfolder yang memuat `SKILL.md`. */
function countSkills(root: string): number {
  try {
    const entries = readdirSync(join(root, "skills"), { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!existsSync(join(root, "skills", entry.name, "SKILL.md"))) continue;
      total += 1;
    }
    return total;
  } catch {
    return 0;
  }
}

function hasHooks(root: string): boolean {
  try {
    return statSync(join(root, "hooks", "hooks.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Entri pemasangan yang dipakai: entri pertama bertipe `user` yang
 * `installPath`-nya benar-benar ada sebagai direktori.
 */
function pickEntry(
  entries: Record<string, unknown>[],
): { installPath: string } | undefined {
  for (const entry of entries) {
    if (entry.scope !== "user") continue;
    const installPath = entry.installPath;
    if (typeof installPath !== "string" || installPath === "") continue;
    let isDirectory = false;
    try {
      isDirectory = statSync(installPath).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    return { installPath };
  }
  return undefined;
}

function buildInfo(id: string, installPath: string): PluginInfo {
  const meta = readMetadata(installPath);
  const separator = id.indexOf("@");
  const nameFromKey = separator === -1 ? id : id.slice(0, separator);
  const marketplace = separator === -1 ? "" : id.slice(separator + 1);
  const name = metaString(meta, "name") || nameFromKey;
  return {
    id,
    name,
    marketplace,
    description: metaString(meta, "description"),
    version: metaString(meta, "version"),
    author: metaAuthor(meta),
    path: installPath,
    skills: countSkills(installPath),
    commands: countMarkdown(installPath, "commands"),
    agents: countMarkdown(installPath, "agents"),
    hasHooks: hasHooks(installPath),
  };
}

/**
 * Daftar plugin yang sudah dipasang; terurut menurut id.
 *
 * Pembacaan hanya satu arah (read-only) dan tak pernah melempar galat.
 */
export function listInstalledPlugins(home?: string): PluginInfo[] {
  const installed = readInstalledFile(homeDir(home));
  const result: PluginInfo[] = [];
  for (const id of Object.keys(installed).sort()) {
    if (result.length >= MAX_PLUGINS) break;
    const entries = installed[id];
    if (entries === undefined) continue;
    const entry = pickEntry(entries);
    if (entry === undefined) continue;
    result.push(buildInfo(id, entry.installPath));
  }
  return result;
}

/**
 * Path plugin aktif yang masih terpasang.
 *
 * Id yang tak terpasang (dihapus atau bukan cakupan pengguna) dilewati.
 */
export function enabledPluginPaths(
  home: string | undefined,
  enabledIds: readonly string[] | undefined,
): { id: string; path: string }[] {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return [];
  const installed = new Map(listInstalledPlugins(home).map((item) => [item.id, item]));
  const result: { id: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const id of [...enabledIds].sort()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = installed.get(id);
    if (found === undefined) continue;
    result.push({ id: found.id, path: found.path });
  }
  return result;
}
