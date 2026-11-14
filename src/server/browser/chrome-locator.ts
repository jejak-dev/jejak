import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { pathApi } from "../platform";

/** Pemeriksa keberadaan berkas; diinjeksi supaya bisa diuji. */
export type ChromeExists = (path: string) => boolean;

/** Kandidat macOS (urutan prioritas). */
const MAC_PATHS: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Kandidat Linux (urutan prioritas nama). */
const LINUX_NAMES: readonly string[] = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];

/** Kandidat Windows relatif terhadap tiap folder dasar. */
const WINDOWS_RELATIVE: readonly string[] = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
];

function firstExisting(paths: readonly string[], exists: ChromeExists): string | undefined {
  for (const path of paths) {
    if (exists(path)) return path;
  }
  return undefined;
}

/** Folder dasar Windows: Program Files, Program Files (x86), lalu LocalAppData. */
function windowsBases(env: Record<string, string | undefined>): string[] {
  const bases: string[] = [];
  const programFiles = env.ProgramFiles?.trim();
  if (programFiles !== undefined && programFiles !== "") bases.push(programFiles);
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
  if (programFilesX86 !== undefined && programFilesX86 !== "") bases.push(programFilesX86);
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData !== undefined && localAppData !== "") bases.push(localAppData);
  if (bases.length === 0) {
    bases.push("C:\\Program Files", "C:\\Program Files (x86)");
  }
  return bases;
}

/** Kandidat Linux: nama di PATH lalu /usr/bin. */
function linuxPaths(env: Record<string, string | undefined>): string[] {
  const dirs = (env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const paths: string[] = [];
  for (const name of LINUX_NAMES) {
    for (const dir of dirs) paths.push(pathApi("linux").join(dir, name));
    paths.push(pathApi("linux").join("/usr/bin", name));
  }
  return paths;
}

/**
 * Cari eksekusi Chrome/Chromium (fungsi murni, tanpa efek samping).
 *
 * Urutan: `JEJAK_CHROME_PATH` lebih dulu, lalu lokasi bawaan sesuai
 * platform. `exists` diinjeksi supaya hasilnya bisa diuji tanpa Chrome.
 */
export function locateChrome(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  exists: ChromeExists = existsSync,
): string | undefined {
  const custom = env.JEJAK_CHROME_PATH?.trim();
  if (custom !== undefined && custom !== "") {
    if (exists(custom)) return custom;
  }
  if (platform === "darwin") return firstExisting(MAC_PATHS, exists);
  if (platform === "win32") {
    const paths: string[] = [];
    const win = pathApi("win32");
    for (const base of windowsBases(env)) {
      for (const relative of WINDOWS_RELATIVE) paths.push(win.join(base, relative));
    }
    return firstExisting(paths, exists);
  }
  return firstExisting(linuxPaths(env), exists);
}
