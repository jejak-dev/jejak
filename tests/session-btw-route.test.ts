import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { SessionManager } from "../src/server/sessions/session-manager";

const KEY = "sk-rahasia-123";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-btw-route-"));
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
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

/** Runner yang menjawab berbeda untuk giliran biasa dan pertanyaan sampingan. */
function btwRunner(): AgentRunner {
  return {
    async *run(input) {
      if (input.fork === true) {
        yield { type: "text", text: "Jawaban sampingan." };
        yield { type: "result", ok: true };
        return;
      }
      yield { type: "session", sessionId: "mock-session" };
      yield { type: "text", text: "Balasan utama." };
      yield { type: "result", ok: true };
    },
  };
}

function makeApp(options: { runner?: AgentRunner; sessions?: SessionManager } = {}): App {
  const runner = options.runner ?? btwRunner();
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  });
}

function req(
  server: App,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000", ...init.headers };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  return server.handle(new Request(`http://127.0.0.1:3000${path}`, { method, headers, body }));
}

async function createSession(server: App): Promise<string> {
  const res = await req(server, "POST", "/api/sessions", {
    body: { prompt: "Halo dunia", cwd: dir },
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { session: { id: string } };
  return data.session.id;
}

describe("POST /api/sessions/:id/btw", () => {
  test("pertanyaan menghasilkan 200 dengan jawaban", async () => {
    const manager = new SessionManager({
      runner: btwRunner(),
      resolveProvider: async () => ({ profileId: "lokal", apiKey: KEY }),
    });
    const server = makeApp({ sessions: manager });
    const id = await createSession(server);
    await manager.done(id);

    const res = await req(server, "POST", `/api/sessions/${id}/btw`, {
      body: { question: "apa agenda sesi ini?" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: "Jawaban sampingan." });
  });

  test("tanpa question atau question kosong ditolak 400", async () => {
    const manager = new SessionManager({
      runner: btwRunner(),
      resolveProvider: async () => ({ profileId: "lokal", apiKey: KEY }),
    });
    const server = makeApp({ sessions: manager });
    const id = await createSession(server);
    await manager.done(id);

    for (const body of [{}, { question: "" }, { question: 42 }]) {
      const res = await req(server, "POST", `/api/sessions/${id}/btw`, { body });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(typeof data.error).toBe("string");
    }
  });

  test("sesi tak ada menghasilkan 404", async () => {
    const server = makeApp();

    const res = await req(server, "POST", "/api/sessions/s_tidakada/btw", {
      body: { question: "halo" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  test("body non-JSON ditolak guard dan body JSON rusak ditolak 400", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const noContentType = await server.handle(
      new Request(`http://127.0.0.1:3000/api/sessions/${id}/btw`, {
        method: "POST",
        headers: { host: "127.0.0.1:3000" },
        body: JSON.stringify({ question: "halo" }),
      }),
    );
    expect(noContentType.status).toBe(415);

    const broken = await server.handle(
      new Request(`http://127.0.0.1:3000/api/sessions/${id}/btw`, {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: "{bukan json",
      }),
    );
    expect(broken.status).toBe(400);
  });

  test("pertanyaan tidak menambah event ke timeline sesi", async () => {
    const manager = new SessionManager({
      runner: btwRunner(),
      resolveProvider: async () => ({ profileId: "lokal", apiKey: KEY }),
    });
    const server = makeApp({ sessions: manager });
    const id = await createSession(server);
    await manager.done(id);

    const sebelum = manager.get(id)?.eventCount ?? 0;
    await req(server, "POST", `/api/sessions/${id}/btw`, { body: { question: "halo" } });

    expect(manager.get(id)?.eventCount).toBe(sebelum);
    expect(manager.get(id)?.status).toBe("selesai");
  });
});
