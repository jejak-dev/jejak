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

/** Variabel lingkungan yang mengunci sinkron ke Claude Code. */
export const MEMORY_SYNC_ENV = "JEJAK_CLAUDE_SYNC";

/** Nilai tersimpan untuk sinkron memory. */
export interface MemorySyncSettings {
  /** True bila memory proyek Jejak ditulis ke folder memory Claude Code. */
  claude: boolean;
}

/** Status efektif sinkron: menyala atau mati, dan terkunci env atau tidak. */
export interface MemorySyncState {
  enabled: boolean;
  locked: boolean;
}

/** Galat konfigurasi sinkron (isi berkas atau permintaan tak valid). */
export class MemorySyncStoreError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemorySyncStoreError";
  }
}

export function defaultMemorySyncSettings(): MemorySyncSettings {
  return { claude: false };
}

export function memorySyncSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "memory-sync.json");
}

/**
 * Validasi ketat: hanya kunci yang dikenal dan hanya nilai boolean.
 * Kunci asing atau nilai lain dianggap berkas tidak valid.
 */
export function parseMemorySyncSettings(raw: unknown): MemorySyncSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MemorySyncStoreError("Berkas sinkron harus berisi objek JSON.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "claude") {
      throw new MemorySyncStoreError(`Pengaturan "${key}" tidak dikenal.`);
    }
    if (typeof record[key] !== "boolean") {
      throw new MemorySyncStoreError(`Nilai "${key}" harus berupa boolean.`);
    }
  }
  return { claude: record.claude === true };
}

/**
 * Status efektif sinkron: env menang atas berkas. `JEJAK_CLAUDE_SYNC=1`
 * memaksa menyala, `=0` memaksa mati; keduanya mengunci saklar.
 */
export function resolveMemorySync(
  env: Record<string, string | undefined>,
  stored: MemorySyncSettings,
): MemorySyncState {
  const raw = env[MEMORY_SYNC_ENV]?.trim();
  if (raw === "1") return { enabled: true, locked: true };
  if (raw === "0") return { enabled: false, locked: true };
  return { enabled: stored.claude, locked: false };
}

/** Penyimpanan status sinkron. */
export interface MemorySyncStore {
  get(): MemorySyncSettings;
  /** Patch atomik: seluruh nilai divalidasi sebelum disimpan. */
  set(patch: Partial<MemorySyncSettings>): MemorySyncSettings;
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileMemorySyncStore implements MemorySyncStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private settings: MemorySyncSettings | undefined;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
  }

  /** Baca toleran: berkas tak ada, tak terbaca, atau rusak berarti default. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.settings = defaultMemorySyncSettings();
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
      this.settings = parseMemorySyncSettings(JSON.parse(raw));
    } catch {
      // Berkas rusak: pakai default.
      this.settings = defaultMemorySyncSettings();
    }
  }

  private persist(settings: MemorySyncSettings): void {
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const body = `${JSON.stringify({ claude: settings.claude }, null, 2)}\n`;
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

  get(): MemorySyncSettings {
    this.load();
    return { ...(this.settings ?? defaultMemorySyncSettings()) };
  }

  set(patch: Partial<MemorySyncSettings>): MemorySyncSettings {
    this.load();
    const next = { ...(this.settings ?? defaultMemorySyncSettings()) };
    for (const key of Object.keys(patch)) {
      if (key !== "claude") {
        throw new MemorySyncStoreError(`Pengaturan "${key}" tidak dikenal.`);
      }
    }
    if (patch.claude !== undefined) {
      if (typeof patch.claude !== "boolean") {
        throw new MemorySyncStoreError('Nilai "claude" harus berupa boolean.');
      }
      next.claude = patch.claude;
    }
    this.settings = next;
    this.persist(next);
    return { ...next };
  }
}

/** Penyimpanan bawaan: berkas di JEJAK_HOME. */
export function defaultMemorySyncStore(
  env: Record<string, string | undefined> = process.env,
): MemorySyncStore {
  return new FileMemorySyncStore(memorySyncSettingsPath(env));
}
