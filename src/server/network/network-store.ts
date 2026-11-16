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

/** Versi berkas pengaturan jaringan. */
export const NETWORK_STORE_VERSION = 1;
/** Port bawaan listener jaringan. */
export const DEFAULT_NETWORK_PORT = 4747;
/** Port terkecil yang boleh dipakai (di atas port hakIstimewa). */
export const MIN_NETWORK_PORT = 1024;
/** Port terbesar yang sah. */
export const MAX_NETWORK_PORT = 65535;

/** Pengaturan jaringan tersimpan di `<JEJAK_HOME>/network.json`. */
export interface NetworkSettings {
  version: number;
  /** True bila akses dari jaringan diizinkan. */
  enabled: boolean;
  /** Port listener jaringan. */
  port: number;
}

/** Pengaturan bawaan: akses jaringan mati, port bawaan. */
export function defaultNetworkSettings(): NetworkSettings {
  return {
    version: NETWORK_STORE_VERSION,
    enabled: false,
    port: DEFAULT_NETWORK_PORT,
  };
}

/** True bila port sah untuk listener jaringan (1024-65535). */
export function isValidNetworkPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= MIN_NETWORK_PORT &&
    port <= MAX_NETWORK_PORT
  );
}

/** Jalur berkas pengaturan jaringan di dalam JEJAK_HOME. */
export function networkStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "network.json");
}

/** Penyimpanan pengaturan jaringan. */
export interface NetworkStore {
  /** Baca pengaturan tersimpan; berkas rusak dihitung bawaan. */
  load(): NetworkSettings;
  /** Simpan pengaturan (tulis atomik, mode 0600). */
  save(settings: NetworkSettings): void;
}

/**
 * Parse isi berkas pengaturan jaringan. Nilai tak dikenal atau port tak sah
 * dianggap berkas rusak: pemanggil memakai bawaan.
 */
export function parseNetworkSettings(raw: unknown): NetworkSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== NETWORK_STORE_VERSION) return undefined;
  if (typeof record.enabled !== "boolean") return undefined;
  if (!isValidNetworkPort(record.port)) return undefined;
  return {
    version: NETWORK_STORE_VERSION,
    enabled: record.enabled,
    port: record.port,
  };
}

/**
 * Penyimpanan pengaturan jaringan di berkas JSON: `<JEJAK_HOME>/network.json`
 * (mode 0600). Berkas rusak dibaca sebagai bawaan dan tak pernah melempar.
 */
export class FileNetworkStore implements NetworkStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Lokasi berkas; berguna untuk pesan dan tes. */
  get filePath(): string {
    return this.path;
  }

  load(): NetworkSettings {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Belum ada atau tak bisa dibaca: bawaan.
      return defaultNetworkSettings();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Berkas rusak: bawaan.
      return defaultNetworkSettings();
    }
    return parseNetworkSettings(parsed) ?? defaultNetworkSettings();
  }

  save(settings: NetworkSettings): void {
    const port = isValidNetworkPort(settings.port) ? settings.port : DEFAULT_NETWORK_PORT;
    const body = `${JSON.stringify(
      {
        version: NETWORK_STORE_VERSION,
        enabled: settings.enabled === true,
        port,
      },
      null,
      2,
    )}\n`;

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawahnya.
    }

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
}

/** Penyimpanan bawaan: berkas di dalam JEJAK_HOME. */
export function defaultNetworkStore(
  env: Record<string, string | undefined> = process.env,
): NetworkStore {
  return new FileNetworkStore(networkStorePath(env));
}
