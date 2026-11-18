import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FileError, resolveInside } from "../files/path";

/** Slug halaman: huruf kecil, angka, tanda hubung; 1..63 karakter. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_PAGES = 50;
export const MAX_PAGE_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_COORD = 100000;
const MAX_ROUTE_LENGTH = 100;
const META_HEAD_BYTES = 4 * 1024;
const STAMP_MAX_FILES = 500;
const STAMP_MAX_DEPTH = 3;
const GAP = 80;

export type DeviceId = "desktop" | "tablet" | "mobile" | "mobile-android";

export const DEVICES: Record<DeviceId, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
  "mobile-android": { width: 412, height: 915 },
};

export interface DesignPage {
  slug: string;
  title: string;
  route?: string;
  device: DeviceId;
  x: number;
  y: number;
  mtime: number;
  missing: boolean;
  tooLarge: boolean;
}

/** Entri manifest setelah validasi; belum digabung dengan berkas di disk. */
export interface DesignManifestPage {
  slug: string;
  title: string;
  route?: string;
  device: DeviceId;
  x: number;
  y: number;
}

export interface ParsedManifest {
  pages: DesignManifestPage[];
  warnings: string[];
  error?: string;
}

export interface DesignResult {
  exists: boolean;
  pages: DesignPage[];
  tokens: { mtime: number | null };
  manifestError?: string;
  warnings: string[];
}

function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEVICES, value);
}

const META_TAG_RE = /<meta\b[^>]*\bname\s*=\s*["']jejak:device["'][^>]*>/i;
const META_CONTENT_RE = /\bcontent\s*=\s*["']([^"']*)["']/i;

/** Membaca perangkat dari `<meta name="jejak:device" content="...">` di awal berkas. */
export function deviceFromMeta(head: string): DeviceId | undefined {
  const tag = META_TAG_RE.exec(head);
  if (tag === null) return undefined;
  const content = META_CONTENT_RE.exec(tag[0]);
  if (content === null) return undefined;
  const value = content[1]?.trim();
  return isDeviceId(value) ? value : undefined;
}

function clampCoord(value: number): number {
  return Math.max(-MAX_COORD, Math.min(MAX_COORD, value));
}

function coord(
  value: unknown,
  slug: string,
  axis: "x" | "y",
  warnings: string[],
): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Halaman "${slug}": posisi ${axis} tidak valid, memakai 0.`);
    return 0;
  }
  if (value < -MAX_COORD || value > MAX_COORD) {
    warnings.push(`Halaman "${slug}": posisi ${axis} dijepit ke batas ${MAX_COORD}.`);
    return clampCoord(value);
  }
  return value;
}

/**
 * Memvalidasi isi `design.json` yang sudah di-parse. Entri bermasalah dibuang
 * atau diperbaiki; setiap masalah dicatat sebagai satu kalimat di `warnings`.
 */
export function parseManifest(raw: unknown): ParsedManifest {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { pages: [], warnings, error: "design.json tidak valid: isi harus berupa objek." };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    return { pages: [], warnings, error: "design.json tidak valid: versi harus 1." };
  }
  const list = record.pages;
  if (!Array.isArray(list)) {
    return { pages: [], warnings, error: "design.json tidak valid: pages harus berupa daftar." };
  }

  const pages: DesignManifestPage[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push("Entri halaman dilewati: bukan objek.");
      continue;
    }
    const item = entry as Record<string, unknown>;
    const slug = item.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      warnings.push("Entri halaman dilewati: slug tidak valid.");
      continue;
    }
    if (seen.has(slug)) {
      warnings.push(`Halaman "${slug}" dilewati: slug ganda.`);
      continue;
    }
    seen.add(slug);

    let title = slug;
    if (item.title !== undefined) {
      if (typeof item.title === "string" && item.title.trim() !== "") {
        title = item.title.trim();
      } else {
        warnings.push(`Halaman "${slug}": judul bukan teks, memakai slug.`);
      }
    }

    let device: DeviceId = "desktop";
    if (item.device !== undefined) {
      if (isDeviceId(item.device)) {
        device = item.device;
      } else {
        warnings.push(`Halaman "${slug}": perangkat tidak dikenal, memakai desktop.`);
      }
    }

    const page: DesignManifestPage = {
      slug,
      title,
      device,
      x: coord(item.x, slug, "x", warnings),
      y: coord(item.y, slug, "y", warnings),
    };

    if (item.route !== undefined) {
      if (
        typeof item.route === "string" &&
        item.route.startsWith("/") &&
        item.route.length <= MAX_ROUTE_LENGTH
      ) {
        page.route = item.route;
      } else {
        warnings.push(`Halaman "${slug}": route diabaikan karena tidak valid.`);
      }
    }

    pages.push(page);
  }

  return { pages, warnings };
}

/** Posisi halaman baru: di kanan halaman paling kanan sebelumnya, dengan jarak. */
export function placeNext(
  pages: Array<{ x: number; y: number; device: DeviceId }>,
): { x: number; y: number } {
  if (pages.length === 0) return { x: 0, y: 0 };
  let right = -Infinity;
  for (const page of pages) {
    right = Math.max(right, page.x + DEVICES[page.device].width);
  }
  return { x: right + GAP, y: 0 };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Folder `design/` yang sudah di-realpath; undefined bila tidak ada atau keluar root. */
async function resolveDesignDir(root: string): Promise<string | undefined> {
  let resolved;
  try {
    resolved = await resolveInside(root, "design");
  } catch (error) {
    if (error instanceof FileError) return undefined;
    throw error;
  }
  return (await isDirectory(resolved.target)) ? resolved.target : undefined;
}

interface ManifestFile {
  present: boolean;
  raw?: unknown;
  error?: string;
}

async function readManifestFile(designDir: string): Promise<ManifestFile> {
  const path = join(designDir, "design.json");
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { present: false };
  }
  if (!info.isFile()) return { present: false };
  if (info.size > MAX_MANIFEST_BYTES) {
    return { present: true, error: "design.json tidak valid: berkas melebihi 256 KB." };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { present: true, error: "design.json tidak valid: berkas tidak dapat dibaca." };
  }
  try {
    return { present: true, raw: JSON.parse(text) };
  } catch {
    return { present: true, error: "design.json tidak valid: JSON rusak." };
  }
}

interface PageFile {
  slug: string;
  mtime: number;
  size: number;
}

async function scanPages(designDir: string): Promise<PageFile[]> {
  const pagesDir = join(designDir, "pages");
  if (!(await isDirectory(pagesDir))) return [];
  let dirents;
  try {
    dirents = await readdir(pagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: PageFile[] = [];
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink() || !dirent.isFile()) continue;
    if (!dirent.name.endsWith(".html")) continue;
    const slug = dirent.name.slice(0, -".html".length);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const info = await lstat(join(pagesDir, dirent.name));
      if (!info.isFile()) continue;
      files.push({ slug, mtime: Math.round(info.mtimeMs), size: info.size });
    } catch {
      // Berkas menghilang di antara readdir dan lstat; lewati.
    }
  }
  files.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return files;
}

async function readHead(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.alloc(META_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}

/**
 * Membaca model desain dari folder kerja: manifest, halaman di disk, dan
 * rekonsiliasi keduanya. Hanya baca; tidak pernah menulis berkas.
 */
export async function readDesign(root: string): Promise<DesignResult> {
  const warnings: string[] = [];
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    return { exists: false, pages: [], tokens: { mtime: null }, warnings };
  }

  const manifest = await readManifestFile(designDir);
  const pagesDir = join(designDir, "pages");
  const hasPagesDir = await isDirectory(pagesDir);
  if (!manifest.present && !hasPagesDir) {
    return { exists: false, pages: [], tokens: { mtime: null }, warnings };
  }

  const result: DesignResult = { exists: true, pages: [], tokens: { mtime: null }, warnings };
  if (manifest.error !== undefined) result.manifestError = manifest.error;

  const parsed: ParsedManifest =
    manifest.raw === undefined ? { pages: [], warnings: [] } : parseManifest(manifest.raw);
  warnings.push(...parsed.warnings);
  if (parsed.error !== undefined) result.manifestError = parsed.error;

  const pageFiles = await scanPages(designDir);
  const fileBySlug = new Map<string, PageFile>();
  for (const file of pageFiles) fileBySlug.set(file.slug, file);

  const pages: DesignPage[] = [];
  const used = new Set<string>();
  for (const entry of parsed.pages) {
    used.add(entry.slug);
    const file = fileBySlug.get(entry.slug);
    if (file === undefined) {
      pages.push({ ...entry, mtime: 0, missing: true, tooLarge: false });
      continue;
    }
    pages.push({
      ...entry,
      mtime: file.mtime,
      missing: false,
      tooLarge: file.size > MAX_PAGE_BYTES,
    });
  }

  for (const file of pageFiles) {
    if (used.has(file.slug)) continue;
    const head = await readHead(join(pagesDir, `${file.slug}.html`));
    const position = placeNext(pages);
    pages.push({
      slug: file.slug,
      title: file.slug,
      device: deviceFromMeta(head) ?? "desktop",
      x: position.x,
      y: position.y,
      mtime: file.mtime,
      missing: false,
      tooLarge: file.size > MAX_PAGE_BYTES,
    });
  }

  if (pages.length > MAX_PAGES) {
    warnings.push(`Daftar halaman dipotong ke ${MAX_PAGES} halaman.`);
    pages.length = MAX_PAGES;
  }
  result.pages = pages;

  try {
    const info = await lstat(join(designDir, "tokens.css"));
    if (info.isFile()) result.tokens.mtime = Math.round(info.mtimeMs);
  } catch {
    // tokens.css tidak ada.
  }

  return result;
}

interface StampFile {
  rel: string;
  mtimeMs: number;
  size: number;
}

async function collectStampFiles(
  dir: string,
  rel: string,
  depth: number,
  out: StampFile[],
): Promise<void> {
  if (out.length >= STAMP_MAX_FILES) return;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    if (out.length >= STAMP_MAX_FILES) return;
    if (dirent.isSymbolicLink()) continue;
    const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (depth < STAMP_MAX_DEPTH) {
        await collectStampFiles(join(dir, dirent.name), childRel, depth + 1, out);
      }
      continue;
    }
    if (!dirent.isFile()) continue;
    try {
      const info = await lstat(join(dir, dirent.name));
      if (!info.isFile()) continue;
      out.push({ rel: childRel, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Berkas menghilang di antara readdir dan lstat; lewati.
    }
  }
}

/**
 * Cap perubahan folder `design/`: sha1 dari daftar `path:mtime:size` terurut.
 * Tanpa folder `design/` hasilnya hash dari daftar kosong (nilai tetap).
 */
export async function designStamp(root: string): Promise<string> {
  const designDir = await resolveDesignDir(root);
  const files: StampFile[] = [];
  if (designDir !== undefined) {
    await collectStampFiles(designDir, "", 1, files);
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }
  const lines = files.map((file) => `${file.rel}:${file.mtimeMs}:${file.size}`);
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 12);
}
