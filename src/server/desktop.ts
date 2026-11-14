import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import type { SessionCodec } from "./auth/session-cookie";
import type { Throttle } from "./auth/throttle";
import { isSecureRequest, socketAddress } from "./routes/auth";

/** Nama variabel lingkungan yang menyimpan token masuk mode desktop. */
export const DESKTOP_TOKEN_ENV = "JEJAK_DESKTOP_TOKEN";
/** Panjang minimal token desktop (karakter). */
export const DESKTOP_MIN_TOKEN_LENGTH = 32;
/** Masa berlaku cookie sesi mode desktop (30 hari). */
export const DESKTOP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Path rute masuk sekali pakai. */
export const DESKTOP_ENTER_PATH = "/__desktop/enter";
/** Awalan baris pengumuman server siap (baca mesin). */
export const DESKTOP_READY_PREFIX = "JEJAK_READY";

/** Galat token desktop (kosong, terlalu pendek, atau karakter tak sah). */
export class DesktopTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopTokenError";
  }
}

/** True bila token sah: panjang minimal dan hanya karakter base64url. */
export function isValidDesktopToken(value: string): boolean {
  return (
    value.length >= DESKTOP_MIN_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Baca token desktop dari lingkungan lalu HAPUS dari sumber itu supaya tidak
 * diwarisi proses anak (agent, Bash, terminal). Token tak valid tetap dihapus.
 */
export function readDesktopToken(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[DESKTOP_TOKEN_ENV];
  delete env[DESKTOP_TOKEN_ENV];
  const token = (raw ?? "").trim();
  if (token === "") {
    throw new DesktopTokenError(
      `${DESKTOP_TOKEN_ENV} wajib diisi untuk mode --desktop ` +
        `(minimal ${DESKTOP_MIN_TOKEN_LENGTH} karakter).`,
    );
  }
  if (!isValidDesktopToken(token)) {
    throw new DesktopTokenError(
      `${DESKTOP_TOKEN_ENV} tidak sah: panjang minimal ${DESKTOP_MIN_TOKEN_LENGTH} karakter ` +
        "dan hanya boleh berisi A-Z, a-z, 0-9, '-' dan '_'.",
    );
  }
  return token;
}

/**
 * Kata sandi internal mode desktop: 32 byte acak base64url.
 * Tidak pernah dicetak dan tidak bisa ditebak siapa pun.
 */
export function generateDesktopPassword(): string {
  return randomBytes(32).toString("base64url");
}

export interface DesktopEnterOptions {
  /** Token masuk sekali pakai. */
  token: string;
  /** Codec cookie sesi yang sama dengan login biasa. */
  codec: SessionCodec;
  /** Throttle login yang sama dengan rute `/api/auth/login`. */
  throttle: Throttle;
  /** Paksa penanda `Secure` pada cookie sesi. */
  secureCookie?: boolean;
}

/** Header anti-bocor untuk semua respons rute masuk desktop. */
const NO_STORE_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
      ...headers,
    },
  });
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Rute masuk mode desktop: token sekali pakai, cookie sesi, lalu 302 ke `/`.
 * Token polos tidak disimpan; yang dipakai hanya digest-nya.
 */
export function desktopEnterRoutes(options: DesktopEnterOptions): Elysia {
  const codec = options.codec;
  const throttle = options.throttle;
  const secureCookie = options.secureCookie;
  const digest = digestOf(options.token);
  let used = false;

  const plugin = new Elysia({ name: "jejak-desktop-enter" }).get(
    DESKTOP_ENTER_PATH,
    ({ request, server }) => {
      const url = new URL(request.url);
      const provided = url.searchParams.get("t") ?? "";
      if (provided === "") {
        return jsonResponse(400, { error: "token masuk tidak ada" });
      }

      const address = socketAddress(server, request);
      const blocked = throttle.check(address);
      if (blocked.blocked) {
        return jsonResponse(
          429,
          { error: "terlalu banyak percobaan" },
          { "retry-after": String(blocked.retryAfterSec) },
        );
      }

      // Bandingkan digest (panjang selalu sama) agar timingSafeEqual tak
      // melempar saat panjang token berbeda.
      const cocok = timingSafeEqual(digest, digestOf(provided));
      if (!cocok) {
        throttle.fail(address);
        return jsonResponse(403, { error: "token masuk tidak sah" });
      }
      if (used) {
        return jsonResponse(403, { error: "token masuk sudah dipakai" });
      }
      used = true;
      throttle.succeed(address);

      const secure = secureCookie ?? isSecureRequest(request);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": codec.serialize(codec.issue(), { secure }),
          ...NO_STORE_HEADERS,
        },
      });
    },
  );

  return plugin as unknown as Elysia;
}
