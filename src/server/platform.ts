import { posix, win32 } from "node:path";

/** Bentuk modul `node:path` (posix atau win32). */
export type PathApi = typeof posix;

/**
 * Pembantu lintas platform.
 *
 * Semua perilaku khusus OS dapat diinjeksi lewat parameter `platform`
 * (bawaan `process.platform`) supaya bisa diuji di macOS dengan platform
 * tiruan. Nilai bawaan selalu identik dengan perilaku lama di macOS/Linux.
 */

/** Apakah platform ini Windows. */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Perangkat "null" untuk konfigurasi git: `NUL` di Windows, `/dev/null` di
 * POSIX. Dipakai sebagai nilai konfigurasi (bukan pencocokan keluaran).
 */
export function nullDevice(platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? "NUL" : "/dev/null";
}

/**
 * Modul `path` yang sesuai platform: `win32` di Windows, `posix` di sisanya.
 * Sama dengan `node:path` bawaan pada platform aslinya.
 */
export function pathApi(platform: NodeJS.Platform = process.platform): PathApi {
  return isWindows(platform) ? win32 : posix;
}

/** Pemisah path dinormalisasi ke "/" untuk pencocokan pola dan tampilan. */
export function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Path absolut menurut platform: di Windows `C:\x` dan `\\server\share`
 * dianggap absolut, di POSIX hanya yang diawali "/".
 */
export function isAbsolutePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathApi(platform).isAbsolute(path);
}
