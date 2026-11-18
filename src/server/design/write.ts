import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEVICES, MAX_PAGES, SLUG_RE, resolveDesignDir, type DeviceId } from "./manifest";

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
}

function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEVICES, value);
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
    updated += 1;
  }

  const text = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = join(designDir, `.jejak-design-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, { mode });
    await rename(tempPath, join(designDir, "design.json"));
  } catch {
    await rm(tempPath, { force: true });
    throw new DesignWriteError("Tata letak desain tidak dapat disimpan.", 400);
  }
  return { pages: updated };
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
