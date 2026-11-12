import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient } from "../src/client/lib/api";
import { followSession } from "../src/client/lib/sse";
import {
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
});

describe("api klien untuk autentikasi", () => {
  test("getAuthStatus membaca status server", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ required: true, authenticated: false }));
    const api = createApiClient({ fetch });

    expect(await api.getAuthStatus()).toEqual({ required: true, authenticated: false });
    expect(calls[0]?.url).toBe("/api/auth/status");
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
