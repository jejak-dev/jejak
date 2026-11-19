import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { DesignError, assemblePage } from "./assemble";
import { resolveDesignDir } from "./manifest";
import { ZipError, buildZip } from "./zip";

/** Batas isi folder design/ saat di-zip. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
/** Kedalaman folder di dalam design/ yang masih ikut di-zip. */
const MAX_DEPTH = 6;

/** Meta CSP yang disisipkan rakitan frame; berkas ekspor tak memerlukannya. */
const CSP_META_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/;

/** Hasil ekspor satu halaman menjadi berkas HTML mandiri. */
export interface StandaloneExport {
  filename: string;
  html: string;
}

/** Hasil ekspor folder `design/` menjadi satu arsip ZIP. */
export interface DesignZipExport {
  filename: string;
  data: Uint8Array;
  /** Jumlah berkas yang ikut di dalam arsip. */
  files: number;
  /** Jumlah berkas yang dilewati (tersembunyi, symlink, terlalu besar). */
  skipped: number;
}

/** True bila `target` berada di dalam `dir`. */
function isInside(dir: string, target: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix);
}

/**
 * Merakit satu halaman menjadi berkas HTML yang berdiri sendiri: CSS dan aset
 * sudah di-inline, tanpa skrip runtime frame dan tanpa meta CSP ketat.
 */
export async function exportStandalonePage(
  root: string,
  slug: string,
): Promise<StandaloneExport> {
  const page = await assemblePage(root, slug, { runtime: false });
  // Hanya meta yang disisipkan rakitan yang dibuang (occurrences pertama).
  const html = page.html.replace(CSP_META_RE, "");
  return { filename: `${slug}.html`, html };
}

interface CollectedFile {
  name: string;
  data: Uint8Array;
}

/**
 * Mengumpulkan isi folder `design/` secara rekursif. Symlink, berkas
 * non-biasa, dan entri tersembunyi dilewati; berkas terlalu besar dilewati
 * dan dihitung. Semua jalur relatif dan tetap di dalam `design/`.
 */
async function collectFiles(
  designDir: string,
): Promise<{ files: CollectedFile[]; skipped: number }> {
  const files: CollectedFile[] = [];
  let skipped = 0;
  let total = 0;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (files.length >= MAX_FILES) {
        skipped += 1;
        continue;
      }
      // Entri tersembunyi (dotfile) tak ikut diekspor.
      if (dirent.name.startsWith(".")) {
        skipped += 1;
        continue;
      }
      // Symlink tak pernah diikuti.
      if (dirent.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) await walk(path, childRel, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        skipped += 1;
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        skipped += 1;
        continue;
      }
      // Pastikan berkas benar-benar berada di dalam design/.
      let real: string;
      try {
        real = await realpath(path);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isInside(designDir, real)) {
        skipped += 1;
        continue;
      }
      let info;
      try {
        info = await lstat(path);
      } catch {
        skipped += 1;
        continue;
      }
      if (!info.isFile()) {
        skipped += 1;
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      if (total + info.size > MAX_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch {
        skipped += 1;
        continue;
      }
      total += data.length;
      files.push({ name: childRel, data: new Uint8Array(data) });
    }
  };

  await walk(designDir, "", 0);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, skipped };
}

/**
 * Mengekspor seluruh isi folder `design/` sebagai satu arsip ZIP. Urut entri
 * alfabet agar keluarannya deterministik. Tanpa folder `design/` hasilnya
 * galat 404.
 */
export async function exportDesignZip(root: string): Promise<DesignZipExport> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignError("Folder desain tidak ditemukan.", 404);
  }
  const { files, skipped } = await collectFiles(designDir);
  let data: Uint8Array;
  try {
    data = buildZip(files);
  } catch (error) {
    if (error instanceof ZipError) throw new DesignError(error.message, 400);
    throw error;
  }
  return { filename: "design.zip", data, files: files.length, skipped };
}
