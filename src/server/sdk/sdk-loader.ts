import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveActiveSdkEntry, sdkRoot } from "./sdk-store";

/**
 * Pemuat SDK.
 *
 * Urutan resolusi:
 * 1. SDK terkelola yang aktif (`<JEJAK_HOME>/sdk/<versi>/package/sdk.mjs`);
 * 2. bila tidak terkompilasi (mode dev): impor paket bare
 *    `@anthropic-ai/claude-agent-sdk` (peer/dev);
 * 3. tidak ada: `SdkNotInstalledError`.
 */

/** Pesan "belum terpasang" yang mengarah ke tombol Pasang di Pengaturan. */
export const SDK_NOT_INSTALLED_MESSAGE =
  "Claude Agent SDK belum terpasang. Buka Pengaturan, kartu Claude Agent SDK, lalu klik Pasang " +
  "(lisensi Anthropic; tidak dibundel dengan Jejak). Atau jalankan dengan MOCK=true.";

/** Galat: tidak ada SDK yang bisa dimuat. */
export class SdkNotInstalledError extends Error {
  constructor(message: string = SDK_NOT_INSTALLED_MESSAGE) {
    super(message);
    this.name = "SdkNotInstalledError";
  }
}

/** Galat: SDK terkelola ada tapi berkasnya rusak atau gagal dimuat. */
export class SdkBrokenInstallError extends Error {
  constructor(
    message: string,
    public readonly version: string,
  ) {
    super(message);
    this.name = "SdkBrokenInstallError";
  }
}

/** Perintah slash yang dilaporkan SDK (bawaan, skill, dan perintah kustom). */
export interface SdkSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface SdkQuery extends AsyncIterable<unknown> {
  close?(): void;
  /**
   * Daftar perintah slash yang didukung sesi.
   *
   * Ada pada SDK baru; SDK lama tak punya dan pemanggil memakai daftar
   * bawaan.
   */
  supportedCommands?(): Promise<SdkSlashCommand[]>;
}

export interface SdkModule {
  /** Prompt string (biasa) atau prompt streaming (jalur "Arahkan"). */
  query(args: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }): SdkQuery;
}

export interface SdkLoaderOptions {
  /** Akar penyimpanan SDK; bawaan `sdkRoot(env)`. */
  root?: string;
  /** Impor dari URL absolut; bawaan `import(url)`. */
  importFile?: (url: string) => Promise<unknown>;
  /** Impor paket bare; bawaan impor dinamis `@anthropic-ai/claude-agent-sdk`. */
  importBare?: () => Promise<unknown>;
  /** Deteksi binary terkompilasi; bawaan `detectCompiled`. */
  isCompiled?: () => boolean;
  /** Env untuk mencari JEJAK_HOME; bawaan `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Nama paket SDK untuk impor mode dev.
 *
 * Sengaja disimpan di variabel: impor dinamis dengan nama literal akan
 * dibundel `bun build --compile`, padahal lisensi SDK prohibitif. Di binary
 * jalur ini tidak pernah dipakai.
 */
const BARE_MODULE = "@anthropic-ai/claude-agent-sdk";

async function defaultImportFile(url: string): Promise<unknown> {
  return import(url);
}

async function defaultImportBare(): Promise<unknown> {
  return import(BARE_MODULE);
}

/**
 * Deteksi mode terkompilasi (`bun build --compile`).
 *
 * Di binary, `Bun.main` menunjuk ke citra dalam memori (`/$bunfs/...` atau
 * `~BUN/...` di Windows); di mode dev `Bun.main` adalah berkas skrip biasa.
 */
export function detectCompiled(): boolean {
  const main = typeof Bun === "undefined" ? "" : Bun.main;
  if (main.includes("/$bunfs/") || main.includes("~BUN")) return true;
  if (main !== "") return false;
  // Cadangan: `process.execPath` bukan bun berarti proses berjalan dari binary lain.
  const exec = process.execPath;
  return !exec.includes("bun");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True bila galat berarti "modul tidak ada", bukan "modul ada tapi rusak". */
export function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const message = errorMessage(error);
  return /cannot find (?:module|package)|module not found|could not resolve/i.test(
    message,
  );
}

/** Versi terbaca dari jalur entri `<root>/<versi>/package/sdk.mjs`. */
function versionOfEntry(entry: string): string {
  return basename(dirname(dirname(entry)));
}

/**
 * Impor SDK terkelola dari path absolut.
 *
 * Pembeda versi pada query menghindari cache modul lama; jalur per versi
 * sudah unik.
 * Galat dibungkus jadi `SdkBrokenInstallError` berbahasa Indonesia supaya
 * pengguna tahu harus memasang ulang atau rollback.
 */
async function importManaged(entry: string, importFile: (url: string) => Promise<unknown>): Promise<SdkModule> {
  const version = versionOfEntry(entry);
  const url = `${pathToFileURL(entry).href}?v=${encodeURIComponent(version)}`;
  try {
    const imported = await importFile(url);
    return imported as SdkModule;
  } catch (error) {
    throw new SdkBrokenInstallError(
      `SDK terkelola versi ${version} gagal dimuat: ${errorMessage(error)}. ` +
        "Pasang ulang SDK dari Pengaturan atau rollback ke versi sebelumnya.",
      version,
    );
  }
}

/**
 * Membuat fungsi pemuat SDK.
 *
 * Hasil impor terkelola di-cache per jalur entri: versi baru memakai jalur
 * baru sehingga mengimpor ulang, sedangkan versi lama tetap dipakai sesi
 * yang sedang berjalan.
 */
export function createSdkLoader(options: SdkLoaderOptions = {}): () => Promise<SdkModule> {
  const env = options.env ?? process.env;
  const importFile = options.importFile ?? defaultImportFile;
  const importBare = options.importBare ?? defaultImportBare;
  const isCompiled = options.isCompiled ?? detectCompiled;
  const cache = new Map<string, Promise<SdkModule>>();
  const rootOf = (): string => options.root ?? sdkRoot(env);

  return async function loadSdk(): Promise<SdkModule> {
    const root = rootOf();
    const entry = await resolveActiveSdkEntry(root);
    if (entry !== null) {
      const cached = cache.get(entry);
      if (cached !== undefined) return cached;
      const pending = importManaged(entry, importFile);
      cache.set(entry, pending);
      try {
        return await pending;
      } catch (error) {
        cache.delete(entry);
        throw error;
      }
    }

    // Tanpa SDK terkelola: mode dev boleh memakai paket peer/dev.
    if (!isCompiled()) {
      try {
        return (await importBare()) as SdkModule;
      } catch (error) {
        if (!isModuleNotFound(error)) throw error;
      }
    }
    throw new SdkNotInstalledError();
  };
}

/** Pemuat bawaan; dipakai runner saat `options.load` tidak diberikan. */
export const defaultSdkLoader: () => Promise<SdkModule> = createSdkLoader();
