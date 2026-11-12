/**
 * Skrip build binary Jejak.
 *
 * Urutan langkah: bersihkan `build/`, bangun bundel klien, tulis modul klien
 * tertanam, lalu kompilasi binary untuk target yang dipilih.
 * Fungsi murni diekspor supaya bisa diuji tanpa menjalankan build.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientBundle } from "../src/server/client-bundle";

/** Akar repo, dihitung dari lokasi skrip ini. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Folder hasil kerja; tidak dilacak git. */
export const BUILD_DIR = join(ROOT, "build");

/** Folder keluaran binary; tidak dilacak git. */
export const DIST_DIR = join(ROOT, "dist");

/** Target kompilasi yang sah. */
export const BUILD_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

/** True bila string target termasuk target yang sah. */
export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

/**
 * Target untuk platform mesin ini, atau `null` bila platform ini tidak punya
 * target sah (mis. Linux; cakupan R2 hanya macOS dan Windows).
 */
export function currentBuildTarget(): BuildTarget | null {
  const nama = `bun-${process.platform}-${process.arch}`;
  return isBuildTarget(nama) ? nama : null;
}

/** Nama berkas keluaran untuk sebuah target, mis. "jejak-windows-x64.exe". */
export function targetOutputName(target: string): string {
  const bagian = target.split("-");
  const platform = bagian[1] ?? "unknown";
  const arch = bagian[2] ?? "unknown";
  const akhiran = platform === "windows" ? ".exe" : "";
  return `jejak-${platform}-${arch}${akhiran}`;
}

/** Path absolut berkas keluaran untuk sebuah target. */
export function targetOutputPath(target: string): string {
  return join(DIST_DIR, targetOutputName(target));
}

export interface ParsedBuildArgs {
  /** Target yang akan dibangun; kosong bila argumen tidak sah. */
  targets: BuildTarget[];
  /** Pesan galat Bahasa Indonesia bila argumen tidak sah. */
  error?: string;
}

/**
 * Mengurai argumen baris perintah: `--target <t>` atau `--target=<t>` untuk
 * satu target, `--all` untuk semua target sah. Tanpa argumen dipakai target
 * platform mesin ini.
 */
export function parseBuildArgs(
  argv: readonly string[],
  bawaan: BuildTarget | null = currentBuildTarget(),
): ParsedBuildArgs {
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
      error: "--all dan --target tidak boleh dipakai bersamaan.",
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
        "Platform ini tidak punya target sah. " +
        `Pakai --target <t> (${BUILD_TARGETS.join(", ")}) atau --all.`,
    };
  }
  return { targets: [bawaan] };
}

/** Peran berkas dalam manifes klien tertanam. */
export type EmbeddedEntryKind = "js" | "css" | "file";

export interface EmbeddedEntry {
  /** Nama berkas yang disajikan ke browser, mis. "app.js". */
  name: string;
  /** Path impor relatif ke modul tertanam, mis. "./client/app.js". */
  importPath: string;
  /** Peran berkas: entri JavaScript, entri CSS, atau berkas tambahan. */
  kind: EmbeddedEntryKind;
  /** Tipe konten HTTP berkas. */
  contentType: string;
}

/**
 * Menghasilkan teks modul klien tertanam.
 *
 * Setiap berkas diimpor statis dengan `with { type: "file" }` memakai
 * identifier aman `f0`, `f1`, ... sesuai urutan. Nama berkas dan tipe konten
 * ditulis sebagai literal JSON supaya nama aneh tetap aman.
 */
export function generateEmbeddedModule(entries: readonly EmbeddedEntry[]): string {
  const js = entries.find((entry) => entry.kind === "js");
  if (js === undefined) {
    throw new Error("modul tertanam butuh satu entri js");
  }
  const css = entries.find((entry) => entry.kind === "css");
  if (css === undefined) {
    throw new Error("modul tertanam butuh satu entri css");
  }

  const identifierOf = (entry: EmbeddedEntry): string => `f${entries.indexOf(entry)}`;
  const baris: string[] = [];

  baris.push("// Modul ini digenerate oleh scripts/build-binary.ts. Jangan diedit tangan.");
  baris.push("");
  for (const entry of entries) {
    baris.push(
      `import ${identifierOf(entry)} from ${JSON.stringify(entry.importPath)} with { type: "file" };`,
    );
  }
  baris.push('import { registerEmbeddedClient } from "../src/server/client-source";');
  baris.push("");
  baris.push("registerEmbeddedClient({");
  baris.push(`  js: ${identifierOf(js)},`);
  baris.push(`  css: ${identifierOf(css)},`);
  const lainnya = entries.filter((entry) => entry.kind === "file");
  if (lainnya.length === 0) {
    baris.push("  files: {},");
  } else {
    baris.push("  files: {");
    for (const entry of lainnya) {
      baris.push(
        `    ${JSON.stringify(entry.name)}: { path: ${identifierOf(entry)}, contentType: ${JSON.stringify(entry.contentType)} },`,
      );
    }
    baris.push("  },");
  }
  baris.push("});");
  baris.push("");

  return baris.join("\n");
}

/**
 * Teks entri binary hasil generate. Urutan penting: klien didaftarkan lebih
 * dulu, baru CLI dimuat.
 */
export function compiledEntrySource(): string {
  return [
    "// Entri ini digenerate oleh scripts/build-binary.ts. Jangan diedit tangan.",
    "// Urutan penting: klien didaftarkan lebih dulu, baru CLI dimuat.",
    'import "./embedded-client";',
    'import "../src/cli/index";',
    "",
  ].join("\n");
}

function messageOf(log: unknown): string | undefined {
  if (typeof log === "object" && log !== null) {
    const message = (log as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message.trim();
    }
  }
  return undefined;
}

function summarizeLogs(logs: readonly unknown[]): string {
  const pesan: string[] = [];
  for (const log of logs) {
    const message = messageOf(log);
    if (message !== undefined && !pesan.includes(message)) pesan.push(message);
  }
  return pesan.length > 0 ? pesan.join("; ") : "kesalahan tidak diketahui";
}

/**
 * Membersihkan `build/`, membangun bundel klien, lalu menulis tiap artefak ke
 * `build/client/`. Mengembalikan daftar entri untuk modul tertanam.
 */
export async function prepareClientFiles(): Promise<EmbeddedEntry[]> {
  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(join(BUILD_DIR, "client"), { recursive: true });

  const bundle = await buildClientBundle();
  await writeFile(join(BUILD_DIR, "client", "app.js"), bundle.js, "utf8");
  await writeFile(join(BUILD_DIR, "client", "app.css"), bundle.css, "utf8");

  const entries: EmbeddedEntry[] = [
    {
      name: "app.js",
      importPath: "./client/app.js",
      kind: "js",
      contentType: "application/javascript; charset=utf-8",
    },
    {
      name: "app.css",
      importPath: "./client/app.css",
      kind: "css",
      contentType: "text/css; charset=utf-8",
    },
  ];

  for (const [name, file] of bundle.files) {
    await writeFile(join(BUILD_DIR, "client", name), file.body, "utf8");
    entries.push({
      name,
      importPath: `./client/${name}`,
      kind: "file",
      contentType: file.contentType,
    });
  }

  return entries;
}

/** Menulis modul tertanam dan entri binary ke `build/`. */
export async function writeGeneratedSources(entries: readonly EmbeddedEntry[]): Promise<void> {
  await writeFile(
    join(BUILD_DIR, "embedded-client.ts"),
    generateEmbeddedModule(entries),
    "utf8",
  );
  await writeFile(join(BUILD_DIR, "compiled-entry.ts"), compiledEntrySource(), "utf8");
}

/** Kompilasi binary untuk satu target; melempar Error bila gagal. */
export async function compileBinary(target: BuildTarget, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(BUILD_DIR, "compiled-entry.ts")],
    compile: { target, outfile },
  });
  if (!result.success) {
    throw new Error(
      `gagal mengompilasi binary ${target}: ${summarizeLogs(result.logs)}`,
    );
  }
  for (const log of result.logs) {
    const message = messageOf(log);
    if (message !== undefined) console.error(`peringatan: ${message}`);
  }
}

export interface BuiltBinary {
  target: BuildTarget;
  outfile: string;
  size: number;
}

/**
 * Build lengkap: siapkan berkas klien, tulis modul tertanam, lalu kompilasi
 * binary untuk setiap target yang diminta.
 */
export async function buildBinary(targets: readonly BuildTarget[]): Promise<BuiltBinary[]> {
  const entries = await prepareClientFiles();
  await writeGeneratedSources(entries);

  const hasil: BuiltBinary[] = [];
  for (const target of targets) {
    const outfile = targetOutputPath(target);
    await mkdir(dirname(outfile), { recursive: true });
    await compileBinary(target, outfile);
    const size = (await stat(outfile)).size;
    hasil.push({ target, outfile, size });
  }
  return hasil;
}

/** Ukuran berkas dalam satuan yang enak dibaca. */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Alur skrip; mengembalikan kode keluar untuk skrip. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseBuildArgs(argv);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    console.error("Pakai: bun run scripts/build-binary.ts [--target <t>] [--all]");
    console.error(`Target sah: ${BUILD_TARGETS.join(", ")}`);
    return 1;
  }

  try {
    const hasil = await buildBinary(parsed.targets);
    for (const item of hasil) {
      console.log(
        `${item.target}: ${item.outfile} (${formatSize(item.size)})`,
      );
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
