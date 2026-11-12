import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Masa berlaku cookie sesi (12 jam, tanpa sliding). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Awalan nama cookie sesi; suffiks nama adalah port server. */
export const SESSION_COOKIE_PREFIX = "jejak_sid_";

export interface SessionCodecOptions {
  /** Kunci HMAC; default acak 32 byte per proses. */
  key?: Uint8Array;
  /** Sumber waktu (ms epoch); default `Date.now`. */
  now?: () => number;
  /** Masa berlaku cookie; default 12 jam. */
  ttlMs?: number;
  /** Port server; dipakai pada nama cookie. */
  port: number;
}

export interface CookieOptions {
  /** Tandai cookie sebagai `Secure` (permintaan lewat HTTPS). */
  secure?: boolean;
}

export interface SessionCodec {
  /** Nama cookie sesi, berbeda per port. */
  cookieName: string;
  /** Terbitkan nilai cookie baru. */
  issue(): string;
  /** True bila nilai cookie sah dan belum kedaluwarsa. */
  verify(value: string): boolean;
  /** Susun nilai cookie untuk header `set-cookie`. */
  serialize(value: string, options?: CookieOptions): string;
  /** Susun cookie kosong (Max-Age=0) untuk logout. */
  clear(options?: CookieOptions): string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sign(key: Uint8Array, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/**
 * Codec cookie sesi stateless: nilai `exp.nonce.hmac`.
 * Kunci acak per proses; restart server membatalkan semua sesi.
 */
export function createSessionCodec(options: SessionCodecOptions): SessionCodec {
  const key = options.key === undefined ? randomBytes(32) : Buffer.from(options.key);
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const cookieName = `${SESSION_COOKIE_PREFIX}${options.port}`;

  const verify = (value: string): boolean => {
    if (typeof value !== "string" || value === "") return false;
    const parts = value.split(".");
    if (parts.length !== 3) return false;
    const [exp, nonce, mac] = parts as [string, string, string];
    if (!/^\d+$/.test(exp)) return false;
    if (nonce === "" || mac === "") return false;
    if (Number(exp) <= now()) return false;
    const expected = sign(key, `${exp}.${nonce}`);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(mac, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const attributes = (extra: string[], secure: boolean): string =>
    [
      ...extra,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      ...(secure ? ["Secure"] : []),
    ].join("; ");

  return {
    cookieName,
    issue(): string {
      const exp = now() + ttlMs;
      const nonce = randomBytes(12).toString("base64url");
      return `${exp}.${nonce}.${sign(key, `${exp}.${nonce}`)}`;
    },
    verify,
    serialize(value: string, cookieOptions: CookieOptions = {}): string {
      const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
      return attributes(
        [`${cookieName}=${value}`, `Max-Age=${maxAge}`],
        cookieOptions.secure === true,
      );
    },
    clear(cookieOptions: CookieOptions = {}): string {
      return attributes([`${cookieName}=`, "Max-Age=0"], cookieOptions.secure === true);
    },
  };
}

/** Baca header `cookie` menjadi peta nama -> nilai. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null || header === undefined || header === "") return out;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (name === "") continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}
