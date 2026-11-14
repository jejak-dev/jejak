import { rename, rmdir, rm, unlink } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  MEMORY_INDEX_FILE,
  ensureDirectory,
  isMemoryId,
  memoryFileName,
  projectDisplayName,
  projectFolderName,
  readMemoryFile,
  readProjectMapping,
  safeReaddir,
  writeFileAtomic,
  writeMemoryFile,
} from "./memory-files";
import type { MemoryConfidence, MemoryStatus } from "./memory-files";
import type { MemoryProblem } from "./memory-index";

/** Nama berkas pemetaan proyek; bukan berkas memory. */
const PROJECT_MAPPING_FILE = "_project.json";

/** Urutan status pada `INDEX.md`: aktif, usulan, diarsipkan, ditolak. */
export const MEMORY_STATUS_ORDER: MemoryStatus[] = [
  "active",
  "proposed",
  "archived",
  "rejected",
];

export interface FolderIndexEntry {
  title: string;
  fileName: string;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  updatedAt: string;
}

export interface FolderIndexOptions {
  /** Judul besar folder, mis. `Memory profil` atau `Memory proyek: jejak`. */
  heading: string;
  /** Key proyek; `null` untuk folder profil. */
  projectKey?: string | null;
  entries: FolderIndexEntry[];
}

export interface RootIndexFolder {
  label: string;
  /** Path relatif ke `INDEX.md` folder tersebut. */
  relPath: string;
  active: number;
  proposed: number;
}

/** Melindungi sel tabel markdown dari baris baru dan karakter khusus. */
function escapeCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function formatDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match === null ? value : match[1]!;
}

function compareEntries(left: FolderIndexEntry, right: FolderIndexEntry): number {
  const leftStatus = MEMORY_STATUS_ORDER.indexOf(left.status);
  const rightStatus = MEMORY_STATUS_ORDER.indexOf(right.status);
  if (leftStatus !== rightStatus) return leftStatus - rightStatus;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return left.title.localeCompare(right.title);
}

/** Isi `INDEX.md` untuk satu folder memory (profil atau proyek). */
export function renderFolderIndex(options: FolderIndexOptions): string {
  const lines: string[] = [];
  lines.push(`# ${options.heading}`);
  lines.push("");
  if (options.projectKey !== undefined && options.projectKey !== null) {
    lines.push(`Proyek: ${options.projectKey}`);
    lines.push("");
  }
  lines.push(
    "Dibuat otomatis oleh Jejak. Sumber kebenaran adalah berkas di folder ini; jangan edit berkas ini.",
  );
  lines.push("");
  lines.push("| Judul | Status | Keyakinan | Diperbarui |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of [...options.entries].sort(compareEntries)) {
    lines.push(
      `| [${escapeCell(entry.title)}](${entry.fileName}) | ${entry.status} | ${entry.confidence} | ${formatDate(entry.updatedAt)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Isi `INDEX.md` akar: daftar folder profil dan proyek. */
export function renderRootIndex(folders: RootIndexFolder[]): string {
  const lines: string[] = [];
  lines.push("# Memory Jejak");
  lines.push("");
  lines.push(
    "Dibuat otomatis oleh Jejak. Sumber kebenaran adalah berkas di folder memory; jangan edit berkas ini.",
  );
  lines.push("");
  lines.push("| Folder | Aktif | Usulan |");
  lines.push("| --- | --- | --- |");
  for (const folder of folders) {
    lines.push(
      `| [${escapeCell(folder.label)}](${folder.relPath}) | ${folder.active} | ${folder.proposed} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Menulis berkas hanya bila isinya berubah; mengembalikan true bila ditulis. */
export async function writeIndexIfChanged(target: string, content: string): Promise<boolean> {
  try {
    const current = await Bun.file(target).text();
    if (current === content) return false;
  } catch {
    // Berkas belum ada; tulis di bawah.
  }
  await ensureDirectory(join(target, ".."));
  await writeFileAtomic(target, content);
  return true;
}

/**
 * True bila folder benar-benar berisi berkas memory (`.md` selain
 * `INDEX.md`). Folder tanpa memory tidak boleh mendapat `INDEX.md`.
 */
async function folderHasMemoryFiles(folderAbs: string): Promise<boolean> {
  for (const entry of await safeReaddir(folderAbs)) {
    if (!entry.isFile()) continue;
    if (entry.name === MEMORY_INDEX_FILE) continue;
    if (entry.name.endsWith(".md")) return true;
  }
  return false;
}

/**
 * Menghapus folder proyek yang tidak lagi berisi berkas memory: yang tersisa
 * hanya `INDEX.md` dan/atau `_project.json`. Folder yang masih berisi berkas
 * lain (termasuk berkas rusak) tidak disentuh. Mengembalikan nama folder yang
 * dihapus.
 */
export async function cleanupEmptyProjectFolders(dir: string): Promise<string[]> {
  const projectsDir = join(dir, "projects");
  const removed: string[] = [];
  for (const entry of await safeReaddir(projectsDir)) {
    if (!entry.isDirectory()) continue;
    const folderAbs = join(projectsDir, entry.name);

    let adaBerkasLain = false;
    for (const file of await safeReaddir(folderAbs)) {
      if (!file.isFile()) {
        adaBerkasLain = true;
        break;
      }
      if (file.name === MEMORY_INDEX_FILE || file.name === PROJECT_MAPPING_FILE) continue;
      adaBerkasLain = true;
      break;
    }
    if (adaBerkasLain) continue;

    // Folder kosong: hapus `INDEX.md` dan `_project.json`, lalu foldernya.
    await rm(folderAbs, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/** Menulis `INDEX.md` sebuah folder memory. */
export async function writeFolderIndex(
  dir: string,
  folderRel: string,
  options: FolderIndexOptions,
): Promise<boolean> {
  const folderAbs = join(dir, ...folderRel.split("/"));
  // `INDEX.md` hanya ditulis di folder yang benar-benar berisi memory.
  if (!(await folderHasMemoryFiles(folderAbs))) return false;
  await ensureDirectory(folderAbs);
  const target = join(folderAbs, MEMORY_INDEX_FILE);
  return writeIndexIfChanged(target, renderFolderIndex(options));
}

/**
 * Menulis `INDEX.md` akar memory. Daftar folder kosong tetap ditulis supaya
 * tautan ke folder yang sudah dihapus hilang.
 */
export async function writeRootIndex(
  dir: string,
  folders: RootIndexFolder[],
): Promise<boolean> {
  await ensureDirectory(dir);
  return writeIndexIfChanged(join(dir, MEMORY_INDEX_FILE), renderRootIndex(folders));
}

/** Daftar folder proyek yang ada di disk beserta projectKey-nya. */
export async function listProjectFolders(
  dir: string,
): Promise<{ name: string; projectKey: string | null }[]> {
  const projectsDir = join(dir, "projects");
  const folders: { name: string; projectKey: string | null }[] = [];
  for (const entry of await safeReaddir(projectsDir)) {
    if (!entry.isDirectory()) continue;
    const mapping = await readProjectMapping(join(projectsDir, entry.name));
    folders.push({ name: entry.name, projectKey: mapping.projectKey });
  }
  folders.sort((left, right) => left.name.localeCompare(right.name));
  return folders;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mengganti nama berkas legacy (`<uuid>.md`) di satu folder menjadi nama baru
 * (`<slug>-<id8>.md`). Berkas yang gagal di-parse tidak disentuh.
 */
async function migrateFolderFiles(
  dir: string,
  folderRel: string,
  layer: "profile" | "project",
  projectKey: string | null,
  problems: MemoryProblem[],
): Promise<boolean> {
  const folderAbs = join(dir, ...folderRel.split("/"));
  let changed = false;
  for (const entry of await safeReaddir(folderAbs)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === MEMORY_INDEX_FILE) continue;
    const base = entry.name.slice(0, -3);
    if (!isMemoryId(base)) continue;

    const relPath = posix.join(folderRel, entry.name);
    const read = await readMemoryFile(dir, relPath, layer, projectKey);
    if (!read.ok) continue;

    const newName = memoryFileName(read.memory);
    if (newName === entry.name) continue;
    const targetAbs = join(folderAbs, newName);
    if (await pathExists(targetAbs)) {
      problems.push({
        file: relPath,
        reason: `nama berkas bentrok dengan ${newName}; berkas lama dibiarkan`,
      });
      continue;
    }
    try {
      await writeMemoryFile(dir, read.memory, posix.join(folderRel, newName));
      await unlink(join(folderAbs, entry.name));
      changed = true;
    } catch (error) {
      problems.push({ file: relPath, reason: `gagal dimigrasi: ${messageOf(error)}` });
    }
  }
  return changed;
}

/**
 * Menggabungkan isi folder lama ke folder baru tanpa menimpa berkas yang
 * namanya bentrok. Berkas yang bentrok dilaporkan sebagai masalah dan tidak
 * dihapus.
 */
async function mergeFolder(
  sourceRel: string,
  sourceAbs: string,
  targetAbs: string,
  problems: MemoryProblem[],
): Promise<boolean> {
  let moved = false;
  for (const entry of await safeReaddir(sourceAbs)) {
    if (!entry.isFile()) continue;
    if (entry.name === PROJECT_MAPPING_FILE || entry.name === MEMORY_INDEX_FILE) continue;
    const sourceFile = join(sourceAbs, entry.name);
    const targetFile = join(targetAbs, entry.name);
    if (await pathExists(targetFile)) {
      problems.push({
        file: posix.join(sourceRel, entry.name),
        reason: "nama berkas bentrok saat penggabungan folder; berkas lama dibiarkan",
      });
      continue;
    }
    try {
      await rename(sourceFile, targetFile);
      moved = true;
    } catch (error) {
      problems.push({
        file: posix.join(sourceRel, entry.name),
        reason: `gagal digabung: ${messageOf(error)}`,
      });
    }
  }

  // Metadata turunan: dipakai ulang bila belum ada di folder tujuan.
  const sourceMapping = join(sourceAbs, PROJECT_MAPPING_FILE);
  if (await pathExists(sourceMapping)) {
    const targetMapping = join(targetAbs, PROJECT_MAPPING_FILE);
    if (await pathExists(targetMapping)) {
      await unlink(sourceMapping).catch(() => undefined);
    } else {
      await rename(sourceMapping, targetMapping).catch(() => undefined);
    }
  }
  // `INDEX.md` dibuat ulang setelah migrasi.
  await unlink(join(sourceAbs, MEMORY_INDEX_FILE)).catch(() => undefined);
  await rmdir(sourceAbs).catch(() => undefined);
  return moved;
}

export interface MigrationResult {
  problems: MemoryProblem[];
  /** Folder yang isinya berubah karena migrasi. */
  changedFolders: string[];
  /** Folder proyek yang dibersihkan karena tidak lagi berisi memory. */
  removedFolders: string[];
}

/**
 * Migrasi lunak layout memory: berkas legacy diganti nama, folder proyek
 * hash16 diganti nama ke `<slug>-<hash8>`. Idempoten dan tidak melempar;
 * masalah dikumpulkan untuk dilaporkan.
 */
export async function migrateMemoryLayout(dir: string): Promise<MigrationResult> {
  const problems: MemoryProblem[] = [];
  const changedFolders: string[] = [];

  // Sisa folder proyek lama (hanya `INDEX.md`/`_project.json`) dibersihkan
  // lebih dulu supaya tidak tertinggal dan tidak dilaporkan sebagai masalah.
  const removedFolders = await cleanupEmptyProjectFolders(dir);

  const profileChanged = await migrateFolderFiles(dir, "profile", "profile", null, problems);
  if (profileChanged) changedFolders.push("profile");

  const projectsDir = join(dir, "projects");
  for (const entry of await safeReaddir(projectsDir)) {
    if (!entry.isDirectory()) continue;
    const folderAbs = join(projectsDir, entry.name);
    const folderRel = posix.join("projects", entry.name);
    const mapping = await readProjectMapping(folderAbs);
    if (mapping.projectKey === null) {
      problems.push({
        file: folderRel,
        reason: mapping.error ?? "pemetaan proyek tidak ditemukan",
      });
      continue;
    }

    // Berkas legacy di dalam folder lebih dulu diganti nama, supaya bentrok
    // saat penggabungan folder terdeteksi pada nama akhir.
    const changed = await migrateFolderFiles(
      dir,
      folderRel,
      "project",
      mapping.projectKey,
      problems,
    );
    if (changed) changedFolders.push(folderRel);

    const targetName = projectFolderName(mapping.projectKey);
    if (targetName === entry.name) continue;

    const targetRel = posix.join("projects", targetName);
    const targetAbs = join(projectsDir, targetName);
    if (await pathExists(targetAbs)) {
      const moved = await mergeFolder(folderRel, folderAbs, targetAbs, problems);
      const targetChanged = await migrateFolderFiles(
        dir,
        targetRel,
        "project",
        mapping.projectKey,
        problems,
      );
      if (moved || targetChanged) changedFolders.push(targetRel);
      continue;
    }

    try {
      await rename(folderAbs, targetAbs);
    } catch (error) {
      problems.push({ file: folderRel, reason: `gagal diubah nama: ${messageOf(error)}` });
      continue;
    }
    changedFolders.push(targetRel);
  }

  return {
    problems,
    changedFolders: [...new Set(changedFolders)],
    removedFolders,
  };
}

/** Nama proyek yang ditampilkan pada judul `INDEX.md`. */
export function folderProjectHeading(projectKey: string): string {
  const name = projectDisplayName(projectKey);
  return name === "" ? projectKey : name;
}
