import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWindows } from "../platform";

/** Isi askpass POSIX; sama persis dengan versi lama (skrip `sh`). */
export const POSIX_ASKPASS =
  '#!/bin/sh\ncase "$1" in\n  Username*) echo oauth2 ;;\n  *) echo "$JEJAK_GIT_TOKEN" ;;\nesac\n';

/**
 * Isi askpass Windows (batch `cmd`).
 *
 * Git memanggil askpass dengan satu argumen prompt, misalnya
 * `Username for 'https://contoh.test':` atau `Password for 'https://contoh.test':`.
 * Skrip POSIX menjawab `oauth2` bila prompt diawali "Username", kalau tidak
 * ia menjawab token dari `JEJAK_GIT_TOKEN`. Batch ini memakai semantik yang
 * sama: prompt disimpan di `PROMPT`, delapan huruf pertamanya dibandingkan
 * dengan "Username", dan token dibaca dari variabel lingkungan yang sama
 * (`JEJAK_GIT_TOKEN`).
 *
 * Catatan: `echo(` dipakai agar token kosong tetap menghasilkan baris kosong
 * (bukan "ECHO is off."), dan `%~1` melepas tanda kutip bila ada.
 */
export const WINDOWS_ASKPASS = [
  "@echo off",
  "rem Askpass Jejak untuk Windows; padanan askpass.sh POSIX.",
  "rem Git memanggil askpass dengan satu argumen prompt, misalnya",
  "rem Username for 'https://contoh.test':",
  "rem Prompt diawali Username dijawab nama pengguna tetap oauth2;",
  "rem selain itu dijawab token dari variabel lingkungan JEJAK_GIT_TOKEN.",
  "setlocal",
  'set "PROMPT=%~1"',
  'if "%PROMPT:~0,8%"=="Username" (',
  "  echo oauth2",
  ") else (",
  "  echo(%JEJAK_GIT_TOKEN%",
  ")",
  "endlocal",
  "",
].join("\r\n");

export interface AskpassFile {
  /** Nama berkas askpass di folder cache. */
  name: string;
  /** Isi berkas. */
  content: string;
  /** Izin berkas (0700); di Windows izin berkas tak bermakna. */
  mode: number;
}

/**
 * Berkas askpass untuk platform tertentu: `askpass.sh` di POSIX, `askpass.cmd`
 * di Windows. Isi POSIX identik dengan versi lama.
 */
export function askpassFile(platform: NodeJS.Platform = process.platform): AskpassFile {
  if (isWindows(platform)) {
    return { name: "askpass.cmd", content: WINDOWS_ASKPASS, mode: 0o700 };
  }
  return { name: "askpass.sh", content: POSIX_ASKPASS, mode: 0o700 };
}

/**
 * Tulis berkas askpass ke `root` bila belum ada atau isinya berbeda, lalu
 * kembalikan path-nya. Dipakai indexer repo dan layanan wiki.
 */
export function writeAskpass(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const file = askpassFile(platform);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, file.name);
  if (!existsSync(path) || readFileSync(path, "utf8") !== file.content) {
    writeFileSync(path, file.content, { mode: file.mode });
    chmodSync(path, file.mode);
  }
  return path;
}
