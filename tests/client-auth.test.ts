import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient } from "../src/client/lib/api";
import { followSession } from "../src/client/lib/sse";
import {
  canShowLogout,
  formatRetry,
  isAuthError,
  isLoopbackHostname,
  needsTlsWarning,
} from "../src/client/lib/auth";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("fungsi murni lib/auth", () => {
  test("isAuthError hanya recognizes 401", () => {
    expect(isAuthError(401)).toBe(true);
    expect(isAuthError(403)).toBe(false);
    expect(isAuthError(429)).toBe(false);
    expect(isAuthError(200)).toBe(false);
  });

  test("formatRetry menulis detik dan menit", () => {
    expect(formatRetry(5)).toBe("Coba lagi dalam 5 detik.");
    expect(formatRetry(1)).toBe("Coba lagi dalam 1 detik.");
    expect(formatRetry(120)).toBe("Coba lagi dalam 2 menit.");
    expect(formatRetry(0)).toBe("Coba lagi sebentar lagi.");
  });

  test("loopback dikenali", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("192.168.1.5")).toBe(false);
    expect(isLoopbackHostname("jejak.lan")).toBe(false);
  });

  test("peringatan tanpa TLS hanya di luar loopback dan tanpa https", () => {
    expect(needsTlsWarning("http:", "192.168.1.5")).toBe(true);
    expect(needsTlsWarning("https:", "192.168.1.5")).toBe(false);
    expect(needsTlsWarning("http:", "127.0.0.1")).toBe(false);
    expect(needsTlsWarning("http:", "localhost")).toBe(false);
  });

  test("tombol Keluar hanya tampil bila sandi manual ada", () => {
    // Mode desktop: sandi internal acak, tak bisa keluar manual.
    expect(canShowLogout({ required: true, authenticated: true, manualLogin: false })).toBe(false);
    // Sandi buatan pengguna.
    expect(canShowLogout({ required: true, authenticated: false, manualLogin: true })).toBe(true);
    // Tanpa autentikasi sama sekali.
    expect(canShowLogout({ required: false, authenticated: true, manualLogin: false })).toBe(false);
    // Server lama: field manualLogin tak ada, dianggap manual bila perlu login.
    expect(canShowLogout({ required: true, authenticated: false })).toBe(true);
    // Status belum diketahui.
    expect(canShowLogout(undefined)).toBe(false);
  });
});

describe("api klien untuk autentikasi", () => {
  test("getAuthStatus membaca status server", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ required: true, authenticated: false, manualLogin: true }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getAuthStatus()).toEqual({
      required: true,
      authenticated: false,
      manualLogin: true,
    });
    expect(calls[0]?.url).toBe("/api/auth/status");
  });

  test("getAuthStatus menganggap manual saat server lama tak mengirim manualLogin", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ required: true, authenticated: false }));
    const api = createApiClient({ fetch });

    expect(await api.getAuthStatus()).toEqual({
      required: true,
      authenticated: false,
      manualLogin: true,
    });
  });

  test("getAuthStatus meneruskan manualLogin false dari mode desktop", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ required: true, authenticated: true, manualLogin: false }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getAuthStatus()).toEqual({
      required: true,
      authenticated: true,
      manualLogin: false,
    });
  });

  test("login mengirim password dan mengembalikan ok", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.login("sandi-123")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/auth/login");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ password: "sandi-123" }));
  });

  test("login gagal 401 melempar ApiError tanpa memicu onUnauthorized", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "sandi salah" }, 401));
    let unauthorized = 0;
    const api = createApiClient({ fetch, onUnauthorized: () => (unauthorized += 1) });

    await expect(api.login("sandi-salah")).rejects.toThrow(ApiError);
    expect(unauthorized).toBe(0);
  });

  test("login terblokir 429 membawa retryAfterSec", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "terlalu banyak percobaan" }, 429, { "retry-after": "7" }),
    );
    const api = createApiClient({ fetch });

    try {
      await api.login("sandi-123");
      throw new Error("harus gagal");
    } catch (error) {
      expect(error instanceof ApiError).toBe(true);
      expect((error as ApiError).status).toBe(429);
      expect((error as ApiError).retryAfterSec).toBe(7);
    }
  });

  test("logout menghapus sesi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.logout()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/auth/logout");
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("respons 401 pada rute lain memanggil onUnauthorized", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "perlu login" }, 401));
    let unauthorized = 0;
    const api = createApiClient({ fetch, onUnauthorized: () => (unauthorized += 1) });

    await expect(api.listSessions()).rejects.toThrow(ApiError);
    expect(unauthorized).toBe(1);
  });

  test("getPasswordStatus membaca status sandi", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ configured: true, updatedAt: "2026-11-16T08:00:00.000Z" }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getPasswordStatus()).toEqual({
      configured: true,
      updatedAt: "2026-11-16T08:00:00.000Z",
    });
    expect(calls[0]?.url).toBe("/api/auth/password");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getPasswordStatus menandai sandi belum ada", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ configured: false }));
    const api = createApiClient({ fetch });

    expect(await api.getPasswordStatus()).toEqual({ configured: false });
  });

  test("setPassword mengirim sandi tanpa current saat belum ada", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, updatedAt: "2026-11-16" }));
    const api = createApiClient({ fetch });

    expect(await api.setPassword({ password: "sandi-12345" })).toEqual({
      ok: true,
      updatedAt: "2026-11-16",
    });
    expect(calls[0]?.url).toBe("/api/auth/password");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ password: "sandi-12345" }));
  });

  test("setPassword menyertakan current saat mengganti", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.setPassword({ password: "sandi-baru", current: "sandi-lama" });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ password: "sandi-baru", current: "sandi-lama" }),
    );
  });

  test("clearPassword mengirim sandi lama", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.clearPassword("sandi-lama")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/auth/password");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ current: "sandi-lama" }));
  });

  test("setPassword dengan sandi lama salah 401 tidak memicu onUnauthorized", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "sandi lama salah" }, 401));
    let unauthorized = 0;
    const api = createApiClient({ fetch, onUnauthorized: () => (unauthorized += 1) });

    try {
      await api.setPassword({ password: "sandi-baru", current: "sandi-lama" });
      throw new Error("harus gagal");
    } catch (error) {
      expect(error instanceof ApiError).toBe(true);
      expect((error as ApiError).status).toBe(401);
      expect((error as ApiError).message).toBe("sandi lama salah");
    }
    expect(unauthorized).toBe(0);
  });

  test("clearPassword dengan sandi lama salah 401 tidak memicu onUnauthorized", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "sandi lama salah" }, 401));
    let unauthorized = 0;
    const api = createApiClient({ fetch, onUnauthorized: () => (unauthorized += 1) });

    try {
      await api.clearPassword("sandi-lama");
      throw new Error("harus gagal");
    } catch (error) {
      expect(error instanceof ApiError).toBe(true);
      expect((error as ApiError).status).toBe(401);
      expect((error as ApiError).message).toBe("sandi lama salah");
    }
    expect(unauthorized).toBe(0);
  });
});

describe("SSE tanpa cookie sesi", () => {
  test("401 menghentikan stream tanpa sambung ulang tanpa henti", async () => {
    const calls: string[] = [];
    const impl = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return jsonResponse({ error: "perlu login" }, 401);
    };

    const items: unknown[] = [];
    let error: unknown;
    try {
      for await (const item of followSession("s1", {
        fetch: impl as typeof fetch,
        sleep: async () => undefined,
      })) {
        items.push(item);
      }
    } catch (caught) {
      error = caught;
    }

    expect(items).toHaveLength(0);
    expect(error instanceof ApiError).toBe(true);
    expect((error as ApiError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });
});
