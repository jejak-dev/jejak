import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { MemoryService } from "../src/server/memory/memory-service";

const KEY = "sk-rahasia-123";

let dir: string;
let providersFile: string;
let memoryStore: FileMemoryStore | undefined;
let memoryService: MemoryService | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-goal-route-"));
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
  memoryStore = new FileMemoryStore({ dir: join(dir, "memory") });
  memoryService = new MemoryService({ store: memoryStore, cwd: dir });
});

afterEach(async () => {
  memoryStore?.close();
  memoryStore = undefined;
  memoryService = undefined;
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(options: { withMemory?: boolean; auth?: boolean } = {}): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner: createMockRunner(),
    ...(options.withMemory === false ? {} : { memory: memoryService }),
    ...(options.auth === true ? { auth: { password: "sandi-uji-123", port: 3000 } } : {}),
  });
}

function req(
  app: App,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000", ...init.headers };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { method, headers, body }));
}

async function createSession(
  app: App,
  overrides: Record<string, unknown> = {},
  cookie?: string,
): Promise<string> {
  const res = await req(app, "POST", "/api/sessions", {
    body: { prompt: "Halo", cwd: dir, ...overrides },
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { session: { id: string } };
  return payload.session.id;
}

/** Cookie sesi setelah login (untuk uji autentikasi). */
async function login(app: App, password = "sandi-uji-123"): Promise<string> {
  const res = await req(app, "POST", "/api/auth/login", { body: { password } });
  expect(res.status).toBe(200);
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

/** Tunggu sampai sesi selesai (tidak lagi berjalan). */
async function waitSessionIdle(app: App, id: string, cookie?: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const res = await req(app, "GET", `/api/sessions/${id}`, {
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
    const payload = (await res.json()) as { session: { status: string } };
    if (payload.session.status !== "berjalan") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tidak berhenti");
}

describe("rute Goal", () => {
  test("mulai tujuan mengembalikan goal", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    const res = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "Buat semua tes auth hijau" },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { goal: { status: string; objective: string } };
    expect(payload.goal.status).toBe("active");
    expect(payload.goal.objective).toBe("Buat semua tes auth hijau");

    const get = await req(app, "GET", `/api/sessions/${id}/goal`);
    expect(get.status).toBe(200);
    const gotten = (await get.json()) as { goal: { status: string } };
    expect(gotten.goal.status).toBe("active");
  });

  test("objective dipotong 200 karakter di respons", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    const res = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "a".repeat(300) },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { goal: { objective: string } };
    expect(payload.goal.objective).toHaveLength(200);
  });

  test("body tidak valid menjawab 400", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    for (const body of [{ objective: "" }, { objective: "x", maxTurns: 99 }, {}]) {
      const res = await req(app, "POST", `/api/sessions/${id}/goal`, { body });
      expect(res.status).toBe(400);
    }
    const rusak = await req(app, "POST", `/api/sessions/${id}/goal`, {
      headers: { "content-type": "application/json" },
    });
    expect(rusak.status).toBe(400);
  });

  test("sesi tidak dikenal menjawab 404", async () => {
    const app = makeApp();

    const mulai = await req(app, "POST", "/api/sessions/tidak-ada/goal", {
      body: { objective: "x" },
    });
    expect(mulai.status).toBe(404);

    const baca = await req(app, "GET", "/api/sessions/tidak-ada/goal");
    expect(baca.status).toBe(404);
  });

  test("sesi tanpa tujuan membaca null", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    const res = await req(app, "GET", `/api/sessions/${id}/goal`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { goal: unknown };
    expect(payload.goal).toBeNull();
  });

  test("sesi berjalan menjawab 409", async () => {
    const app = makeApp();
    const id = await createSession(app);

    const res = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "x" },
    });
    expect(res.status).toBe(409);
    await waitSessionIdle(app, id);
  });

  test("jembatan MCP internal mati menjawab 409", async () => {
    const app = makeApp({ withMemory: false });
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    const res = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "x" },
    });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("MCP internal aktif");
  });

  test("jeda, lanjut, dan henti mengembalikan goal", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "x", maxTurns: 1 },
    });

    const jeda = await req(app, "POST", `/api/sessions/${id}/goal/pause`, { body: {} });
    expect(jeda.status).toBe(200);
    const payloadJeda = (await jeda.json()) as { goal: { status: string } };
    expect(payloadJeda.goal.status).toBe("paused");

    await waitSessionIdle(app, id);
    const lanjut = await req(app, "POST", `/api/sessions/${id}/goal/resume`, { body: {} });
    expect(lanjut.status).toBe(200);

    const henti = await req(app, "POST", `/api/sessions/${id}/goal/stop`, { body: {} });
    expect(henti.status).toBe(200);
    const payloadHenti = (await henti.json()) as { goal: { status: string } };
    expect(payloadHenti.goal.status).toBe("stopped");
  });

  test("rute goal tanpa sesi menjawab 404", async () => {
    const app = makeApp();

    for (const aksi of ["pause", "resume", "stop"]) {
      const res = await req(app, "POST", `/api/sessions/tidak-ada/goal/${aksi}`, { body: {} });
      expect(res.status).toBe(404);
    }
  });

  test("tujuan dengan penanda mock berakhir sebagai achieved", async () => {
    const app = makeApp();
    const id = await createSession(app);
    await waitSessionIdle(app, id);

    const mulai = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "[goal:done] rapikan repo" },
    });
    expect(mulai.status).toBe(200);

    let status = "active";
    for (let i = 0; i < 200 && status === "active"; i += 1) {
      const res = await req(app, "GET", `/api/sessions/${id}/goal`);
      const payload = (await res.json()) as { goal: { status: string } };
      status = payload.goal.status;
      if (status === "active") {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
    expect(status).toBe("achieved");
  });

  test("autentikasi aktif tanpa cookie menjawab 401", async () => {
    const app = makeApp({ auth: true });
    const cookie = await login(app);
    const id = await createSession(app, {}, cookie);
    await waitSessionIdle(app, id, cookie);

    const res = await req(app, "POST", `/api/sessions/${id}/goal`, {
      body: { objective: "x" },
    });
    expect(res.status).toBe(401);
  });
});
