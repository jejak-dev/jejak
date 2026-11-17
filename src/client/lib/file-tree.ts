import type { DirEntry } from "./api";
import { joinPath } from "./files";

export const MARKDOWN_EXT = [".md", ".markdown", ".mdx"];

/** Apakah path berakhiran ekstensi markdown (tanpa peduli kapital). */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXT.some((ext) => lower.endsWith(ext));
}

/** Folder leluhur dari path, akar "" selalu pertama. "a/b/c.ts" -> ["", "a", "a/b"]. */
export function ancestorDirs(path: string): string[] {
  const dirs = [""];
  const segments = path.split("/");
  segments.pop();
  let current = "";
  for (const segment of segments) {
    if (segment === "") continue;
    current = current === "" ? segment : `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  const aRank = a.type === "dir" ? 0 : 1;
  const bRank = b.type === "dir" ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (folded !== 0) return folded;
  return a.name.localeCompare(b.name);
}

function walk(
  listings: Readonly<Record<string, readonly DirEntry[]>>,
  expanded: ReadonlySet<string>,
  dir: string,
  depth: number,
  rows: TreeRow[],
): void {
  const entries = listings[dir];
  if (entries === undefined) return;
  const sorted = [...entries].sort(compareEntries);
  for (const entry of sorted) {
    const path = joinPath(dir, entry.name);
    const isDir = entry.type === "dir";
    const isExpanded = isDir && expanded.has(path);
    rows.push({ path, name: entry.name, depth, isDir, expanded: isExpanded });
    if (isExpanded) walk(listings, expanded, path, depth + 1, rows);
  }
}

/**
 * Ratakan pohon berkas dari daftar folder yang sudah dimuat. Folder dulu lalu
 * berkas, nama tanpa peduli kapital; folder terbuka diikuti anaknya hanya bila
 * isinya sudah ada di `listings`.
 */
export function flattenTree(
  listings: Readonly<Record<string, readonly DirEntry[]>>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  walk(listings, expanded, "", 0, rows);
  return rows;
}

/** Saring baris yang namanya memuat query (tanpa peduli kapital); kosong -> semua. */
export function filterRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) => row.name.toLowerCase().includes(needle));
}

/** Set baru dengan path ditambah/dihapus dari daftar folder terbuka. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export const FILE_TREE_HIDDEN_KEY = "jejak.fileTreeHidden";

/** Baca nilai tersimpan: hanya "1" yang berarti tersembunyi. */
export function parseTreeHidden(raw: string | null | undefined): boolean {
  return raw === "1";
}

/** Muat pilihan sembunyikan pohon; penyimpanan rusak berarti tetap tampil. */
export function loadTreeHidden(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return parseTreeHidden(storage?.getItem(FILE_TREE_HIDDEN_KEY));
  } catch {
    return false;
  }
}

/** Simpan pilihan sembunyikan pohon; penyimpanan diblokir diabaikan. */
export function saveTreeHidden(storage: Pick<Storage, "setItem">, hidden: boolean): void {
  try {
    storage.setItem(FILE_TREE_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // penyimpanan tidak tersedia
  }
}
