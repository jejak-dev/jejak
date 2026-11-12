import { Elysia } from "elysia";
import { parseCookies, type SessionCodec } from "./session-cookie";

/**
 * Path yang tetap terbuka walau autentikasi aktif.
 * Cocok persis (bukan awalan longgar) agar `/api/healthx` atau
 * `/api/health/../x` tidak ikut terbuka.
 */
export const AUTH_OPEN_PATHS: readonly string[] = [
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
];

export interface AuthGuardOptions {
  /** Codec cookie sesi. */
  codec: SessionCodec;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "perlu login" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Penjaga autentikasi global: hanya berlaku untuk path `/api/`.
 * Path di luar `/api/` (aset klien) dan `/mcp` tidak disentuh.
 */
export function authGuard(options: AuthGuardOptions): Elysia {
  const codec = options.codec;

  const plugin = new Elysia({ name: "jejak-auth-guard" }).onBeforeHandle(
    { as: "global" },
    ({ request }) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (!pathname.startsWith("/api/")) return;
      if (AUTH_OPEN_PATHS.includes(pathname)) return;

      const cookies = parseCookies(request.headers.get("cookie"));
      const value = cookies[codec.cookieName];
      if (value !== undefined && codec.verify(value)) return;

      return unauthorized();
    },
  );

  return plugin as unknown as Elysia;
}
