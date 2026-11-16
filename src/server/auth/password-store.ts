import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
import { MIN_PASSWORD_LENGTH, type PasswordVerifier } from "./password";

/** Panjang maksimum kata sandi yang diterima. */
export const MAX_PASSWORD_LENGTH = 256;
/** Versi berkas penyimpanan sandi. */
export const PASSWORD_STORE_VERSION = 1;
/** Parameter scrypt yang dipakai (N = 2^15). */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
/** Panjang hash (byte). */
const KEY_LENGTH = 32;
/** Panjang salt (byte). */
const SALT_LENGTH = 16;
/** Batas atas parameter dari berkas; melindungi dari berkas rusak/bermusuhan. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

/** Galat penyimpanan sandi (mis. panjang sandi tak valid). */
export class PasswordStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordStoreError";
  }
}

/** Parameter scrypt yang dipakai sebuah rekaman. */
export interface PasswordParams {
  N: number;
  r: number;
  p: number;
}

/** Isi berkas `auth.json`; hash dan salt base64. */
export interface PasswordRecord {
  version: number;
  salt: string;
  hash: string;
  params: PasswordParams;
  updatedAt: string;
}

/** Penyimpanan sandi milik pengguna. */
export interface PasswordStore {
  /** True bila ada sandi tersimpan yang sah (berkas rusak dihitung belum ada). */
  has(): boolean;
  /** Baca sandi tersimpan; `undefined` bila belum ada atau berkas rusak. */
  load(): PasswordRecord | undefined;
  /** Simpan sandi baru (mengganti yang lama); mengembalikan rekaman tersimpan. */
  set(password: string): PasswordRecord;
  /** Hapus sandi tersimpan; `true` bila ada yang dihapus. */
  clear(): boolean;
  /** Cocokkan input dengan sandi tersimpan; perbandingan timing-safe. */
  verify(input: string): boolean;
}

/** Verifier yang sumbernya penyimpanan sandi. */
export interface StoreVerifier extends PasswordVerifier {
  /** Penanda: verifier ini membaca dari penyimpanan sandi. */
  readonly storeVerifier: true;
}

/** Jalur berkas penyimpanan sandi di dalam JEJAK_HOME. */
export function authStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Batas memori scrypt: 128 * N * r * 2 byte. */
function maxmemFor(params: PasswordParams): number {
  return 128 * params.N * params.r * 2;
}

/** Hitung hash scrypt; byte salt dan password dipakai apa adanya. */
function derive(password: string, salt: Buffer, params: PasswordParams): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

/**
 * Penyimpanan sandi di berkas JSON: `<JEJAK_HOME>/auth.json` (mode 0600).
 * Berkas rusak dianggap belum ada sandi dan tak pernah melempar saat dibaca.
 */
export class FilePasswordStore implements PasswordStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Lokasi berkas; berguna untuk pesan dan tes. */
  get filePath(): string {
    return this.path;
  }

  private read(): PasswordRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Belum ada atau tak bisa dibaca: anggap belum ada sandi.
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Berkas rusak: anggap belum ada sandi.
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    if (parsed.version !== PASSWORD_STORE_VERSION) return undefined;

    const { salt, hash } = parsed;
    if (typeof salt !== "string" || typeof hash !== "string") return undefined;
    const saltBytes = Buffer.from(salt, "base64");
    const hashBytes = Buffer.from(hash, "base64");
    if (saltBytes.length !== SALT_LENGTH) return undefined;
    if (hashBytes.length !== KEY_LENGTH) return undefined;

    const rawParams = parsed.params;
    if (!isRecord(rawParams)) return undefined;
    const { N, r, p } = rawParams;
    if (!isPositiveInt(N) || !isPositiveInt(r) || !isPositiveInt(p)) return undefined;
    if (N > MAX_N || r > MAX_R || p > MAX_P) return undefined;
    if ((N & (N - 1)) !== 0) return undefined;

    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    return {
      version: PASSWORD_STORE_VERSION,
      salt,
      hash,
      params: { N, r, p },
      updatedAt,
    };
  }

  private persist(record: PasswordRecord): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawahnya.
    }

    const body = `${JSON.stringify(record, null, 2)}\n`;
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

  has(): boolean {
    return this.read() !== undefined;
  }

  load(): PasswordRecord | undefined {
    return this.read();
  }

  set(password: string): PasswordRecord {
    if (typeof password !== "string") {
      throw new PasswordStoreError("Kata sandi harus berupa teks.");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new PasswordStoreError(
        `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter (dimasukkan ${password.length}).`,
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new PasswordStoreError(
        `Kata sandi maksimal ${MAX_PASSWORD_LENGTH} karakter (dimasukkan ${password.length}).`,
      );
    }

    const params: PasswordParams = { ...SCRYPT_PARAMS };
    const salt = randomBytes(SALT_LENGTH);
    const hash = derive(password, salt, params);
    const record: PasswordRecord = {
      version: PASSWORD_STORE_VERSION,
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      params,
      updatedAt: new Date().toISOString(),
    };
    this.persist(record);
    return record;
  }

  clear(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  verify(input: string): boolean {
    const record = this.read();
    if (record === undefined) return false;
    const candidate = typeof input === "string" ? input : "";
    let actual: Buffer;
    try {
      actual = derive(candidate, Buffer.from(record.salt, "base64"), record.params);
    } catch {
      // Parameter rusak: tak ada yang cocok.
      return false;
    }
    const expected = Buffer.from(record.hash, "base64");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/** Penyimpanan sandi bawaan: berkas di dalam JEJAK_HOME. */
export function defaultPasswordStore(
  env: Record<string, string | undefined> = process.env,
): PasswordStore {
  return new FilePasswordStore(authStorePath(env));
}

/** Verifier yang membaca langsung dari penyimpanan sandi. */
export function createStoreVerifier(store: PasswordStore): StoreVerifier {
  return {
    storeVerifier: true,
    verify(input: string): boolean {
      return store.verify(input);
    },
  };
}

/** True bila verifier ini bersumber dari penyimpanan sandi. */
export function isStoreVerifier(value: PasswordVerifier): value is StoreVerifier {
  return (value as StoreVerifier).storeVerifier === true;
}
