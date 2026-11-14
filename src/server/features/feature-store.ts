import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { jejakHome } from "../provider-store";

/** Fitur yang bisa dinyalakan lewat Pengaturan. */
export const FEATURE_NAMES = ["terminal", "browser"] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Variabel lingkungan yang mengunci tiap fitur. */
export const FEATURE_ENV: Record<FeatureName, string> = {
  terminal: "JEJAK_TERMINAL",
  browser: "JEJAK_BROWSER",
};

/** Nilai tersimpan untuk tiap fitur. */
export interface FeatureSettings {
  terminal: boolean;
  browser: boolean;
}

/** Status efektif satu fitur: menyala atau mati, dan terkunci env atau tidak. */
export interface FeatureState {
  enabled: boolean;
  locked: boolean;
}

export type FeatureStatus = Record<FeatureName, FeatureState>;

/** Galat konfigurasi fitur (isi berkas atau permintaan tak valid). */
export class FeatureStoreError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "FeatureStoreError";
  }
}

export function defaultFeatureSettings(): FeatureSettings {
  return { terminal: false, browser: false };
}

export function featureSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "features.json");
}

/**
 * Validasi ketat: hanya kunci yang dikenal dan hanya nilai boolean.
 * Kunci asing atau nilai lain dianggap berkas tidak valid.
 */
export function parseFeatureSettings(raw: unknown): FeatureSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FeatureStoreError("Berkas fitur harus berisi objek JSON.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
      throw new FeatureStoreError(`Fitur "${key}" tidak dikenal.`);
    }
    if (typeof record[key] !== "boolean") {
      throw new FeatureStoreError(`Nilai fitur "${key}" harus berupa boolean.`);
    }
  }
  return {
    terminal: record.terminal === true,
    browser: record.browser === true,
  };
}

/**
 * Status efektif satu fitur: env menang atas berkas.
 * `JEJAK_…=1` memaksa menyala, `JEJAK_…=0` memaksa mati; keduanya mengunci
 * saklar supaya UI tahu nilainya tak bisa diubah dari Pengaturan.
 */
export function resolveFeature(
  name: FeatureName,
  env: Record<string, string | undefined>,
  stored: FeatureSettings,
): FeatureState {
  const raw = env[FEATURE_ENV[name]]?.trim();
  if (raw === "1") return { enabled: true, locked: true };
  if (raw === "0") return { enabled: false, locked: true };
  return { enabled: stored[name], locked: false };
}

/** Penyimpanan status fitur; berkas JSON atomik di JEJAK_HOME. */
export interface FeatureStore {
  get(): FeatureSettings;
  /** Patch atomik: seluruh nilai divalidasi sebelum disimpan. */
  set(patch: Partial<FeatureSettings>): FeatureSettings;
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileFeatureStore implements FeatureStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private settings: FeatureSettings | undefined;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
  }

  /** Baca toleran: berkas tak ada, tak terbaca, atau rusak berarti default. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.settings = defaultFeatureSettings();
    if (this.inMemory) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Berkas tak ada: default; berkas tak terbaca juga default dan tidak
      // ditimpa sampai ada `set` pertama.
      return;
    }

    try {
      this.settings = parseFeatureSettings(JSON.parse(raw));
    } catch {
      // Berkas rusak: pakai default.
      this.settings = defaultFeatureSettings();
    }
  }

  private persist(settings: FeatureSettings): void {
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const body = `${JSON.stringify(
      { terminal: settings.terminal, browser: settings.browser },
      null,
      2,
    )}\n`;
    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;

    try {
      writeFileSync(tempPath, body, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Berkas sementara mungkin sudah hilang; galat asli yang dilempar.
      }
      throw error;
    }
  }

  get(): FeatureSettings {
    this.load();
    return { ...(this.settings ?? defaultFeatureSettings()) };
  }

  set(patch: Partial<FeatureSettings>): FeatureSettings {
    this.load();
    const next = { ...(this.settings ?? defaultFeatureSettings()) };

    for (const key of Object.keys(patch)) {
      if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
        throw new FeatureStoreError(`Fitur "${key}" tidak dikenal.`);
      }
    }
    if (patch.terminal !== undefined) {
      if (typeof patch.terminal !== "boolean") {
        throw new FeatureStoreError('Nilai fitur "terminal" harus berupa boolean.');
      }
      next.terminal = patch.terminal;
    }
    if (patch.browser !== undefined) {
      if (typeof patch.browser !== "boolean") {
        throw new FeatureStoreError('Nilai fitur "browser" harus berupa boolean.');
      }
      next.browser = patch.browser;
    }

    this.settings = next;
    this.persist(next);
    return { ...next };
  }
}

/** Penyimpanan bawaan: berkas di JEJAK_HOME. */
export function defaultFeatureStore(
  env: Record<string, string | undefined> = process.env,
): FeatureStore {
  return new FileFeatureStore(featureSettingsPath(env));
}
