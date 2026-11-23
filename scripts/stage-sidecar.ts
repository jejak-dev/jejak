/**
 * Skrip_stage binary sidecar ke folder `src-tauri/binaries/`.
 *
 * Tauri mencari sidecar eksternal dengan nama `<nama>-<triple>`, sedangkan
 * binary hasil `build:binary` memakai nama lain. Skrip ini menyalinnya ke nama
 * yang diharapkan Tauri.
 */

import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUILD_TARGETS,
  ROOT,
  currentBuildTarget,
  isBuildTarget,
  targetOutputPath,
  type BuildTarget,
} from "./build-binary";

/** Folder tujuan binary sidecar (diabaikan git). */
export const SIDECAR_DIR = join(ROOT, "src-tauri", "binaries");

/** Nama dasar sidecar sesuai entri `externalBin` di tauri.conf.json. */
export const SIDECAR_NAME = "jejak";

/** Peta target build ke triple Rust yang dipahami Tauri. */
const TRIPLE: Record<BuildTarget, string> = {
  "bun-darwin-arm64": "aarch64-apple-darwin",
  "bun-darwin-x64": "x86_64-apple-darwin",
  "bun-windows-x64": "x86_64-pc-windows-msvc",
  "bun-linux-x64": "x86_64-unknown-linux-gnu",
  "bun-linux-arm64": "aarch64-unknown-linux-gnu",
};

/**
 * Triple Rust untuk sebuah target build.
 *
 * Melempar galat jelas untuk target yang tak dikenal.
 */
export function tripleForBuildTarget(target: string): string {
  if (isBuildTarget(target)) return TRIPLE[target];
  throw new Error(
    `Target tidak dikenal: ${target}. Target sah: ${BUILD_TARGETS.join(", ")}.`,
  );
}

/** Nama berkas sidecar yang diharapkan Tauri untuk sebuah target. */
export function sidecarFileName(target: string): string {
  const triple = tripleForBuildTarget(target);
  const akhiran = triple.includes("windows") ? ".exe" : "";
  return `${SIDECAR_NAME}-${triple}${akhiran}`;
}

export interface StagePlan {
  /** Berkas binary asal (hasil `build:binary`). */
  source: string;
  /** Berkas tujuan di folder binaries Tauri. */
  destination: string;
}

/** Rencana penyalinan binary sidecar untuk sebuah target. */
export function planStage(
  target: string,
  destDir: string = SIDECAR_DIR,
): StagePlan {
  return {
    source: targetOutputPath(target),
    destination: join(destDir, sidecarFileName(target)),
  };
}

export interface StageOptions {
  /** Sumber pengganti dari `targetOutputPath` (untuk tes). */
  sourcePath?: string;
  /** Folder tujuan pengganti dari `SIDECAR_DIR` (untuk tes). */
  destDir?: string;
}

/**
 * Salin binary sidecar ke folder binaries Tauri dan beri izin eksekusi.
 *
 * Melempar galat jelas bila binary belum dibangun.
 */
export async function stageSidecar(
  target: string,
  opsi: StageOptions = {},
): Promise<string> {
  const rencana = planStage(target, opsi.destDir ?? SIDECAR_DIR);
  const source = opsi.sourcePath ?? rencana.source;
  const info = await stat(source).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(
      `Binary belum dibangun: ${source}. ` +
        `Jalankan: bun run build:binary --target ${target}`,
    );
  }
  await mkdir(dirname(rencana.destination), { recursive: true });
  await copyFile(source, rencana.destination);
  await chmod(rencana.destination, 0o755);
  return rencana.destination;
}

export interface ParsedStageArgs {
  /** Target yang akan disalin; kosong bila argumen tidak sah. */
  targets: string[];
  /** Pesan galat Bahasa Indonesia bila argumen tidak sah. */
  error?: string;
}

/**
 * Mengurai argumen baris perintah: `--target <t>` atau `--target=<t>` untuk
 * satu target, `--all` untuk semua target sah. Tanpa argumen dipakai target
 * platform mesin ini.
 */
export function parseStageArgs(
  argv: readonly string[],
  bawaan: string | null = currentBuildTarget(),
): ParsedStageArgs {
  let semua = false;
  let target: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--all") {
      semua = true;
      continue;
    }
    if (token === "--target" || token.startsWith("--target=")) {
      let nilai: string | undefined;
      if (token.startsWith("--target=")) {
        nilai = token.slice("--target=".length);
      } else {
        nilai = argv[index + 1];
        if (nilai === undefined || nilai === "" || nilai.startsWith("--")) {
          return { targets: [], error: "--target butuh nilai." };
        }
        index += 1;
      }
      if (nilai === "") {
        return { targets: [], error: "--target butuh nilai." };
      }
      target = nilai;
      continue;
    }
    return { targets: [], error: `Argumen tidak dikenal: ${token}` };
  }

  if (semua && target !== undefined) {
    return {
      targets: [],
      error: "--all dan --target tak boleh dipakai bersamaan.",
    };
  }
  if (semua) {
    return { targets: [...BUILD_TARGETS] };
  }
  if (target !== undefined) {
    if (!isBuildTarget(target)) {
      return {
        targets: [],
        error: `Target tidak dikenal: ${target}. Target sah: ${BUILD_TARGETS.join(", ")}.`,
      };
    }
    return { targets: [target] };
  }
  if (bawaan === null) {
    return {
      targets: [],
      error:
        "Platform ini tak punya target sah. " +
        `Pakai --target <t> (${BUILD_TARGETS.join(", ")}) atau --all.`,
    };
  }
  return { targets: [bawaan] };
}

/** Alur skrip; mengembalikan kode keluar untuk skrip. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseStageArgs(argv);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    console.error(
      "Pakai: bun run scripts/stage-sidecar.ts [--target <t>] [--all]",
    );
    console.error(`Target sah: ${BUILD_TARGETS.join(", ")}`);
    return 1;
  }
  try {
    for (const target of parsed.targets) {
      const tujuan = await stageSidecar(target);
      console.log(`${target}: ${tujuan}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
