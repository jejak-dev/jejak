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
  /** Hostname publik Cloudflare Tunnel; `undefined` bila belum diatur. */
  publicHost?: string;
  /** True bila tunnel Cloudflare diizinkan menyala. */
  tunnelEnabled: boolean;
}

/** Pengaturan bawaan: akses jaringan mati, port bawaan, tunnel mati. */
export function defaultNetworkSettings(): NetworkSettings {
  return {
    version: NETWORK_STORE_VERSION,
    enabled: false,
    port: DEFAULT_NETWORK_PORT,
    tunnelEnabled: false,
  };
}

/**
 * True bila nilai sah sebagai hostname publik tunnel: huruf kecil, FQDN
 * minimal dua label, tiap label 1-63 karakter `[a-z0-9-]` tanpa '-' di ujung,
 * bukan IP, tanpa port/skema/path/wildcard.
 */
export function isValidPublicHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "" || value.length > 253) return false;
  if (value !== value.toLowerCase()) return false;
  if (value.includes(":") || value.includes("/") || value.includes("*")) return false;
  if (value.includes(" ") || value.includes("\t") || value.includes("\n")) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  // Semua label angka berarti IPv4, bukan nama host.
  if (labels.every((label) => /^\d+$/.test(label))) return false;
  return true;
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
  // Field tunnel opsional: berkas lama tanpa field berarti tunnel mati.
  const publicHost = isValidPublicHost(record.publicHost) ? record.publicHost : undefined;
  return {
    version: NETWORK_STORE_VERSION,
    enabled: record.enabled,
    port: record.port,
    ...(publicHost === undefined ? {} : { publicHost }),
    tunnelEnabled: record.tunnelEnabled === true,
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
    const publicHost = isValidPublicHost(settings.publicHost) ? settings.publicHost : undefined;
    const body = `${JSON.stringify(
      {
        version: NETWORK_STORE_VERSION,
        enabled: settings.enabled === true,
        port,
        ...(publicHost === undefined ? {} : { publicHost }),
        tunnelEnabled: settings.tunnelEnabled === true,
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
