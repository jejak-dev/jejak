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

/** Panjang maksimum token tunnel yang diterima. */
export const MAX_TUNNEL_TOKEN_LENGTH = 4096;

/** Galat token tunnel tak sah. */
export class TunnelTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelTokenError";
  }
}

/** True bila nilai sah sebagai token tunnel: teks tanpa spasi/baris baru. */
export function isValidTunnelToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "" || value.length > MAX_TUNNEL_TOKEN_LENGTH) return false;
  return !/[\s]/.test(value);
}

/** Jalur berkas token tunnel di dalam JEJAK_HOME. */
export function tunnelTokenPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "tunnel-token");
}

/** Penyimpanan token tunnel (rahasia; tak pernah dikembalikan ke klien). */
export interface TunnelTokenStore {
  /** True bila token tersimpan ada. */
  has(): boolean;
  /** Baca token tersimpan; `undefined` bila belum ada. */
  get(): string | undefined;
  /** Simpan token (tulis atomik, mode 0600). */
  set(token: string): void;
  /** Hapus token; `true` bila ada yang dihapus. */
  clear(): boolean;
}

/**
 * Penyimpanan token di berkas teks: `<JEJAK_HOME>/tunnel-token` (mode 0600).
 * Berkas rusak atau kosong dianggap belum ada token.
 */
export class FileTunnelTokenStore implements TunnelTokenStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Lokasi berkas; berguna untuk pesan dan tes. */
  get filePath(): string {
    return this.path;
  }

  has(): boolean {
    return this.get() !== undefined;
  }

  get(): string | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return undefined;
    }
    const token = raw.trim();
    return isValidTunnelToken(token) ? token : undefined;
  }

  set(token: string): void {
    if (!isValidTunnelToken(token)) {
      throw new TunnelTokenError(
        `Token tunnel harus teks tanpa spasi, maksimal ${MAX_TUNNEL_TOKEN_LENGTH} karakter.`,
      );
    }

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawahnya.
    }

    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${token}\n`, { mode: 0o600 });
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

  clear(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }
}

/** Penyimpanan bawaan: berkas di dalam JEJAK_HOME. */
export function defaultTunnelTokenStore(
  env: Record<string, string | undefined> = process.env,
): TunnelTokenStore {
  return new FileTunnelTokenStore(tunnelTokenPath(env));
}
