import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { pathApi, type PathApi } from "../platform";

export interface BrowseEntry {
  /** Nama entri apa adanya (bisa nama symlink). */
  name: string;
  /** Path absolut; untuk symlink berisi realpath tujuannya. */
  path: string;
  /** Apakah ada `.git` (berkas atau folder) di dalam folder ini. */
  git: boolean;
}

export interface BrowseResult {
  /** Realpath folder yang sedang ditelusuri. */
  path: string;
  /** Folder induk, atau null bila sudah di akar. */
  parent: string | null;
  home: string;
  /** Hanya folder, tanpa berkas maupun isi folder. */
  entries: BrowseEntry[];
  truncated: boolean;
}

export class BrowseError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

export interface BrowseOptions {
  /** Folder awal saat `path` tidak dikirim; default `os.homedir()`. */
  home?: string;
  /** Jumlah entri maksimum; default 300. */
  limit?: number;
  /** Platform untuk pemeriksaan path absolut; default `process.platform`. */
  platform?: NodeJS.Platform;
}

const DEFAULT_LIMIT = 300;
const INVALID = "Path tidak valid.";
const NOT_FOUND = "Folder tidak ditemukan.";
const NOT_DIRECTORY = "Bukan folder.";
const UNREADABLE = "Folder tidak bisa dibaca.";

function validatePath(input: unknown, home: string, platform: NodeJS.Platform): string {
  if (input === undefined || input === "") return home;
  if (typeof input !== "string") {
    throw new BrowseError(INVALID, 400);
  }
  if (input.includes("\0") || !pathApi(platform).isAbsolute(input)) {
    throw new BrowseError(INVALID, 400);
  }
  return input;
}

async function hasGit(dir: string, p: PathApi): Promise<boolean> {
  try {
    await lstat(p.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mendaftar subfolder dari sebuah folder untuk pemilih "folder kerja" di UI.
 * Hanya membaca struktur (readdir/stat/lstat/realpath); isi berkas tidak pernah
 * dibaca maupun dilaporkan.
 */
export async function browseDirs(
  input: unknown,
  options: BrowseOptions = {},
): Promise<BrowseResult> {
  const home = options.home ?? homedir();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const platform = options.platform ?? process.platform;
  const p = pathApi(platform);
  const requested = validatePath(input, home, platform);

  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    throw new BrowseError(NOT_FOUND, 404);
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    throw new BrowseError(NOT_FOUND, 404);
  }
  if (!info.isDirectory()) {
    throw new BrowseError(NOT_DIRECTORY, 400);
  }

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch {
    throw new BrowseError(UNREADABLE, 400);
  }

  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;

    let entryPath: string;
    if (dirent.isDirectory()) {
      entryPath = p.join(target, dirent.name);
    } else if (dirent.isSymbolicLink()) {
      try {
        entryPath = await realpath(p.join(target, dirent.name));
      } catch {
        continue; // symlink rusak
      }
      let linkInfo;
      try {
        linkInfo = await stat(entryPath);
      } catch {
        continue;
      }
      if (!linkInfo.isDirectory()) continue; // symlink ke berkas
    } else {
      continue;
    }

    entries.push({ name: dirent.name, path: entryPath, git: await hasGit(entryPath, p) });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const truncated = entries.length > limit;
  const parentPath = p.dirname(target);

  return {
    path: target,
    parent: parentPath === target ? null : parentPath,
    home,
    entries: truncated ? entries.slice(0, limit) : entries,
    truncated,
  };
}