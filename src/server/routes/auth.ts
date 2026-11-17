import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { MAX_PASSWORD_LENGTH, type PasswordStore } from "../auth/password-store";
import { MIN_PASSWORD_LENGTH, type PasswordVerifier } from "../auth/password";
import { parseCookies, type SessionCodec } from "../auth/session-cookie";
import type { Throttle } from "../auth/throttle";
import { PEER_HEADER, SECURE_HEADER } from "../network/network-fetch";
import {
  recordNetworkAudit,
  type NetworkManager,
} from "../network/network-manager";

export interface AuthRoutesOptions {
  /** Verifier kata sandi; `undefined` berarti autentikasi tidak aktif. */
  verifier?: PasswordVerifier;
  /** Penyimpanan sandi milik pengguna; tanpa ini rute sandi menjawab 404. */
  passwordStore?: PasswordStore;
  /** Codec cookie sesi; `undefined` berarti autentikasi tidak aktif. */
  codec?: SessionCodec;
  /** Throttle login per alamat socket. */
  throttle: Throttle;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
  /** Paksa penanda `Secure` pada cookie. */
  secureCookie?: boolean;
  /** Mode desktop: sandi internal acak yang tak diketahui pengguna. */
  desktop?: boolean;
  /** Manajer akses jaringan; sandi dihapus berarti akses jaringan dimatikan. */
  network?: NetworkManager;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  /** True bila sandi dibuat pengguna sehingga bisa login dan keluar manual. */
  manualLogin: boolean;
}

/** Status sandi milik pengguna. */
export interface PasswordStatus {
  /** True bila sandi tersimpan ada. */
  configured: boolean;
  /** Waktu sandi terakhir diubah (ISO). */
  updatedAt?: string;
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

/**
 * Alamat socket klien; header `x-forwarded-for` tidak dipercaya.
 * Listener Jejak menulis `x-jejak-peer` dari socket sendiri, jadi throttle
 * berlaku per klien jaringan juga.
 */
export function socketAddress(server: { requestIP(request: Request): { address: string } | null } | null, request: Request): string {
  const header = request.headers.get(PEER_HEADER)?.trim();
  if (header !== undefined && header !== "") return header;
  try {
    const info = server?.requestIP(request);
    return info?.address ?? "tidak-diketahui";
  } catch {
    return "tidak-diketahui";
  }
}

/**
 * True bila permintaan tiba lewat HTTPS. Selain skema URL, listener jaringan
 * menandai permintaan tunnel (`x-jejak-secure`) setelah memeriksa header
 * proksi dari peer loopback pada host publik.
 */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  return request.headers.get(SECURE_HEADER) === "1";
}

/** Rute autentikasi: status, login, dan logout. */
export function authRoutes(options: AuthRoutesOptions): Elysia {
  const verifier = options.verifier;
  const codec = options.codec;
  const throttle = options.throttle;
  const audit = options.audit;
  const desktop = options.desktop === true;
  const store = options.passwordStore;
  const active = verifier !== undefined && codec !== undefined;
  /** True bila pengguna sudah punya sandi tersimpan. */
  const stored = (): boolean => store?.has() === true;

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
        return { required: false, authenticated: true, manualLogin: false };
      }
      const cookies = parseCookies(request.headers.get("cookie"));
      const value = cookies[codec.cookieName];
      return {
        required: true,
        authenticated: value !== undefined && codec.verify(value),
        // Mode desktop memakai sandi internal acak yang tak dikenal pengguna:
        // keluar manual baru mungkin bila ada sandi tersimpan milik pengguna.
        manualLogin: desktop ? stored() : true,
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
        // Mode desktop memakai sandi internal acak yang tak dikenal pengguna:
        // keluar hanya mungkin bila ada sandi tersimpan untuk masuk lagi.
        if (desktop && !stored()) {
          return jsonResponse(404, { error: "keluar tidak tersedia di aplikasi desktop" });
        }
        if (!active || codec === undefined) {
          return jsonResponse(404, { error: "autentikasi tidak aktif" });
        }
        const address = socketAddress(server, request);
        auditAuth("keluar", address);
        const secure = options.secureCookie ?? isSecureRequest(request);
        return jsonResponse(200, { ok: true }, { "set-cookie": codec.clear({ secure }) });
      },
      { parse: "text" },
    )
    .get("/api/auth/password", (): Response => {
      if (!active || codec === undefined || store === undefined) {
        return jsonResponse(404, { error: "autentikasi tidak aktif" });
      }
      const record = store.load();
      if (record === undefined) {
        return jsonResponse(200, { configured: false } satisfies PasswordStatus);
      }
      return jsonResponse(200, {
        configured: true,
        updatedAt: record.updatedAt,
      } satisfies PasswordStatus);
    })
    .put(
      "/api/auth/password",
      ({ request, body, server }) => {
        if (!active || codec === undefined || store === undefined) {
          return jsonResponse(404, { error: "autentikasi tidak aktif" });
        }

        const payload = parseBody(body);
        const password = typeof payload.password === "string" ? payload.password : "";
        const current = typeof payload.current === "string" ? payload.current : "";
        const address = socketAddress(server, request);
        const existing = store.load();

        // Bila sandi sudah ada, sandi lama wajib benar (throttle sama dengan login).
        if (existing !== undefined) {
          const blocked = throttle.check(address);
          const correct = store.verify(current);
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
            auditAuth("sandi-gagal", address);
            return jsonResponse(401, { error: "sandi lama salah" });
          }
          throttle.succeed(address);
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
          return jsonResponse(400, {
            error: `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter.`,
          });
        }
        if (password.length > MAX_PASSWORD_LENGTH) {
          return jsonResponse(400, {
            error: `Kata sandi maksimal ${MAX_PASSWORD_LENGTH} karakter.`,
          });
        }

        let updatedAt: string;
        try {
          updatedAt = store.set(password).updatedAt;
        } catch (error) {
          const detail = error instanceof Error ? error.message : "gagal menyimpan sandi";
          return jsonResponse(400, { error: detail });
        }
        // Audit hanya mencatat aksi; nilai sandi tak pernah ikut.
        auditAuth(existing === undefined ? "sandi-diatur" : "sandi-diganti", address);
        return jsonResponse(200, { ok: true, updatedAt });
      },
      { parse: "text" },
    )
    .delete(
      "/api/auth/password",
      async ({ request, body, server }) => {
        if (!active || codec === undefined || store === undefined) {
          return jsonResponse(404, { error: "autentikasi tidak aktif" });
        }
        if (store.load() === undefined) {
          return jsonResponse(404, { error: "belum ada sandi" });
        }

        const payload = parseBody(body);
        const current = typeof payload.current === "string" ? payload.current : "";
        const address = socketAddress(server, request);
        const blocked = throttle.check(address);
        const correct = store.verify(current);
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
          auditAuth("sandi-gagal", address);
          return jsonResponse(401, { error: "sandi lama salah" });
        }
        throttle.succeed(address);

        try {
          store.clear();
        } catch {
          return jsonResponse(500, { error: "gagal menghapus sandi" });
        }
        auditAuth("sandi-dihapus", address);
        // Tanpa sandi, akses dari jaringan harus ikut dimatikan.
        if (options.network !== undefined) {
          await options.network.onPasswordCleared();
          recordNetworkAudit(audit, "jaringan-dimatikan", options.network.status().port);
        }
        return jsonResponse(200, { ok: true });
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
