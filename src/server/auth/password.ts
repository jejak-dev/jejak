import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** Nama variabel lingkungan yang menyimpan kata sandi. */
export const PASSWORD_ENV = "JEJAK_PASSWORD";
/** Panjang minimal kata sandi (kecuali sandi acak otomatis). */
export const MIN_PASSWORD_LENGTH = 8;
/** Panjang sandi acak otomatis (base32 tanpa padding). */
export const AUTO_PASSWORD_LENGTH = 24;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Galat konfigurasi kata sandi (sumber tidak bisa dibaca atau sandi terlalu pendek). */
export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

/** Ubah byte acak menjadi base32 tanpa padding. */
export function base32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Kata sandi acak 24 karakter base32 dari sumber acak kriptografis. */
export function generateAutoPassword(): string {
  // 15 byte = 120 bit = 24 karakter base32.
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return base32(bytes);
}

export interface ResolvePasswordOptions {
  /** Berkas yang berisi kata sandi (dipangkas whitespace akhir). */
  passwordFile?: string;
  /** Sumber nilai lingkungan; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Buat kata sandi acak bila sumber lain tidak tersedia. */
  auto?: boolean;
}

/**
 * Tentukan kata sandi aktif: berkas, lalu `JEJAK_PASSWORD`, lalu acak.
 * Nilai `undefined` berarti autentikasi tidak aktif.
 */
export function resolvePassword(options: ResolvePasswordOptions = {}): string | undefined {
  const env = options.env ?? process.env;

  if (options.passwordFile !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(options.passwordFile, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PasswordError(`Tidak bisa membaca berkas kata sandi: ${detail}`);
    }
    const password = raw.trim();
    if (password === "") {
      throw new PasswordError("Berkas kata sandi kosong.");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new PasswordError(
        `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter (dari berkas: ${password.length}).`,
      );
    }
    return password;
  }

  const fromEnv = env[PASSWORD_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (fromEnv.length < MIN_PASSWORD_LENGTH) {
      throw new PasswordError(
        `Kata sandi dari ${PASSWORD_ENV} minimal ${MIN_PASSWORD_LENGTH} karakter (terbaca ${fromEnv.length}).`,
      );
    }
    return fromEnv;
  }

  if (options.auto === true) {
    return generateAutoPassword();
  }

  return undefined;
}

export interface PasswordVerifier {
  /** True bila input sama dengan kata sandi yang diikat. */
  verify(input: string): boolean;
}

function digestOf(salt: Uint8Array, password: string): Buffer {
  return createHash("sha256").update(salt).update(password, "utf8").digest();
}

/**
 * Verifier kata sandi: hanya digest SHA-256 dengan salt acak per proses yang disimpan.
 * Teks polos tidak disimpan setelah digest dibuat; perbandingan memakai timing-safe.
 */
export function createVerifier(password: string): PasswordVerifier {
  const salt = randomBytes(16);
  const digest = digestOf(salt, password);
  return {
    verify(input: string): boolean {
      const candidate = digestOf(salt, typeof input === "string" ? input : "");
      return timingSafeEqual(digest, candidate);
    },
  };
}
