import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVICES,
  GAP,
  MAX_GROUP_LENGTH,
  MAX_NOTE_TEXT,
  MAX_NOTES,
  MAX_PAGE_BYTES,
  MAX_PAGES,
  MAX_VARIANT_LENGTH,
  NOTE_ID_RE,
  SLUG_RE,
  resolveDesignDir,
  validLabel,
  type DesignNote,
  type DeviceId,
} from "./manifest";

/** Galat tulis desain dengan status HTTP yang sesuai. */
export class DesignWriteError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "DesignWriteError";
  }
}

const MAX_COORD = 100000;
const INVALID_MANIFEST = "design.json tidak valid; perbaiki dulu.";
const NOT_CREATED = "Desain belum dibuat.";

interface LayoutEntry {
  slug: string;
  x: number;
  y: number;
  device?: DeviceId;
  /** undefined = tak diubah; null = kunci dihapus; teks = nilai baru. */
  group?: string | null;
  variant?: string | null;
}

function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEVICES, value);
}

/**
 * Label kelompok atau varian pada entri tata letak: teks sah (dipangkas),
 * atau null untuk menghapus kuncinya. Nilai lain tidak sah -> 400.
 */
function labelInput(value: unknown, key: "group" | "variant", maxLength: number): string | null {
  if (value === null) return null;
  const label = validLabel(value, maxLength);
  if (label === undefined) {
    throw new DesignWriteError(`Label ${key} tidak valid.`, 400);
  }
  return label;
}

function coord(value: unknown, axis: "x" | "y"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DesignWriteError(`Posisi ${axis} harus berupa bilangan.`, 400);
  }
  return Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.round(value)));
}

/** Memvalidasi body `PUT layout`; kunci tak dikenal di entri diabaikan. */
function parseLayoutInput(input: unknown): LayoutEntry[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Body permintaan harus berupa objek.", 400);
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.pages)) {
    throw new DesignWriteError("Field pages harus berupa daftar.", 400);
  }
  if (record.pages.length > MAX_PAGES) {
    throw new DesignWriteError(`Daftar halaman melebihi batas ${MAX_PAGES}.`, 400);
  }
  const seen = new Set<string>();
  const entries: LayoutEntry[] = [];
  for (const raw of record.pages) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DesignWriteError("Entri halaman harus berupa objek.", 400);
    }
    const item = raw as Record<string, unknown>;
    const slug = item.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new DesignWriteError("Slug halaman tidak valid.", 400);
    }
    if (seen.has(slug)) {
      throw new DesignWriteError(`Slug halaman "${slug}" ganda.`, 400);
    }
    seen.add(slug);
    const entry: LayoutEntry = {
      slug,
      x: coord(item.x, "x"),
      y: coord(item.y, "y"),
    };
    if (item.device !== undefined) {
      if (!isDeviceId(item.device)) {
        throw new DesignWriteError("Perangkat tidak dikenal.", 400);
      }
      entry.device = item.device;
    }
    if (item.group !== undefined) {
      entry.group = labelInput(item.group, "group", MAX_GROUP_LENGTH);
    }
    if (item.variant !== undefined) {
      entry.variant = labelInput(item.variant, "variant", MAX_VARIANT_LENGTH);
    }
    entries.push(entry);
  }
  return entries;
}

interface ManifestForWrite {
  record: Record<string, unknown>;
  mode: number;
}

/** Membaca design.json yang sudah ada; tidak pernah menimpa isi rusak. */
async function readManifestForWrite(designDir: string): Promise<ManifestForWrite> {
  const path = join(designDir, "design.json");
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new DesignWriteError(NOT_CREATED, 404);
  }
  if (!info.isFile()) {
    throw new DesignWriteError(NOT_CREATED, 404);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DesignWriteError(INVALID_MANIFEST, 409);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DesignWriteError(INVALID_MANIFEST, 409);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DesignWriteError(INVALID_MANIFEST, 409);
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.pages)) {
    throw new DesignWriteError(INVALID_MANIFEST, 409);
  }
  return { record, mode: info.mode & 0o777 };
}

/**
 * Antrean penulisan manifest per folder desain: dua penulisan tak
 * saling menimpa berkas design.json.
 */
const manifestLocks = new Map<string, Promise<void>>();

function withManifestLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = manifestLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  manifestLocks.set(key, settled);
  void settled.then(() => {
    if (manifestLocks.get(key) === settled) manifestLocks.delete(key);
  });
  return run;
}

/** Menulis design.json secara atomik; mode berkas lama dipertahankan. */
async function writeManifestFile(
  designDir: string,
  record: Record<string, unknown>,
  mode: number,
  failureMessage: string,
): Promise<void> {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = join(designDir, `.jejak-design-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, { mode });
    await rename(tempPath, join(designDir, "design.json"));
  } catch {
    await rm(tempPath, { force: true });
    throw new DesignWriteError(failureMessage, 400);
  }
}

/**
 * Memperbarui posisi (dan perangkat) halaman yang sudah terdaftar di
 * `design/design.json`. Menggabung, bukan mengganti: kunci lain di entri
 * maupun di objek akar dipertahankan. Penulisan atomik lewat berkas sementara
 * di folder yang sama, mode berkas lama dipertahankan.
 */
export async function saveLayout(root: string, input: unknown): Promise<{ pages: number }> {
  const entries = parseLayoutInput(input);
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignWriteError(NOT_CREATED, 404);
  }
  return withManifestLock(designDir, async () => {
    const { record, mode } = await readManifestForWrite(designDir);
    const pages = record.pages as unknown[];
    const bySlug = new Map<string, Record<string, unknown>>();
    for (const item of pages) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.slug === "string") bySlug.set(entry.slug, entry);
    }

    let updated = 0;
    for (const entry of entries) {
      const target = bySlug.get(entry.slug);
      if (target === undefined) continue;
      target.x = entry.x;
      target.y = entry.y;
      if (entry.device !== undefined) target.device = entry.device;
      if (entry.group !== undefined) {
        if (entry.group === null) delete target.group;
        else target.group = entry.group;
      }
      if (entry.variant !== undefined) {
        if (entry.variant === null) delete target.variant;
        else target.variant = entry.variant;
      }
      updated += 1;
    }

    await writeManifestFile(designDir, record, mode, "Tata letak desain tidak dapat disimpan.");
    return { pages: updated };
  });
}

/** Karakter kontrol yang dilarang di teks catatan; baris baru tetap boleh. */
const NOTE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/** Teks catatan: string 0..500 tanpa karakter kontrol selain baris baru. */
function noteText(value: unknown): string {
  if (typeof value !== "string") {
    throw new DesignWriteError("Teks catatan harus berupa teks.", 400);
  }
  if (value.length > MAX_NOTE_TEXT) {
    throw new DesignWriteError(`Teks catatan melebihi ${MAX_NOTE_TEXT} karakter.`, 400);
  }
  if (NOTE_CONTROL_RE.test(value)) {
    throw new DesignWriteError("Teks catatan memuat karakter yang tak diizinkan.", 400);
  }
  return value;
}

/** Id catatan baru: "n_" + delapan digit heksadesimal yang belum dipakai. */
function newNoteId(taken: Set<string>): string {
  for (;;) {
    const id = `n_${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Memvalidasi masukan `saveNotes`: daftar catatan yang menggantikan seluruh
 * daftar lama. Entri tanpa `id` diberi id baru; entri tak sah ditolak 400.
 */
function parseNotesInput(input: unknown): DesignNote[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Body permintaan harus berupa objek.", 400);
  }
  const record = input as Record<string, unknown>;
  const list = record.notes;
  if (!Array.isArray(list)) {
    throw new DesignWriteError("Field notes harus berupa daftar.", 400);
  }
  if (list.length > MAX_NOTES) {
    throw new DesignWriteError(`Daftar catatan melebihi batas ${MAX_NOTES}.`, 400);
  }
  const notes: DesignNote[] = [];
  const taken = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DesignWriteError("Entri catatan harus berupa objek.", 400);
    }
    const item = raw as Record<string, unknown>;
    const note: DesignNote = {
      id: "",
      x: coord(item.x, "x"),
      y: coord(item.y, "y"),
      text: noteText(item.text),
    };
    if (item.id === undefined) {
      note.id = newNoteId(taken);
    } else {
      if (typeof item.id !== "string" || !NOTE_ID_RE.test(item.id)) {
        throw new DesignWriteError("Id catatan tidak valid.", 400);
      }
      if (taken.has(item.id)) {
        throw new DesignWriteError(`Id catatan "${item.id}" ganda.`, 400);
      }
      note.id = item.id;
    }
    taken.add(note.id);
    notes.push(note);
  }
  return notes;
}

/**
 * Mengganti seluruh daftar catatan di `design/design.json`. Kunci lain di
 * manifest (halaman, kelompok, dst.) dipertahankan; penulisan atomik lewat
 * berkas sementara di folder yang sama.
 */
export async function saveNotes(root: string, input: unknown): Promise<{ notes: DesignNote[] }> {
  const notes = parseNotesInput(input);
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignWriteError(NOT_CREATED, 404);
  }
  return withManifestLock(designDir, async () => {
    const { record, mode } = await readManifestForWrite(designDir);
    record.notes = notes;
    await writeManifestFile(designDir, record, mode, "Catatan desain tidak dapat disimpan.");
    return { notes };
  });
}

/** Bentuk masukan pembuatan varian. */
export interface VariantInput {
  slug: string;
  variant: string;
  group?: string;
}

/** Data halaman varian yang baru dibuat. */
export interface VariantPage {
  slug: string;
  title: string;
  x: number;
  y: number;
}

const MAX_VARIANT_ATTEMPTS = 20;
const MAX_SLUG_LENGTH = 63;
const SOURCE_MISSING = "Halaman sumber tidak ditemukan.";
const SOURCE_INVALID = "Berkas halaman sumber tidak valid.";
const VARIANT_CONFLICT = "Slug varian bertabrakan.";

/** Huruf kecil; semua karakter selain huruf/angka menjadi tanda hubung. */
function slugifyLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Susun slug varian: `<slug sumber>-<slug varian>`, muat dalam 63 karakter. */
function buildVariantSlug(sourceSlug: string, suffix: string, attempt: number): string {
  const tail = attempt === 1 ? suffix : `${suffix}-${attempt}`;
  const maxBase = MAX_SLUG_LENGTH - tail.length - 1;
  const base = sourceSlug.length > maxBase ? sourceSlug.slice(0, maxBase).replace(/-+$/, "") : sourceSlug;
  return `${base}-${tail}`;
}

/** Persegi panjang halaman: posisi dan ukuran menurut perangkat. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Kotak halaman dari entri manifest; nilai tak sah dianggap 0/desktop. */
function rectOf(entry: Record<string, unknown>): Rect {
  const device = isDeviceId(entry.device) ? entry.device : "desktop";
  const x = typeof entry.x === "number" && Number.isFinite(entry.x) ? entry.x : 0;
  const y = typeof entry.y === "number" && Number.isFinite(entry.y) ? entry.y : 0;
  return { x, y, width: DEVICES[device].width, height: DEVICES[device].height };
}

/** Slug sudah terpakai bila ada di manifest atau berkas halaman. */
async function slugTaken(
  pages: unknown[],
  pagesDir: string,
  candidate: string,
): Promise<boolean> {
  for (const item of pages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    if ((item as Record<string, unknown>).slug === candidate) return true;
  }
  try {
    await lstat(join(pagesDir, `${candidate}.html`));
    return true;
  } catch {
    return false;
  }
}

/** Menulis berkas halaman baru secara eksklusif: berkas lama tak ditimpa. */
async function writeVariantFile(
  pagesDir: string,
  slug: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const target = join(pagesDir, `${slug}.html`);
  const tempPath = join(pagesDir, `.jejak-variant-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode });
    await chmod(tempPath, mode);
    try {
      // link gagal bila target sudah ada: berkas lama tak pernah ditimpa.
      await link(tempPath, target);
    } catch (error) {
      if (isEexist(error)) throw new DesignWriteError("Berkas varian sudah ada.", 409);
      // Filesystem tanpa hardlink: tulis eksklusif langsung ke target.
      await writeFile(target, content, { flag: "wx", mode });
    }
  } catch (error) {
    if (error instanceof DesignWriteError) throw error;
    throw new DesignWriteError("Berkas varian tidak dapat dibuat.", 400);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Membuat varian baru dari halaman sumber: berkas HTML disalin, entri
 * manifest ditambah, dan kelompok halaman sumber disetel bila belum punya.
 * Slug baru dihindari bentrok dengan pola `-2`, `-3`, dan seterusnya.
 */
export async function createVariant(root: string, input: VariantInput): Promise<VariantPage> {
  if (typeof input !== "object" || input === null) {
    throw new DesignWriteError("Permintaan tidak valid.", 400);
  }
  const slug = input.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new DesignWriteError("Slug halaman tidak valid.", 400);
  }
  const variant = validLabel(input.variant, MAX_VARIANT_LENGTH);
  if (variant === undefined) {
    throw new DesignWriteError("Label variant tidak valid.", 400);
  }
  let groupInput: string | undefined;
  if (input.group !== undefined) {
    const parsed = validLabel(input.group, MAX_GROUP_LENGTH);
    if (parsed === undefined) {
      throw new DesignWriteError("Label group tidak valid.", 400);
    }
    groupInput = parsed;
  }

  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignWriteError(NOT_CREATED, 404);
  }

  return withManifestLock(designDir, async () => {
    const { record, mode } = await readManifestForWrite(designDir);
    const pages = record.pages as unknown[];
    if (pages.length >= MAX_PAGES) {
      throw new DesignWriteError("Batas halaman tercapai.", 400);
    }

    let source: Record<string, unknown> | undefined;
    for (const item of pages) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.slug === slug) {
        source = entry;
        break;
      }
    }
    if (source === undefined) {
      throw new DesignWriteError(SOURCE_MISSING, 404);
    }

    const pagesDir = join(designDir, "pages");
    let pagesInfo;
    try {
      pagesInfo = await lstat(pagesDir);
    } catch {
      pagesInfo = undefined;
    }
    if (pagesInfo === undefined || pagesInfo.isSymbolicLink() || !pagesInfo.isDirectory()) {
      throw new DesignWriteError(SOURCE_MISSING, 404);
    }

    const sourcePath = join(pagesDir, `${slug}.html`);
    let sourceInfo;
    try {
      sourceInfo = await lstat(sourcePath);
    } catch {
      sourceInfo = undefined;
    }
    if (sourceInfo === undefined) {
      throw new DesignWriteError(SOURCE_MISSING, 404);
    }
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
      throw new DesignWriteError(SOURCE_INVALID, 400);
    }
    if (sourceInfo.size > MAX_PAGE_BYTES) {
      throw new DesignWriteError("Halaman melebihi 512 KB.", 400);
    }

    let content: Buffer;
    try {
      content = await readFile(sourcePath);
    } catch {
      throw new DesignWriteError(SOURCE_INVALID, 400);
    }

    const suffix = slugifyLabel(variant) || "varian";
    let newSlug = "";
    for (let attempt = 1; attempt <= MAX_VARIANT_ATTEMPTS; attempt += 1) {
      const candidate = buildVariantSlug(slug, suffix, attempt);
      if (!SLUG_RE.test(candidate)) continue;
      if (await slugTaken(pages, pagesDir, candidate)) continue;
      newSlug = candidate;
      break;
    }
    if (newSlug === "") {
      throw new DesignWriteError(VARIANT_CONFLICT, 409);
    }

    const sourceDevice = isDeviceId(source.device) ? source.device : "desktop";
    const sourceTitle =
      typeof source.title === "string" && source.title.trim() !== ""
        ? source.title.trim()
        : slug;
    const sourceGroup = validLabel(source.group, MAX_GROUP_LENGTH);
    const groupLabel = groupInput ?? sourceGroup ?? sourceTitle;

    const sourceRect = rectOf(source);
    let x = sourceRect.x + sourceRect.width + GAP;
    const y = sourceRect.y;
    for (let step = 0; step < 20; step += 1) {
      const candidate: Rect = { x, y, width: sourceRect.width, height: sourceRect.height };
      const bentrok = pages.some((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
        const entry = item as Record<string, unknown>;
        if (entry.slug === newSlug) return false;
        return rectsOverlap(candidate, rectOf(entry));
      });
      if (!bentrok) break;
      x += sourceRect.width + GAP;
    }

    const entry: Record<string, unknown> = {
      slug: newSlug,
      title: `${sourceTitle} (${variant})`,
      device: sourceDevice,
      x,
      y,
      variant,
      group: groupLabel,
    };
    pages.push(entry);
    if (sourceGroup === undefined) source.group = groupLabel;

    try {
      await writeVariantFile(pagesDir, newSlug, content, 0o644);
    } catch (error) {
      pages.pop();
      throw error;
    }
    try {
      await writeManifestFile(designDir, record, mode, "Varian desain tidak dapat disimpan.");
    } catch (error) {
      pages.pop();
      await rm(join(pagesDir, `${newSlug}.html`), { force: true });
      throw error;
    }

    return { slug: newSlug, title: entry.title as string, x, y };
  });
}

const TOKENS_CSS = `:root {
  --warna-latar: #f7f7f8;
  --warna-permukaan: #ffffff;
  --warna-teks: #1c1c1e;
  --warna-teks-redup: #6b6b70;
  --warna-aksen: #2f6fed;
  --warna-garis: #d9d9de;
  --radius: 10px;
  --jarak: 16px;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
`;

const CONTOH_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="jejak:device" content="desktop">
  <title>Contoh</title>
  <link rel="stylesheet" href="../tokens.css">
  <style>
    body {
      margin: 0;
      background: var(--warna-latar);
      color: var(--warna-teks);
      font-family: var(--font-sans);
    }
    .halaman {
      padding: var(--jarak);
    }
    button {
      background: var(--warna-aksen);
      color: var(--warna-permukaan);
      border: 0;
      border-radius: var(--radius);
      padding: 8px 16px;
      font: inherit;
    }
  </style>
</head>
<body>
  <main class="halaman">
    <h1>Contoh</h1>
    <p>Halaman contoh untuk memulai desain.</p>
    <button type="button">Tombol contoh</button>
  </main>
</body>
</html>
`;

const DESIGN_MD = `# Aturan Desain

Folder ini berisi desain yang dirakit Jejak menjadi frame di kanvas.

## Berkas

- Satu dokumen HTML per halaman di \`design/pages/<slug>.html\`.
- Daftarkan setiap halaman di \`design/design.json\` dengan kunci \`slug\`, \`title\`, \`device\`, \`x\`, dan \`y\`.
- Beri jarak antar frame (mis. 80 px) agar tidak bertumpuk.
- Aset gambar dan font lokal disimpan di \`design/assets/\`.

## Perangkat

| Device | Ukuran |
| --- | --- |
| desktop | 1440x900 |
| tablet | 1024x768 |
| mobile | 390x844 |
| mobile-android | 412x915 |

Web dan mobile dirancang sebagai halaman terpisah.

## Gaya

- Gunakan token lewat variabel CSS dari \`../tokens.css\`.
- Tanpa CDN, font, atau ikon luar (diblokir CSP). Ikon memakai SVG inline.
- Gambar relatif png/jpg/webp/gif atau data URI; font woff2 lokal.
- Tanpa jaringan dari dalam halaman.
- Tautan antarhalaman memakai \`#/rute\`.

## Mengubah desain yang sudah ada

- Untuk perubahan terarah pakai \`design_patch\` (satu elemen per panggilan), bukan menulis ulang halaman.
- Selalu sertakan \`baseMtime\` dari pembacaan terakhir; bila berkas berubah, baca ulang lalu ulangi.
- Periksa hasilnya dengan \`design_screenshot\` bila kanvas terbuka di Jejak.
- Baca komentar terbuka dengan \`design_comments\`, kerjakan, lalu tandai selesai dengan \`design_comment_resolve\`.

## Token awal

| Nama | Arti |
| --- | --- |
| \`--warna-latar\` | Latar halaman |
| \`--warna-permukaan\` | Latar kartu/permukaan |
| \`--warna-teks\` | Warna teks utama |
| \`--warna-teks-redup\` | Teks sekunder |
| \`--warna-aksen\` | Warna aksi utama |
| \`--warna-garis\` | Garis pemisah |
| \`--radius\` | Sudut membulat |
| \`--jarak\` | Jarak dasar |
| \`--font-sans\` | Keluarga font sans |
`;

const INIT_FILES: Array<{ path: string; content: string }> = [
  {
    path: "design.json",
    content: `${JSON.stringify(
      {
        version: 1,
        pages: [{ slug: "contoh", title: "Contoh", device: "desktop", x: 0, y: 0 }],
      },
      null,
      2,
    )}\n`,
  },
  { path: "tokens.css", content: TOKENS_CSS },
  { path: "pages/contoh.html", content: CONTOH_HTML },
  { path: "DESIGN.md", content: DESIGN_MD },
];

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

const MAX_GITIGNORE_BYTES = 256 * 1024;
const DESIGN_IGNORE_LINES = new Set(["design/", "/design/", "design", "/design"]);

function ignoresDesign(line: string): boolean {
  return DESIGN_IGNORE_LINES.has(line.trim());
}

/**
 * Menambahkan `design/` ke `.gitignore` bila root adalah repo git dan entri
 * itu belum ada. Mengembalikan true bila `.gitignore` dibuat atau diubah.
 * Semua kegagalan (bukan repo, berkas aneh, gagal tulis) diam saja.
 */
async function ensureDesignIgnored(root: string): Promise<boolean> {
  try {
    let gitInfo;
    try {
      gitInfo = await lstat(join(root, ".git"));
    } catch {
      return false;
    }
    if (!gitInfo.isDirectory() && !gitInfo.isFile()) return false;

    const ignorePath = join(root, ".gitignore");
    let ignoreInfo;
    try {
      ignoreInfo = await lstat(ignorePath);
    } catch {
      ignoreInfo = undefined;
    }
    // Symlink (atau apa pun selain berkas biasa) dilewati: jangan menulis lewatnya.
    if (ignoreInfo !== undefined && !ignoreInfo.isFile()) return false;

    let text = "";
    let mode: number | undefined;
    if (ignoreInfo !== undefined) {
      if (ignoreInfo.size > MAX_GITIGNORE_BYTES) return false;
      text = await readFile(ignorePath, "utf8");
      mode = ignoreInfo.mode & 0o777;
    }
    if (text.split(/\r?\n/).some(ignoresDesign)) return false;

    const next = text === "" || text.endsWith("\n") ? `${text}design/\n` : `${text}\ndesign/\n`;
    const tempPath = join(root, `.jejak-gitignore-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, next, mode === undefined ? {} : { mode });
      await rename(tempPath, ignorePath);
    } catch {
      await rm(tempPath, { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Membuat perancah `design/` bila belum ada. Tidak pernah menimpa berkas yang
 * sudah ada: berkas yang sudah ada dilewati dan hanya yang belum dibuat.
 * Kecuali `tracked: true`, folder `design/` diabaikan lewat `.gitignore`.
 */
export async function initDesign(
  root: string,
  options: { tracked?: boolean } = {},
): Promise<{ created: string[] }> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new DesignWriteError("Folder kerja tidak ditemukan.", 400);
  }

  const designPath = join(realRoot, "design");
  let designInfo;
  try {
    designInfo = await lstat(designPath);
  } catch {
    designInfo = undefined;
  }
  if (designInfo !== undefined && (designInfo.isSymbolicLink() || !designInfo.isDirectory())) {
    throw new DesignWriteError("Folder design tidak valid.", 400);
  }

  let manifestInfo;
  try {
    manifestInfo = await lstat(join(designPath, "design.json"));
  } catch {
    manifestInfo = undefined;
  }
  if (manifestInfo !== undefined) {
    throw new DesignWriteError("Desain sudah ada.", 409);
  }

  try {
    await mkdir(join(designPath, "pages"), { recursive: true });
    await mkdir(join(designPath, "assets"), { recursive: true });
  } catch {
    throw new DesignWriteError("Perancah desain tidak dapat dibuat.", 400);
  }

  // Subfolder yang sudah ada tidak boleh berupa symlink (bisa menunjuk keluar repo).
  for (const sub of ["pages", "assets"]) {
    let info;
    try {
      info = await lstat(join(designPath, sub));
    } catch {
      throw new DesignWriteError("Perancah desain tidak dapat dibuat.", 400);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DesignWriteError("Folder design tidak valid.", 400);
    }
  }

  const created: string[] = [];
  for (const file of INIT_FILES) {
    try {
      await writeFile(join(designPath, file.path), file.content, { flag: "wx" });
      created.push(`design/${file.path}`);
    } catch (error) {
      if (isEexist(error)) continue;
      throw new DesignWriteError("Perancah desain tidak dapat dibuat.", 400);
    }
  }

  // Terakhir: pastikan folder diabaikan git kecuali pengguna memilih ikut git.
  if (options.tracked !== true) {
    if (await ensureDesignIgnored(realRoot)) created.push(".gitignore");
  }
  return { created };
}
