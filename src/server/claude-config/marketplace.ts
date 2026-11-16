import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { listInstalledPlugins } from "./plugins";

/** Ringkasan marketplace yang sudah dikonfigurasi di Claude Code. */
export interface MarketplaceInfo {
  /** Nama marketplace; sama dengan kunci di `known_marketplaces.json`. */
  name: string;
  description: string;
  /** Jumlah plugin valid di katalog. */
  pluginCount: number;
  /** Waktu pembaruan terakhir marketplace; string kosong bila tak diketahui. */
  lastUpdated: string;
}

/** Asal sumber plugin; menentukan cara CLI memasang plugin. */
export type PluginSourceKind = "marketplace" | "url" | "git" | "command" | "lainnya";

/** Satu plugin di katalog marketplace. */
export interface MarketplacePlugin {
  /** Bentuk "nama@marketplace"; sama dengan id plugin terpasang. */
  id: string;
  name: string;
  displayName: string;
  marketplace: string;
  description: string;
  author: string;
  category: string;
  homepage: string;
  version: string;
  tags: string[];
  sourceKind: PluginSourceKind;
  /** Sudah terpasang di Claude Code pengguna. */
  installed: boolean;
}

/** Opsi pencarian katalog. */
export interface MarketplaceSearchOptions {
  /** Dicocokkan ke nama, displayName, deskripsi, dan tags; tak peka huruf. */
  query?: string;
  /** Batasi ke satu marketplace. */
  marketplace?: string;
  /** Batasi ke satu kategori. */
  category?: string;
  /** Jumlah hasil; bawaan 50, maks 100. */
  limit?: number;
  /** Jumlah hasil yang dilewati; bawaan 0. */
  offset?: number;
}

/** Hasil pencarian katalog. */
export interface MarketplaceSearchResult {
  items: MarketplacePlugin[];
  /** Jumlah plugin yang cocok sebelum `limit`/`offset` dipotong. */
  total: number;
  /** Kategori yang tersedia pada cakupan marketplace terpilih. */
  categories: string[];
}

export const MAX_MARKETPLACES = 20;
export const MAX_MARKETPLACE_PLUGINS = 2000;
export const MAX_MARKETPLACE_FILE_BYTES = 4 * 1024 * 1024;
export const MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const MARKETPLACE_PLUGIN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_PLUGIN_DESCRIPTION_LENGTH = 500;
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

/** Folder plugin Claude Code: `<home>/.claude/plugins`. */
export function pluginsRoot(home: string | undefined): string {
  return join(homeDir(home), ".claude", "plugins");
}

function realOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True bila `target` berada di bawah `root` setelah realpath.
 *
 * Marketplace dari luar folder plugin pengguna diabaikan supaya katalog
 * asing tak bisa masuk lewat `known_marketplaces.json`.
 */
function isInside(root: string, target: string): boolean {
  const rootReal = realOrResolve(root);
  const targetReal = realOrResolve(target);
  if (targetReal === rootReal) return true;
  return targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`);
}

/** Nama plugin dari katalog; entri tanpa nama valid dilewati. */
function pluginNameOf(entry: Record<string, unknown>): string {
  const value = entry.name;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!MARKETPLACE_PLUGIN_NAME_PATTERN.test(trimmed)) return "";
  return trimmed;
}

/** `author` boleh berupa string atau objek `{ name }`. */
function authorOf(entry: Record<string, unknown>): string {
  const value = entry.author;
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.name === "string") return value.name.trim();
  return "";
}

function textOf(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Tags plugin; hanya string yang dipakai. */
function tagsOf(entry: Record<string, unknown>): string[] {
  const value = entry.tags;
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    if (!result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

/**
 * Asal sumber plugin.
 *
 * String berarti path relatif di dalam repo marketplace; objek menyimpan
 * jenis sumber di bidang `source`.
 */
export function pluginSourceKind(source: unknown): PluginSourceKind {
  if (typeof source === "string") return "marketplace";
  if (!isRecord(source)) return "lainnya";
  const kind = source.source;
  if (typeof kind !== "string") return "lainnya";
  if (kind === "url") return "url";
  if (kind === "git" || kind === "git-subdir") return "git";
  if (kind === "command") return "command";
  return "lainnya";
}

/** Satu plugin katalog tanpa info pemasangan. */
interface CatalogPlugin {
  name: string;
  displayName: string;
  description: string;
  author: string;
  category: string;
  homepage: string;
  version: string;
  tags: string[];
  sourceKind: PluginSourceKind;
}

/** Katalog satu marketplace. */
interface Catalog {
  description: string;
  plugins: CatalogPlugin[];
}

interface CatalogSlot {
  key: string;
  catalog: Catalog;
}

/**
 * Cache katalog per berkas.
 *
 * Kunci memakai mtime+size berkas, jadi berkas yang berubah dibaca ulang
 * sementara berkas yang sama tak di-parse ulang tiap pencarian.
 */
const catalogCache = new Map<string, CatalogSlot>();

/** Baca dan normalkan satu berkas `marketplace.json`; `undefined` bila tak dipakai. */
function readCatalogFile(path: string): Catalog | undefined {
  let size: number;
  let mtimeMs: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return undefined;
  }
  if (size > MAX_MARKETPLACE_FILE_BYTES) return undefined;

  const key = `${mtimeMs}:${size}`;
  const slot = catalogCache.get(path);
  if (slot !== undefined && slot.key === key) return slot.catalog;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const plugins: CatalogPlugin[] = [];
  const entries = parsed.plugins;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (plugins.length >= MAX_MARKETPLACE_PLUGINS) break;
      if (!isRecord(entry)) continue;
      const name = pluginNameOf(entry);
      if (name === "") continue;
      const description = textOf(entry, "description");
      const displayName = textOf(entry, "displayName");
      plugins.push({
        name,
        displayName: displayName === "" ? name : displayName,
        description:
          description.length > MAX_PLUGIN_DESCRIPTION_LENGTH
            ? description.slice(0, MAX_PLUGIN_DESCRIPTION_LENGTH)
            : description,
        author: authorOf(entry),
        category: textOf(entry, "category"),
        homepage: textOf(entry, "homepage"),
        version: textOf(entry, "version"),
        tags: tagsOf(entry),
        sourceKind: pluginSourceKind(entry.source),
      });
    }
  }

  const catalog: Catalog = { description: textOf(parsed, "description"), plugins };
  catalogCache.set(path, { key, catalog });
  return catalog;
}

/** Satu marketplace yang lolos validasi. */
interface LoadedMarketplace {
  info: MarketplaceInfo;
  plugins: CatalogPlugin[];
}

/**
 * Baca `known_marketplaces.json`.
 *
 * Berkas tak ada, rusak, atau nama marketplace tak valid menghasilkan daftar
 * kosong tanpa melempar galat.
 */
function readKnownMarketplaces(home: string): Map<string, { installLocation: string; lastUpdated: string }> {
  const result = new Map<string, { installLocation: string; lastUpdated: string }>();
  const path = join(pluginsRoot(home), "known_marketplaces.json");
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return result;
  }
  if (size > MAX_MARKETPLACE_FILE_BYTES) return result;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!isRecord(parsed)) return result;
  for (const [name, value] of Object.entries(parsed)) {
    if (!MARKETPLACE_NAME_PATTERN.test(name)) continue;
    if (!isRecord(value)) continue;
    const installLocation = value.installLocation;
    if (typeof installLocation !== "string" || installLocation.trim() === "") continue;
    const lastUpdated = value.lastUpdated;
    result.set(name, {
      installLocation,
      lastUpdated: typeof lastUpdated === "string" ? lastUpdated : "",
    });
  }
  return result;
}

/**
 * Marketplace yang bisa dibaca Jejak.
 *
 * Marketplace diabaikan bila nama tak valid, lokasi pemasangan di luar
 * `~/.claude/plugins`, atau berkasnya rusak.
 */
function loadMarketplaces(home: string | undefined): LoadedMarketplace[] {
  const root = pluginsRoot(home);
  const known = readKnownMarketplaces(homeDir(home));
  const loaded: LoadedMarketplace[] = [];
  for (const name of [...known.keys()].sort()) {
    if (loaded.length >= MAX_MARKETPLACES) break;
    const entry = known.get(name);
    if (entry === undefined) continue;
    if (!isInside(root, entry.installLocation)) continue;
    const catalog = readCatalogFile(
      join(entry.installLocation, ".claude-plugin", "marketplace.json"),
    );
    if (catalog === undefined) continue;
    loaded.push({
      info: {
        name,
        description: catalog.description,
        pluginCount: catalog.plugins.length,
        lastUpdated: entry.lastUpdated,
      },
      plugins: catalog.plugins,
    });
  }
  return loaded;
}

/**
 * Daftar marketplace yang sudah dikonfigurasi; terurut menurut nama.
 *
 * Pembacaan hanya satu arah (read-only) dan tak pernah melempar galat.
 */
export function listMarketplaces(home?: string): MarketplaceInfo[] {
  return loadMarketplaces(home).map((item) => item.info);
}

/** Plugin marketplace sebagai objek lengkap (dengan status terpasang). */
function toPlugin(
  plugin: CatalogPlugin,
  marketplace: string,
  installed: Set<string>,
): MarketplacePlugin {
  const id = `${plugin.name}@${marketplace}`;
  return {
    id,
    name: plugin.name,
    displayName: plugin.displayName,
    marketplace,
    description: plugin.description,
    author: plugin.author,
    category: plugin.category,
    homepage: plugin.homepage,
    version: plugin.version,
    tags: plugin.tags,
    sourceKind: plugin.sourceKind,
    installed: installed.has(id),
  };
}

/** Semua plugin dari seluruh marketplace yang terbaca. */
function allPlugins(home: string | undefined): MarketplacePlugin[] {
  const installed = new Set(listInstalledPlugins(home).map((item) => item.id));
  const result: MarketplacePlugin[] = [];
  for (const marketplace of loadMarketplaces(home)) {
    for (const plugin of marketplace.plugins) {
      result.push(toPlugin(plugin, marketplace.info.name, installed));
    }
  }
  return result;
}

function matchesQuery(plugin: MarketplacePlugin, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  if (plugin.name.toLowerCase().includes(needle)) return true;
  if (plugin.displayName.toLowerCase().includes(needle)) return true;
  if (plugin.description.toLowerCase().includes(needle)) return true;
  for (const tag of plugin.tags) {
    if (tag.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Cari plugin di katalog marketplace.
 *
 * `id` berbentuk "nama@marketplace". `undefined` bila tak ada di katalog.
 */
export function findMarketplacePlugin(
  home: string | undefined,
  id: string,
): MarketplacePlugin | undefined {
  const separator = id.indexOf("@");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  const name = id.slice(0, separator);
  const marketplace = id.slice(separator + 1);
  const plugins = allPlugins(home).filter(
    (item) => item.marketplace === marketplace && item.name === name,
  );
  return plugins[0];
}

/**
 * Cari plugin di katalog marketplace.
 *
 * Pencarian tak peka huruf pada nama, displayName, deskripsi, dan tags.
 * Hasil terurut menurut nama; `total` menghitung semua hasil sebelum
 * `limit` dan `offset` dipotong. `categories` berisi kategori yang tersedia
 * pada marketplace terpilih.
 */
export function searchMarketplacePlugins(
  home: string | undefined,
  options: MarketplaceSearchOptions = {},
): MarketplaceSearchResult {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT,
  );
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const marketplace = options.marketplace?.trim() ?? "";
  const category = options.category?.trim().toLowerCase() ?? "";

  let pool = allPlugins(home);
  if (marketplace !== "") {
    pool = pool.filter((item) => item.marketplace === marketplace);
  }

  const categories: string[] = [];
  for (const item of pool) {
    if (item.category === "") continue;
    if (categories.includes(item.category)) continue;
    categories.push(item.category);
  }
  categories.sort();

  if (category !== "") {
    pool = pool.filter((item) => item.category.toLowerCase() === category);
  }
  const query = options.query ?? "";
  if (query.trim() !== "") {
    pool = pool.filter((item) => matchesQuery(item, query));
  }
  pool.sort((kiri, kanan) => {
    if (kiri.name < kanan.name) return -1;
    if (kiri.name > kanan.name) return 1;
    if (kiri.marketplace < kanan.marketplace) return -1;
    if (kiri.marketplace > kanan.marketplace) return 1;
    return 0;
  });

  return {
    items: pool.slice(offset, offset + limit),
    total: pool.length,
    categories,
  };
}
