import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { PasswordVerifier } from "../auth/password";
import { parseCookies, type SessionCodec } from "../auth/session-cookie";
import type { Throttle } from "../auth/throttle";

export interface AuthRoutesOptions {
  /** Verifier kata sandi; `undefined` berarti autentikasi tidak aktif. */
  verifier?: PasswordVerifier;
  /** Codec cookie sesi; `undefined` berarti autentikasi tidak aktif. */
  codec?: SessionCodec;
  /** Throttle login per alamat socket. */
  throttle: Throttle;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
  /** Paksa penanda `Secure` pada cookie. */
  secureCookie?: boolean;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Alamat socket klien; header `x-forwarded-for` tidak dipercaya. */
function socketAddress(server: { requestIP(request: Request): { address: string } | null } | null, request: Request): string {
  try {
    const info = server?.requestIP(request);
    return info?.address ?? "tidak-diketahui";
  } catch {
    return "tidak-diketahui";
  }
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

/** Rute autentikasi: status, login, dan logout. */
export function authRoutes(options: AuthRoutesOptions): Elysia {
  const verifier = options.verifier;
  const codec = options.codec;
  const throttle = options.throttle;
  const audit = options.audit;
  const active = verifier !== undefined && codec !== undefined;

  const auditAuth = (aksi: string, alamat: string): void => {
    recordAudit(audit, {
      kind: "pengaturan",
      summary: `Autentikasi: ${aksi}`,
      meta: { aksi, alamat },
    });
  };

  const plugin = new Elysia({ name: "jejak-auth-routes" })
    .get("/api/auth/status", ({ request }): AuthStatus => {
      if (!active || codec === undefined) {
        return { required: false, authenticated: true };
      }
      const cookies = parseCookies(request.headers.get("cookie"));
      const value = cookies[codec.cookieName];
      return {
        required: true,
        authenticated: value !== undefined && codec.verify(value),
      };
    })
    .post(
      "/api/auth/login",
      ({ request, body, server }) => {
        if (!active || verifier === undefined || codec === undefined) {
          return jsonResponse(404, { error: "autentikasi tidak aktif" });
        }

        const payload = parseBody(body);
        const password = typeof payload.password === "string" ? payload.password : "";
        const address = socketAddress(server, request);
        const blocked = throttle.check(address);
        // Verifikasi tetap dijalankan walau diblokir agar waktu respons seragam.
        const correct = verifier.verify(password);

        if (blocked.blocked) {
          auditAuth("terblokir-throttle", address);
          return jsonResponse(
            429,
            { error: "terlalu banyak percobaan" },
            { "retry-after": String(blocked.retryAfterSec) },
          );
        }

        if (!correct) {
          throttle.fail(address);
          auditAuth("masuk-gagal", address);
          return jsonResponse(401, { error: "sandi salah" });
        }

        throttle.succeed(address);
        auditAuth("masuk-berhasil", address);
        const secure = options.secureCookie ?? isSecureRequest(request);
        const value = codec.issue();
        return jsonResponse(200, { ok: true }, { "set-cookie": codec.serialize(value, { secure }) });
      },
      { parse: "text" },
    )
    .post(
      "/api/auth/logout",
      ({ request, server }) => {
        if (!active || codec === undefined) {
          return jsonResponse(404, { error: "autentikasi tidak aktif" });
        }
        const address = socketAddress(server, request);
        auditAuth("keluar", address);
        const secure = options.secureCookie ?? isSecureRequest(request);
        return jsonResponse(200, { ok: true }, { "set-cookie": codec.clear({ secure }) });
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
