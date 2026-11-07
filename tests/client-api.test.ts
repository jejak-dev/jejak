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
  prompt: "Halo",
  cwd: "/tmp",
  profileId: "lokal",
  permissionMode: "default",
  status: "berjalan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
  pendingPermissions: 0,
  queued: 0,
};

describe("createApiClient", () => {
  test("getInfo GET /api/info dan mengembalikan payload", async () => {
    const payload = { name: "jejak", version: "0.0.1", cwd: "/tmp", mock: true };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getInfo()).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/info");
    expect(calls[0]?.init.method).toBe("GET");
  });

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

  test("sendMessage POST JSON ke /messages dan mengembalikan queued", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, queued: true }));
    const api = createApiClient({ fetch });

    const result = await api.sendMessage("a b", "halo lagi");

    expect(result).toEqual({ queued: true });
    expect(calls[0]?.url).toBe("/api/sessions/a%20b/messages");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "halo lagi" });
  });

  test("sendMessage tanpa queued dianggap false", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.sendMessage("s1", "x")).toEqual({ queued: false });
  });

  test("sendMessage 429 memakai pesan server sebagai ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "antrean penuh" }, 429));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.sendMessage("s1", "x");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(429);
    expect((caught as ApiError).message).toBe("antrean penuh");
  });

  test("getProviders GET dan mengembalikan payload apa adanya", async () => {
    const payload = { registry: { profiles: [] } };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getProviders()).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/providers");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("saveProviders PUT JSON dan mengembalikan payload", async () => {
    const payload = { registry: { profiles: [] } };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });
    const registry = { activeProfileId: "a", profiles: [{ id: "a", name: "A" }] };

    expect(await api.saveProviders(registry)).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/providers");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(registry);
  });

  test("saveProviders 400 memakai pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "tidak valid" }, 400));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.saveProviders({ profiles: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("tidak valid");
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

  test("testProvider POST selection dan mengembalikan result", async () => {
    const result = {
      ok: true,
      status: 200,
      latencyMs: 123,
      model: "m",
      toolCalling: "ok" as const,
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse({ result }));
    const api = createApiClient({ fetch });

    expect(await api.testProvider({ profileId: "p", model: "m" })).toEqual(result);
    expect(await api.testProvider()).toEqual(result);

    expect(calls[0]?.url).toBe("/api/providers/test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ profileId: "p", model: "m" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({});
  });

  test("testProvider menerima error dari result dan membuang field asing", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        result: {
          ok: false,
          latencyMs: 5,
          toolCalling: "tidak-diuji",
          error: "autentikasi ditolak",
          rahasia: "x",
        },
      }),
    );
    const api = createApiClient({ fetch });

    expect(await api.testProvider()).toEqual({
      ok: false,
      latencyMs: 5,
      toolCalling: "tidak-diuji",
      error: "autentikasi ditolak",
    });
  });

  test("testProvider menolak bentuk hasil yang tidak valid", async () => {
    const invalidPayloads: unknown[] = [
      {},
      { result: null },
      { result: { ok: true } },
      { result: { ok: true, latencyMs: 1, toolCalling: "entah" } },
      { result: { ok: "ya", latencyMs: 1, toolCalling: "ok" } },
      { result: { ok: true, latencyMs: Number.NaN, toolCalling: "ok" } },
    ];

    for (const payload of invalidPayloads) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.testProvider()).rejects.toBeInstanceOf(ApiError);
    }
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
