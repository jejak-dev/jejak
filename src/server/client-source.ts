import { basename } from "node:path";
import type { ClientBundle, ClientBundleFile } from "./client-bundle";

/**
 * Sumber klien: fungsi yang mengembalikan bundel siap sajikan.
 * Bisa berupa pembangun runtime (Bun.build) atau pembaca berkas tertanam.
 */
export type ClientSource = () => Promise<ClientBundle>;

/**
 * Manifes klien tertanam. `js`, `css`, dan tiap `files[*].path` adalah path
 * berkas (hasil `import ... with { type: "file" }`; di binary berupa path
 * `$bunfs`). Kunci `files` adalah nama berkas yang disajikan server.
 */
export interface EmbeddedClientManifest {
  js: string;
  css: string;
  files: Record<string, { path: string; contentType: string }>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim();
  }
  return String(error);
}

async function readText(name: string, path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    throw new Error(
      `gagal membaca berkas tertanam "${name}" dari ${path}: ${messageOf(error)}`,
    );
  }
}

/** Memuat bundel klien dari manifes tertanam (berkas di disk atau di binary). */
export async function loadEmbeddedClient(manifest: EmbeddedClientManifest): Promise<ClientBundle> {
  const js = await readText(basename(manifest.js), manifest.js);
  const css = await readText(basename(manifest.css), manifest.css);

  const files = new Map<string, ClientBundleFile>();
  for (const [name, item] of Object.entries(manifest.files)) {
    files.set(name, { body: await readText(name, item.path), contentType: item.contentType });
  }

  return { js, css, files };
}

let registered: EmbeddedClientManifest | undefined;
let registeredSource: ClientSource | undefined;

/**
 * Mendaftarkan manifes klien tertanam. Pendaftaran kedua menimpa yang lama.
 */
export function registerEmbeddedClient(manifest: EmbeddedClientManifest): void {
  registered = manifest;
  registeredSource = undefined;
}

/**
 * Sumber klien tertanam yang terdaftar, atau `undefined` bila belum ada.
 * Hasil pemuatan di-cache; bila pemuatan gagal, cache dibuang agar dapat
 * diulang pada permintaan berikutnya.
 */
export function getEmbeddedClientSource(): ClientSource | undefined {
  if (registered === undefined) return undefined;
  if (registeredSource !== undefined) return registeredSource;

  const manifest = registered;
  let pending: Promise<ClientBundle> | undefined;
  registeredSource = (): Promise<ClientBundle> => {
    if (pending === undefined) {
      pending = loadEmbeddedClient(manifest).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
  return registeredSource;
}

/** Mengosongkan pendaftaran klien tertanam (untuk tes). */
export function resetEmbeddedClient(): void {
  registered = undefined;
  registeredSource = undefined;
}
