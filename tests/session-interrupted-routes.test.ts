import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SessionManager } from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";

const KEY = "sk-rahasia-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let providersFile: string;
let store: SqliteSessionStore;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-terputus-rute-"));
  providersFile = join(dir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: KEY,
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
  store = new SqliteSessionStore(join(dir, "sessions.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function recordingRunner(): { runner: AgentRunner; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async *run(input) {
        prompts.push(input.prompt);
        yield { type: "result", ok: true };
      },
    },
  };
}

function seed(options: {
  id: string;
  status: "berjalan" | "gagal" | "selesai";
  sdkSessionId?: string;
  events: AgentEvent[];
}): void {
  const stamp = new Date().toISOString();
  store.saveSession(
    {
      id: options.id,
      title: "Sesi uji",
      prompt: "Halo dunia",
      cwd: dir,
      profileId: "lokal",
      permissionMode: "default",
      status: options.status,
      createdAt: stamp,
      updatedAt: stamp,
      eventCount: options.events.length,
      pendingPermissions: 0,
      queued: 0,
    },
    options.sdkSessionId,
  );
  options.events.forEach((event, index) => {
    store.appendEvent(options.id, { seq: index + 1, event });
  });
}

function makeApp(manager: SessionManager, password?: string): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner: recordingRunner().runner,
    sessions: manager,
    sessionStore: store,
    ...(password === undefined ? {} : { auth: { password, port: 3000 } }),
  });
}

function req(
  server: App,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...HOST, ...init.headers };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  } else if (method !== "GET" && method !== "HEAD") {
    // Penjaga lokal minta content-type JSON untuk permintaan non-GET.
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  return server.handle(new Request(`http://127.0.0.1:3000${path}`, { method, headers, body }));
}

function manager(): { mgr: SessionManager; prompts: string[] } {
  const recorded = recordingRunner();
  const mgr = new SessionManager({
    runner: recorded.runner,
    resolveProvider: async (selection) => ({
      profileId: selection.profileId ?? "lokal",
      apiKey: KEY,
      model: "model-uji",
    }),
    store,
  });
  return { mgr, prompts: recorded.prompts };
}

describe("rute sesi terputus", () => {
  test("POST /continue melanjutkan sesi dan mengembalikan 200", async () => {
    seed({
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [{ type: "permission_request", id: "p1", name: "ExitPlanMode", input: { plan: "# R" } }],
    });
    const { mgr } = manager();
    const server = makeApp(mgr);

    const res = await req(server, "POST", "/api/sessions/s1/continue");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: false });
  });

  test("POST /continue pada sesi tak ditemukan 404", async () => {
    const { mgr } = manager();
    const server = makeApp(mgr);
    const res = await req(server, "POST", "/api/sessions/s_hilang/continue");
    expect(res.status).toBe(404);
  });

  test("POST /continue pada sesi tanpa riwayat 400", async () => {
    seed({ id: "s1", status: "gagal", events: [{ type: "result", ok: false, error: "gagal" }] });
    const { mgr } = manager();
    const server = makeApp(mgr);
    const res = await req(server, "POST", "/api/sessions/s1/continue");
    expect(res.status).toBe(400);
  });

  test("POST /continue butuh autentikasi", async () => {
    seed({
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [{ type: "permission_request", id: "p1", name: "ExitPlanMode", input: { plan: "# R" } }],
    });
    const { mgr } = manager();
    const server = makeApp(mgr, "sandi-uji-123");
    const res = await req(server, "POST", "/api/sessions/s1/continue");
    expect(res.status).toBe(401);
  });

  test("izin tool yang terputus dijawab 409 lewat rute", async () => {
    seed({
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [{ type: "permission_request", id: "p1", name: "Bash", input: { command: "ls" } }],
    });
    const { mgr } = manager();
    const server = makeApp(mgr);

    const res = await req(server, "POST", "/api/sessions/s1/permissions/p1", {
      body: { decision: "allow" },
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe(
      "Sesi terputus; pilih Lanjutkan sesi agar agent mengulang pekerjaannya dan meminta izin lagi.",
    );
  });

  test("izin rencana yang terputus dijawab 200", async () => {
    seed({
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [{ type: "permission_request", id: "p1", name: "ExitPlanMode", input: { plan: "# R" } }],
    });
    const { mgr } = manager();
    const server = makeApp(mgr);

    const res = await req(server, "POST", "/api/sessions/s1/permissions/p1", {
      body: { decision: "allow" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("izin yang tak ada dijawab 404", async () => {
    seed({ id: "s1", status: "gagal", events: [{ type: "result", ok: false, error: "gagal" }] });
    const { mgr } = manager();
    const server = makeApp(mgr);
    const res = await req(server, "POST", "/api/sessions/s1/permissions/p1", {
      body: { decision: "allow" },
    });
    expect(res.status).toBe(404);
  });
});
