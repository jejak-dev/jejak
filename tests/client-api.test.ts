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

  test("getSession meneruskan workspaceRepos dari server", async () => {
    const workspaceRepos = [
      { name: "api", primary: true, missing: false },
      { name: "web", primary: false, missing: true },
    ];
    const { fetch } = fakeFetch(() => jsonResponse({ session: { ...SESSION, workspaceRepos } }));
    const api = createApiClient({ fetch });

    expect((await api.getSession("s1")).workspaceRepos).toEqual(workspaceRepos);
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

  test("renameSession PATCH path id ter-encode dengan body title", async () => {
    const renamed = { ...SESSION, title: "Judul baru" };
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: renamed }));
    const api = createApiClient({ fetch });

    expect(await api.renameSession("a/b c", "Judul baru")).toEqual(renamed);
    expect(calls[0]?.url).toBe("/api/sessions/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Judul baru" });
  });

  test("archiveSession PATCH body archived dan mengembalikan sesi", async () => {
    const archived = { ...SESSION, archivedAt: "2026-02-01T00:00:00.000Z" };
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: archived }));
    const api = createApiClient({ fetch });

    expect(await api.archiveSession("s 1", true)).toEqual(archived);
    expect(await api.archiveSession("s 1", false)).toEqual(archived);

    expect(calls.map((call) => call.url)).toEqual(["/api/sessions/s%201", "/api/sessions/s%201"]);
    expect(calls.map((call) => call.init.method)).toEqual(["PATCH", "PATCH"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ archived: true });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ archived: false });
  });

  test("deleteSession DELETE body JSON kosong", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.deleteSession("a/b c")).toBeUndefined();
    expect(calls[0]?.url).toBe("/api/sessions/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  test("galat 400/404/409 siklus sesi menjadi ApiError dengan status dan pesan", async () => {
    for (const [status, message] of [
      [400, "Judul harus 1..120 karakter."],
      [404, 'Sesi "x" tidak ditemukan.'],
      [409, "Hentikan sesi dulu."],
    ] as const) {
      const calls: Array<"rename" | "archive" | "delete"> = ["rename", "archive", "delete"];
      for (const method of calls) {
        const { fetch } = fakeFetch(() => jsonResponse({ error: message }, status));
        const api = createApiClient({ fetch });

        let caught: unknown;
        try {
          if (method === "rename") await api.renameSession("x", "judul");
          else if (method === "archive") await api.archiveSession("x", true);
          else await api.deleteSession("x");
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status).toBe(status);
        expect((caught as ApiError).message).toBe(message);
      }
    }
  });

  test("renameSession menolak respons tanpa session", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await expect(api.renameSession("s1", "x")).rejects.toBeInstanceOf(ApiError);
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

  test("createSession dengan workspaceId dan tanpa cwd tidak mengirim key cwd", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }, 201));
    const api = createApiClient({ fetch });

    await api.createSession({ prompt: "Halo", workspaceId: "w1", permissionMode: "default" });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ prompt: "Halo", workspaceId: "w1", permissionMode: "default" });
    expect("cwd" in body).toBe(false);
  });

  test("createSession tanpa workspace tetap mengirim body persis seperti dulu", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }, 201));
    const api = createApiClient({ fetch });

    await api.createSession({ prompt: "Halo", cwd: "/tmp", permissionMode: "plan" });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ prompt: "Halo", cwd: "/tmp", permissionMode: "plan" });
    expect("workspaceId" in body).toBe(false);
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

  test("getFiles GET dengan query path ter-encode", async () => {
    const payload = {
      path: "src/isi folder",
      entries: [{ name: "a.txt", type: "file" as const, size: 12 }],
      truncated: false,
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getFiles("s 1", "src/isi folder")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/files?path=src%2Fisi%20folder");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getFiles tanpa path tidak memakai query", async () => {
    const payload = { path: "", entries: [], truncated: false };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getFiles("s1")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s1/files");
  });

  test("getFiles dengan repo menambahkan query repo ter-encode", async () => {
    const payload = { path: "", entries: [], truncated: false };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    await api.getFiles("s1", undefined, "api utama");
    expect(calls[0]?.url).toBe("/api/sessions/s1/files?repo=api%20utama");

    await api.getFiles("s1", "src/isi folder", "api/utama");
    expect(calls[1]?.url).toBe(
      "/api/sessions/s1/files?path=src%2Fisi%20folder&repo=api%2Futama",
    );
  });

  test("getFiles 404 memakai pesan server sebagai ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Path tidak ditemukan." }, 404));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.getFiles("s1", "hilang");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("Path tidak ditemukan.");
  });

  test("getFile GET memakai query path ter-encode dan mengembalikan isi", async () => {
    const payload = { path: "a b.txt", size: 5, binary: false, truncated: false, content: "halo\n" };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getFile("s1", "a b.txt")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s1/file?path=a%20b.txt");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getFile dengan repo menambahkan query repo ter-encode", async () => {
    const payload = { path: "a b.txt", size: 5, binary: false, truncated: false, content: "halo\n" };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getFile("s1", "a b.txt", "api utama")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s1/file?path=a%20b.txt&repo=api%20utama");
  });

  test("getFile 400 memakai pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Path bukan berkas biasa." }, 400));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.getFile("s1", "dir");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("Path bukan berkas biasa.");
  });

  test("getChanges GET dan mengembalikan daftar perubahan", async () => {
    const payload = {
      isRepo: true,
      files: [
        {
          path: "src/a.ts",
          status: "M" as const,
          diffId: "0".repeat(64),
          additions: 2,
          deletions: 1,
          binary: false,
          hunks: [],
        },
      ],
      truncated: false,
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    expect(await api.getChanges("s 1")).toEqual(payload);
    expect(calls[0]?.url).toBe("http://localhost:9/api/sessions/s%201/changes");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getChanges dengan repo menambahkan query repo ter-encode", async () => {
    const payload = { isRepo: true, files: [], truncated: false };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getChanges("s 1", "api utama")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/changes?repo=api%20utama");
  });

  test("rejectChange POST body path, scope, hunkId, diffId", async () => {
    const diffId = "a".repeat(64);
    const hunkId = "b".repeat(64);
    const payload = { ok: true, undoId: "undo-1", path: "src/a.ts", scope: "hunk" };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    const result = await api.rejectChange("s 1", {
      path: "src/a.ts",
      scope: "hunk",
      hunkId,
      diffId,
    });

    expect(result).toEqual({ undoId: "undo-1", path: "src/a.ts", scope: "hunk" });
    expect(calls[0]?.url).toBe("/api/sessions/s%201/changes/reject");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      path: "src/a.ts",
      scope: "hunk",
      hunkId,
      diffId,
    });
  });

  test("rejectChange scope file tidak mengirim hunkId", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ ok: true, undoId: "undo-2", path: "a.txt", scope: "file" }),
    );
    const api = createApiClient({ fetch });

    await api.rejectChange("s1", { path: "a.txt", scope: "file", diffId: "c".repeat(64) });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      path: "a.txt",
      scope: "file",
      diffId: "c".repeat(64),
    });
  });

  test("rejectChange mengirim repo di body hanya bila diberikan", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ ok: true, undoId: "undo-3", path: "a.txt", scope: "file" }),
    );
    const api = createApiClient({ fetch });
    const input = { path: "a.txt", scope: "file" as const, diffId: "e".repeat(64) };

    await api.rejectChange("s1", { ...input, repo: "api utama" });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ...input, repo: "api utama" });
  });

  test("rejectChange 409 menjadi ApiError dengan status dan pesan server", async () => {
    const pesan = "Berkas berubah sejak diff ditampilkan. Muat ulang perubahan.";
    const { fetch } = fakeFetch(() => jsonResponse({ error: pesan }, 409));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.rejectChange("s1", { path: "a.txt", scope: "file", diffId: "d".repeat(64) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe(pesan);
  });

  test("undoChange POST body undoId dan mengembalikan path", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, path: "src/a.ts" }));
    const api = createApiClient({ fetch });

    expect(await api.undoChange("s 1", "undo-1")).toEqual({ path: "src/a.ts" });
    expect(calls[0]?.url).toBe("/api/sessions/s%201/changes/undo");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ undoId: "undo-1" });
  });

  test("undoChange mengirim repo di body hanya bila diberikan", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, path: "a.txt" }));
    const api = createApiClient({ fetch });

    expect(await api.undoChange("s1", "undo-9", "api/utama")).toEqual({ path: "a.txt" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      undoId: "undo-9",
      repo: "api/utama",
    });
  });

  test("undoChange galat memakai pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Urungkan tidak tersedia." }, 409));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.undoChange("s1", "undo-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe("Urungkan tidak tersedia.");
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

const MEMORY = {
  id: "0f0e0d0c-0b0a-4f0e-8d0c-0b0a09080706",
  layer: "project" as const,
  projectKey: "/tmp/proyek",
  title: "Perintah tes",
  body: "Jalankan bun test.",
  status: "proposed" as const,
  confidence: "inferred" as const,
  origin: { kind: "session" as const, at: "2026-11-08T10:00:00.000Z" },
  staleReason: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
  decidedAt: null,
};

describe("createApiClient: memory", () => {
  test("listMemory GET query ter-encode dan mengembalikan items, counts, problems", async () => {
    const payload = {
      items: [MEMORY],
      counts: { proposed: 1, active: 2 },
      problems: [{ file: "profile/rusak.md", reason: "frontmatter tidak valid" }],
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    const result = await api.listMemory({
      status: "proposed",
      layer: "project",
      project: "/tmp/dir a",
      q: "tes & coba",
      limit: 20,
    });

    expect(result).toEqual(payload);
    expect(calls[0]?.url).toBe(
      "http://localhost:9/api/memory?status=proposed&layer=project" +
        "&project=%2Ftmp%2Fdir%20a&q=tes%20%26%20coba&limit=20",
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("listMemory tanpa parameter tidak memakai query", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ items: [], counts: { proposed: 0, active: 0 }, problems: [] }),
    );
    const api = createApiClient({ fetch });

    const result = await api.listMemory();

    expect(result.items).toEqual([]);
    expect(result.counts).toEqual({ proposed: 0, active: 0 });
    expect(result.problems).toEqual([]);
    expect(calls[0]?.url).toBe("/api/memory");
  });

  test("counts yang tidak lengkap dianggap nol", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ items: [] }));
    const api = createApiClient({ fetch });

    expect(await api.listMemory()).toEqual({
      items: [],
      counts: { proposed: 0, active: 0 },
      problems: [],
    });
  });

  test("listMemory menolak respons tanpa array items", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ items: "bukan array" }));
    const api = createApiClient({ fetch });

    await expect(api.listMemory()).rejects.toBeInstanceOf(ApiError);
  });

  test("listMemory 400 memakai pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Nilai status tidak dikenal." }, 400));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.listMemory({ status: "entah" as never });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("Nilai status tidak dikenal.");
  });

  test("createMemory POST body layer, projectKey, title, body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: MEMORY }, 201));
    const api = createApiClient({ fetch });

    const item = await api.createMemory({
      layer: "project",
      projectKey: "/tmp/proyek",
      title: "Perintah tes",
      body: "Jalankan bun test.",
    });

    expect(item).toEqual(MEMORY);
    expect(calls[0]?.url).toBe("/api/memory");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      layer: "project",
      projectKey: "/tmp/proyek",
      title: "Perintah tes",
      body: "Jalankan bun test.",
    });
  });

  test("createMemory 400 penolakan rahasia memakai pesan server", async () => {
    const pesan = "Teks tampak memuat rahasia (api-key). Hapus dulu sebelum menyimpan.";
    const { fetch } = fakeFetch(() => jsonResponse({ error: pesan }, 400));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.createMemory({ layer: "profile", title: "x", body: "sk-abcdefghijklmnop" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe(pesan);
  });

  test("updateMemory PATCH path id ter-encode dan body judul/isi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: MEMORY }));
    const api = createApiClient({ fetch });

    expect(await api.updateMemory("a/b c", { title: "Judul baru" })).toEqual(MEMORY);
    expect(calls[0]?.url).toBe("/api/memory/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Judul baru" });
  });

  test("updateMemory 409 konflik memakai pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: 'Memory berstatus "archived" tidak bisa berpindah ke "active".' }, 409),
    );
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.updateMemory("id-1", { body: "x" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe(
      'Memory berstatus "archived" tidak bisa berpindah ke "active".',
    );
  });

  test("acceptMemory, rejectMemory, archiveMemory memakai POST sub-jalur", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: MEMORY }));
    const api = createApiClient({ fetch });

    expect(await api.acceptMemory("id 1")).toEqual(MEMORY);
    expect(await api.rejectMemory("id 1")).toEqual(MEMORY);
    expect(await api.archiveMemory("id 1")).toEqual(MEMORY);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/memory/id%201/accept",
      "/api/memory/id%201/reject",
      "/api/memory/id%201/archive",
    ]);
    expect(calls.map((call) => call.init.method)).toEqual(["POST", "POST", "POST"]);
  });

  test("acceptMemory 409 memakai pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Batas 500 memory aktif untuk lingkup ini sudah tercapai." }, 409),
    );
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.acceptMemory("id-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe(
      "Batas 500 memory aktif untuk lingkup ini sudah tercapai.",
    );
  });

  test("deleteMemory DELETE path id ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.deleteMemory("a/b c")).toBeUndefined();
    expect(calls[0]?.url).toBe("/api/memory/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("deleteMemory mengirim content-type application/json pada DELETE", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.deleteMemory("id-1");

    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  test("503 memory dimatikan menjadi ApiError dengan status dan pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Memory dimatikan." }, 503));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.listMemory();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect((caught as ApiError).message).toBe("Memory dimatikan.");
  });

  test("respons memory tanpa item menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await expect(api.acceptMemory("id-1")).rejects.toBeInstanceOf(ApiError);
  });

  test("importMemory POST /api/memory/import body projectKey", async () => {
    const payload = {
      created: [MEMORY],
      skipped: [
        { file: "AGENTS.md", title: "Perintah", reason: "sudah-ada" as const },
      ],
      files: [
        { file: "AGENTS.md", found: true },
        { file: "CLAUDE.md", found: false },
      ],
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    const result = await api.importMemory("/tmp/proyek");

    expect(result).toEqual(payload);
    expect(calls[0]?.url).toBe("http://localhost:9/api/memory/import");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ projectKey: "/tmp/proyek" });
  });

  test("importMemory menolak bentuk respons yang salah", async () => {
    const invalidPayloads: unknown[] = [
      {},
      { created: [], skipped: [] },
      { created: "x", skipped: [], files: [] },
      { created: [], skipped: [{}], files: [] },
      { created: [], skipped: [], files: [{ file: "AGENTS.md" }] },
      null,
    ];

    for (const payload of invalidPayloads) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.importMemory("/tmp/x")).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("importMemory 400 dan 503 memakai pesan server", async () => {
    for (const [status, message] of [
      [400, "Folder proyek tidak ditemukan."],
      [503, "Memory dimatikan."],
    ] as const) {
      const { fetch } = fakeFetch(() => jsonResponse({ error: message }, status));
      const api = createApiClient({ fetch });

      let caught: unknown;
      try {
        await api.importMemory("/tmp/x");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(status);
      expect((caught as ApiError).message).toBe(message);
    }
  });
});

const CHECKPOINT = {
  id: "a".repeat(40),
  kind: "turn" as const,
  turn: 3,
  label: "Giliran 3",
  createdAt: "2026-11-08T10:00:00.000Z",
  files: 4,
};

describe("createApiClient: checkpoint", () => {
  test("getCheckpoints GET path ter-encode dan mengembalikan daftar", async () => {
    const payload = { enabled: true, items: [CHECKPOINT] };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    expect(await api.getCheckpoints("s 1")).toEqual(payload);
    expect(calls[0]?.url).toBe("http://localhost:9/api/sessions/s%201/checkpoints");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("getCheckpoints membawa alasan saat dimatikan", async () => {
    const payload = { enabled: false, reason: "Folder terlalu besar", items: [] };
    const { fetch } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getCheckpoints("s1")).toEqual(payload);
  });

  test("getCheckpoints menolak bentuk respons yang salah", async () => {
    const invalidPayloads: unknown[] = [
      {},
      { enabled: "ya", items: [] },
      { enabled: true },
      { enabled: true, items: [{ ...CHECKPOINT, kind: "entah" }] },
      { enabled: true, items: [{ ...CHECKPOINT, files: "4" }] },
      { enabled: true, items: [null] },
    ];

    for (const payload of invalidPayloads) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.getCheckpoints("s1")).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("createCheckpoint POST body label ter-encode dan mengembalikan item", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, item: CHECKPOINT }, 201));
    const api = createApiClient({ fetch });

    expect(await api.createCheckpoint("a b", "sebelum refactor")).toEqual(CHECKPOINT);
    expect(calls[0]?.url).toBe("/api/sessions/a%20b/checkpoints");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ label: "sebelum refactor" });
  });

  test("createCheckpoint tanpa label mengirim body kosong JSON", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, item: CHECKPOINT }, 201));
    const api = createApiClient({ fetch });

    await api.createCheckpoint("s1");

    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  test("createCheckpoint menolak respons tanpa item yang sah", async () => {
    for (const payload of [{}, { item: null }, { item: { ...CHECKPOINT, createdAt: 1 } }]) {
      const { fetch } = fakeFetch(() => jsonResponse(payload, 201));
      const api = createApiClient({ fetch });
      await expect(api.createCheckpoint("s1")).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("previewCheckpoint GET path cid ter-encode", async () => {
    const payload = {
      changes: [
        { path: "src/a.ts", action: "restore" as const },
        { path: "baru.txt", action: "remove" as const },
      ],
      truncated: false,
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.previewCheckpoint("s 1", "ab/cd")).toEqual(payload);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/checkpoints/ab%2Fcd/preview");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("previewCheckpoint menolak bentuk respons yang salah", async () => {
    const invalidPayloads: unknown[] = [
      {},
      { changes: [] },
      { changes: "x", truncated: false },
      { changes: [{ path: "a", action: "entah" }], truncated: false },
      { changes: [], truncated: "tidak" },
    ];

    for (const payload of invalidPayloads) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.previewCheckpoint("s1", "a".repeat(40))).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("rewindCheckpoint POST body confirm dan mengembalikan ringkasan", async () => {
    const payload = { ok: true, safetyId: "b".repeat(40), restored: 1, recreated: 2, removed: 3 };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.rewindCheckpoint("s 1", "c".repeat(40))).toEqual({
      safetyId: "b".repeat(40),
      restored: 1,
      recreated: 2,
      removed: 3,
    });
    expect(calls[0]?.url).toBe(`/api/sessions/s%201/checkpoints/${"c".repeat(40)}/rewind`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ confirm: true });
  });

  test("rewindCheckpoint menolak bentuk respons yang salah", async () => {
    const invalidPayloads: unknown[] = [
      {},
      { safetyId: "x", restored: 1, recreated: 0 },
      { safetyId: 1, restored: 1, recreated: 0, removed: 0 },
      { safetyId: "x", restored: "1", recreated: 0, removed: 0 },
    ];

    for (const payload of invalidPayloads) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.rewindCheckpoint("s1", "a".repeat(40))).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("checkpoint 409 dan 503 menjadi ApiError dengan status", async () => {
    for (const [status, message] of [
      [409, "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu."],
      [503, "Checkpoint dimatikan."],
    ] as const) {
      const { fetch } = fakeFetch(() => jsonResponse({ error: message }, status));
      const api = createApiClient({ fetch });

      let caught: unknown;
      try {
        await api.rewindCheckpoint("s1", "a".repeat(40));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(status);
      expect((caught as ApiError).message).toBe(message);
    }
  });

  test("getCheckpoints 503 menjadi ApiError dengan status", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Checkpoint dimatikan." }, 503));
    const api = createApiClient({ fetch });

    let caught: unknown;
    try {
      await api.getCheckpoints("s1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
  });
});

const WORKSPACE = {
  id: "0f0e0d0c-0b0a-4f0e-8d0c-0b0a09080706",
  name: "Kantor",
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
  repos: [
    {
      name: "api",
      path: "/tmp/api",
      missing: false,
      card: {
        description: "",
        kind: "lainnya" as const,
        tables: [],
        queues: [],
        calls: [],
        updatedAt: null,
      },
    },
  ],
};

describe("createApiClient: workspace", () => {
  test("listWorkspaces GET /api/workspaces dengan items dan problems", async () => {
    const payload = { items: [WORKSPACE], problems: [{ file: "x.json", reason: "rusak" }] };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch, baseUrl: "http://localhost:9" });

    expect(await api.listWorkspaces()).toEqual(payload);
    expect(calls[0]?.url).toBe("http://localhost:9/api/workspaces");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("listWorkspaces menolak respons tanpa array items", async () => {
    for (const payload of [{}, { items: "x" }, null]) {
      const { fetch } = fakeFetch(() => jsonResponse(payload));
      const api = createApiClient({ fetch });
      await expect(api.listWorkspaces()).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("createWorkspace POST body nama dan repos", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: WORKSPACE }, 201));
    const api = createApiClient({ fetch });
    const input = { name: "Kantor", repos: [{ name: "api", path: "/tmp/api" }] };

    expect(await api.createWorkspace(input)).toEqual(WORKSPACE);
    expect(calls[0]?.url).toBe("/api/workspaces");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
  });

  test("updateWorkspace PATCH path id ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: WORKSPACE }));
    const api = createApiClient({ fetch });

    expect(await api.updateWorkspace("a/b c", { name: "Baru" })).toEqual(WORKSPACE);
    expect(calls[0]?.url).toBe("/api/workspaces/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "Baru" });
  });

  test("setWorkspaceCard PUT path id dan nama repo ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ item: WORKSPACE }));
    const api = createApiClient({ fetch });
    const card = {
      description: "Layanan",
      kind: "backend" as const,
      tables: ["pesanan"],
      queues: [],
      calls: ["web"],
    };

    expect(await api.setWorkspaceCard("id 1", "api/v1", card)).toEqual(WORKSPACE);
    expect(calls[0]?.url).toBe("/api/workspaces/id%201/repos/api%2Fv1/card");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(card);
  });

  test("deleteWorkspace DELETE path ter-encode body JSON kosong", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.deleteWorkspace("a/b c")).toBeUndefined();
    expect(calls[0]?.url).toBe("/api/workspaces/a%2Fb%20c");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  test("galat 400/404/409/503 menjadi ApiError dengan status dan pesan", async () => {
    for (const [status, message] of [
      [400, "Field name harus berupa teks."],
      [404, "Workspace tidak ditemukan."],
      [409, "Batas 20 repo per workspace terlampaui."],
      [503, "Workspace dimatikan."],
    ] as const) {
      const { fetch } = fakeFetch(() => jsonResponse({ error: message }, status));
      const api = createApiClient({ fetch });

      let caught: unknown;
      try {
        await api.createWorkspace({ name: "x" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(status);
      expect((caught as ApiError).message).toBe(message);
    }
  });
});

describe("createApiClient mode bypass", () => {
  test("createSession mengirim confirmBypass hanya bila true", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }, 201));
    const api = createApiClient({ fetch });

    await api.createSession({
      prompt: "Halo",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      confirmBypass: true,
    });
    const withTrue = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(withTrue).toEqual({
      prompt: "Halo",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      confirmBypass: true,
    });

    await api.createSession({ prompt: "Halo", cwd: "/tmp", permissionMode: "plan", confirmBypass: false });
    const withFalse = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect("confirmBypass" in withFalse).toBe(false);
  });

  test("createSession tanpa confirmBypass tidak menambah key", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: SESSION }, 201));
    const api = createApiClient({ fetch });

    await api.createSession({ prompt: "Halo", cwd: "/tmp", permissionMode: "default" });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ prompt: "Halo", cwd: "/tmp", permissionMode: "default" });
  });
});
