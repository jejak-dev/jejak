/**
 * Skrip build aplikasi desktop Jejak (cangkang Tauri).
 *
 * Urutan langkah: bangun binary sidecar, tempatkan binary itu di folder yang
 * diharapkan Tauri (`src-tauri/binaries/jejak-<triple>`), lalu bundel aplikasi
 * desktop dengan `tauri build`.
 *
 * Fungsi murni diekspor supaya bisa diuji tanpa menjalankan build.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_TARGETS,
  currentBuildTarget,
  isBuildTarget,
  type BuildTarget,
} from "./build-binary";
import { tripleForBuildTarget } from "./stage-sidecar";

/** Akar repo, dihitung dari lokasi skrip ini. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DesktopOptions {
  /** Mode debug; build rilis bila false. */
  debug?: boolean;
}

/**
 * Bundel yang dihasilkan untuk sebuah target.
 *
 * macOS menghasilkan `.app` dan `.dmg`; Windows menghasilkan installer NSIS;
 * Linux `.deb` (cangkang native Linux dikemas oleh `native/linux`, bukan Tauri).
 */
export function bundlesForTarget(target: string): string[] {
  if (!isBuildTarget(target)) {
    throw new Error(
      `Target tidak dikenal: ${target}. Target sah: ${BUILD_TARGETS.join(", ")}.`,
    );
  }
  if (target.startsWith("bun-darwin")) return ["app", "dmg"];
  if (target.startsWith("bun-linux")) return ["deb"];
  return ["nsis"];
}

/**
 * Argumen `tauri build` untuk sebuah target.
 *
 * `--target` selalu ditulis supaya nama `externalBin` (`jejak-<triple>`)
 * yang disiapkan `stage-sidecar` pasti cocok dengan yang dicari Tauri.
 */
export function tauriArgs(target: string, opsi: DesktopOptions = {}): string[] {
  const args = ["build"];
  if (opsi.debug === true) {
    args.push("--debug");
  }
  args.push("--bundles", bundlesForTarget(target).join(","));
  args.push("--target", tripleForBuildTarget(target));
  return args;
}

export interface ParsedDesktopArgs {
  /** Target yang akan dibangun; null bila tak diketahui. */
  target: BuildTarget | null;
  /** True bila mode debug diminta. */
  debug: boolean;
  /** Pesan galat Bahasa Indonesia bila argumen tidak sah. */
  error?: string;
}

/**
 * Mengurai argumen baris perintah: `--target <t>` atau `--target=<t>` dan
 * `--debug`. Tanpa argumen dipakai target platform mesin ini.
 */
export function parseDesktopArgs(
  argv: readonly string[],
  bawaan: BuildTarget | null = currentBuildTarget(),
): ParsedDesktopArgs {
  let debug = false;
  let target: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--debug") {
      debug = true;
      continue;
    }
    if (token === "--target" || token.startsWith("--target=")) {
      let nilai: string | undefined;
      if (token.startsWith("--target=")) {
        nilai = token.slice("--target=".length);
      } else {
        nilai = argv[index + 1];
        if (nilai === undefined || nilai === "" || nilai.startsWith("--")) {
          return { target: null, debug, error: "--target butuh nilai." };
        }
        index += 1;
      }
      if (nilai === "") {
        return { target: null, debug, error: "--target butuh nilai." };
      }
      target = nilai;
      continue;
    }
    return { target: null, debug, error: `Argumen tidak dikenal: ${token}` };
  }

  if (target !== undefined) {
    if (!isBuildTarget(target)) {
      return {
        target: null,
        debug,
        error: `Target tidak dikenal: ${target}. Target sah: ${BUILD_TARGETS.join(", ")}.`,
      };
    }
    return { target, debug };
  }
  if (bawaan === null) {
    return {
      target: null,
      debug,
      error:
        "Platform ini tak punya target sah. " +
        `Pakai --target <t> (${BUILD_TARGETS.join(", ")}).`,
    };
  }
  return { target: bawaan, debug };
}

/** Satu langkah build: perintah dan keterangan. */
export interface DesktopStep {
  /** Keterangan langkah untuk ditampilkan. */
  title: string;
  /** Perintah lengkap yang dijalankan. */
  command: string[];
}

/**
 * Langkah-langkah build untuk sebuah target.
 *
 * Urutannya penting: binary sidecar harus ada di `src-tauri/binaries/`
 * sebelum `tauri build` menyalinnya ke dalam bundel.
 */
export function buildSteps(
  target: BuildTarget,
  opsi: DesktopOptions = {},
): DesktopStep[] {
  return [
    {
      title: "Bangun binary sidecar",
      command: ["bun", "run", "build:binary", "--target", target],
    },
    {
      title: "Tempatkan binary sidecar",
      command: ["bun", "run", "stage:sidecar", "--target", target],
    },
    {
      title: "Bundel aplikasi desktop",
      command: ["bunx", "tauri", ...tauriArgs(target, opsi)],
    },
  ];
}

/** Jalankan satu perintah; stdio diwarisi dan kode keluar diteruskan. */
export async function runStep(step: DesktopStep): Promise<number> {
  const [command, ...args] = step.command;
  if (command === undefined) {
    return 1;
  }
  const proses = Bun.spawn([command, ...args], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proses.exited;
}

/** Alur skrip; mengembalikan kode keluar untuk skrip. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseDesktopArgs(argv);
  if (parsed.target === null) {
    console.error(parsed.error ?? "Target build tak diketahui.");
    console.error(
      "Pakai: bun run scripts/build-desktop.ts [--target <t>] [--debug]",
    );
    console.error(`Target sah: ${BUILD_TARGETS.join(", ")}`);
    return 1;
  }

  for (const step of buildSteps(parsed.target, { debug: parsed.debug })) {
    console.log(`==> ${step.title}`);
    const kode = await runStep(step);
    if (kode !== 0) {
      console.error(`Langkah "${step.title}" gagal dengan kode keluar ${kode}.`);
      return kode;
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
