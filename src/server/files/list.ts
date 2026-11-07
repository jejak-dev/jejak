import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileError, resolveInside } from "./path";

export interface DirEntry {
  name: string;
  type: "dir" | "file" | "link";
  size?: number;
}

export interface DirectoryListing {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 2000;

function compareEntries(a: DirEntry, b: DirEntry): number {
  const aRank = a.type === "dir" ? 0 : 1;
  const bRank = b.type === "dir" ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (folded !== 0) return folded;
  return a.name.localeCompare(b.name);
}

export async function listDirectory(cwd: string, rel: unknown): Promise<DirectoryListing> {
  const resolved = await resolveInside(cwd, rel);

  let info;
  try {
    info = await stat(resolved.target);
  } catch {
    throw new FileError("Path tidak ditemukan.", "tidak-ditemukan");
  }
  if (!info.isDirectory()) {
    throw new FileError("Path bukan direktori.", "tidak-valid");
  }

  let dirents;
  try {
    dirents = await readdir(resolved.target, { withFileTypes: true });
  } catch {
    throw new FileError("Direktori tidak dapat dibaca.", "tidak-valid");
  }

  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    let type: DirEntry["type"];
    if (dirent.isSymbolicLink()) type = "link";
    else if (dirent.isDirectory()) type = "dir";
    else if (dirent.isFile()) type = "file";
    else continue;

    const entry: DirEntry = { name: dirent.name, type };
    if (type === "file") {
      try {
        const fileInfo = await lstat(join(resolved.target, dirent.name));
        if (fileInfo.isFile()) entry.size = fileInfo.size;
      } catch {
        // Berkas menghilang di antara readdir dan lstat; ukuran cukup dihilangkan.
      }
    }
    entries.push(entry);
  }

  entries.sort(compareEntries);
  const truncated = entries.length > MAX_ENTRIES;
  return {
    path: resolved.path,
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
  };
}
