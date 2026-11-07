import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient } from "../src/client/lib/api";
import type { SessionInfo } from "../src/server/sessions/session-manager";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION: SessionInfo = {
  id: "s1",
  title: "Judul",
  cwd: "/tmp",
  profileId: "lokal",
  permissionMode: "default",
  status: "berjalan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
};

describe("createApiClient", () => {
  test("listSessions GET /api/sessions", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ sessions: [SESSION] }));
    const api = createApiClient({ fetch });

    const sessions = await api.listSessions();

    expect(sessions).toEqual([SESSION]);
    expect(calls[0]?.url).toBe("/api/sessions");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("listSessions menolak respons tanpa array sessions", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ sessions: "bukan array" }));
    const api = createApiClient({ fetch });

    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  test("getSession memakai baseUrl dan encodeURIComponent", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    const session = await api.getSession("a/b c");

    expect(session).toEqual(SESSION);
    expect(calls[0]?.url).toBe("http://localhost:9/api/sessions/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getSession 404 memakai pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "tidak ada" }, 404));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.getSession("x");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("tidak ada");
  });

  test("createSession POST JSON dengan seluruh field", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }, 201));
    const api = createApiClient({ fetch });
    const input = {
      prompt: "Halo",
      cwd: "/tmp",
      title: "T",
      profileId: "lokal",
      model: "m",
      lightModel: "lm",
      permissionMode: "plan" as const,
    };

    const session = await api.createSession(input);

    expect(session).toEqual(SESSION);
    expect(calls[0]?.url).toBe("/api/sessions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
  });

  test("interruptSession POST dan mengembalikan interrupted", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, interrupted: true }));
    const api = createApiClient({ fetch });

    const result = await api.interruptSession("a b");

    expect(result).toEqual({ interrupted: true });
    expect(calls[0]?.url).toBe("/api/sessions/a%20b/interrupt");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });

  test("getProviders GET dan mengembalikan payload apa adanya", async () => {
    const payload = { registry: { profiles: [] } };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getProviders()).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/providers");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("setActiveProvider POST body profileId", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ registry: {} }));
    const api = createApiClient({ fetch });

    await api.setActiveProvider("lokal");

    expect(calls[0]?.url).toBe("/api/providers/active");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ profileId: "lokal" });
  });

  test("testProvider POST selection dan mendukung tanpa argumen", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ result: { ok: true } }));
    const api = createApiClient({ fetch });

    await api.testProvider({ profileId: "p", model: "m" });
    await api.testProvider();

    expect(calls[0]?.url).toBe("/api/providers/test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ profileId: "p", model: "m" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({});
  });

  test("error non-JSON memakai pesan status", async () => {
    const { fetch } = fakeFetch(() => new Response("boom", { status: 500 }));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.listSessions();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as ApiError).message).toBe("permintaan gagal (status 500)");
  });

  test("respons 2xx non-JSON menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => new Response("bukan json", { status: 200 }));
    const api = createApiClient({ fetch });

    await expect(api.getProviders()).rejects.toBeInstanceOf(ApiError);
  });

  test("jaringan putus menjadi ApiError status 0", async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new Error("putus")));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.getProviders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(0);
    expect((caught as ApiError).message).toBe("tidak dapat terhubung ke server");
  });
});
