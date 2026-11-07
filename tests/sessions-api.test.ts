import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner, type AgentRunner } from "../src/server/agent";
import { SessionManager } from "../src/server/sessions/session-manager";

const ENV = { MOCK: "true" };
const KEY = "sk-rahasia-123";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sessions-api-"));
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

function makeApp(options: { runner?: AgentRunner; sessions?: SessionManager } = {}): App {
  return createApp({
    providersPath: providersFile,
    env: ENV,
    runner: options.runner ?? createMockRunner(),
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

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

function parseFrames(raw: string): Frame[] {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "" && !chunk.startsWith(":"))
    .map((chunk) => {
      const frame: Frame = {};
      for (const line of chunk.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      return frame;
    });
}

async function readStream(response: Response): Promise<{ frames: Frame[]; raw: string }> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("stream kosong");
  const decoder = new TextDecoder();
  let raw = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value !== undefined) raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();
  return { frames: parseFrames(raw), raw };
}

async function createSession(
  server: App,
  body: Record<string, unknown> = {},
): Promise<{ id: string; status: string; title: string; profileId: string }> {
  const res = await req(server, "POST", "/api/sessions", {
    body: { prompt: "Halo dunia", cwd: dir, ...body },
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as {
    session: { id: string; status: string; title: string; profileId: string };
  };
  return data.session;
}

function waitingRunner(): AgentRunner {
  return {
    async *run(input) {
      yield { type: "text", text: "menunggu" };
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted === true) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", message: "dibatalkan" };
      yield { type: "result", ok: false, error: "dibatalkan" };
    },
  };
}

describe("POST /api/sessions", () => {
  test("membuat sesi 201, GET list dan detail, selesai setelah run mock", async () => {
    const server = makeApp();
    const session = await createSession(server);

    expect(session.id.startsWith("s_")).toBe(true);
    expect(session.profileId).toBe("lokal");
    expect(session.title).toBe("Halo dunia");
    expect(session.status).toBe("berjalan");

    const list = await req(server, "GET", "/api/sessions");
    expect(list.status).toBe(200);
    const listData = (await list.json()) as { sessions: Array<{ id: string }> };
    expect(listData.sessions.map((item) => item.id)).toEqual([session.id]);

    const detail = await req(server, "GET", `/api/sessions/${session.id}`);
    expect(detail.status).toBe(200);
    const detailData = (await detail.json()) as { session: { permissionMode: string } };
    expect(detailData.session.permissionMode).toBe("default");

    const { frames } = await readStream(await req(server, "GET", `/api/sessions/${session.id}/events`));
    expect(frames[frames.length - 1]?.event).toBe("end");
    expect(JSON.parse(frames[frames.length - 1]?.data ?? "{}")).toEqual({ status: "selesai" });

    const after = await req(server, "GET", "/api/sessions");
    const afterData = (await after.json()) as { sessions: Array<{ status: string }> };
    expect(afterData.sessions[0]?.status).toBe("selesai");
  });

  test("validasi ditolak 400", async () => {
    const server = makeApp();
    const cases: Array<Record<string, unknown>> = [
      { cwd: join(dir, "tidak-ada") },
      { permissionMode: "bypassPermissions" },
      { prompt: "" },
    ];
    for (const body of cases) {
      const res = await req(server, "POST", "/api/sessions", {
        body: { prompt: "Halo", cwd: dir, ...body },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(typeof data.error).toBe("string");
    }

    const broken = await server.handle(
      new Request("http://127.0.0.1:3000/api/sessions", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: "{bukan json",
      }),
    );
    expect(broken.status).toBe(400);

    const arrayBody = await req(server, "POST", "/api/sessions", { body: ["prompt"] });
    expect(arrayBody.status).toBe(400);
  });

  test("batas konkurensi ditolak 429", async () => {
    const runner = waitingRunner();
    const manager = new SessionManager({
      runner,
      resolveProvider: async () => ({ profileId: "lokal", apiKey: KEY }),
      maxConcurrent: 1,
    });
    const server = makeApp({ runner, sessions: manager });

    const first = await createSession(server);
    const second = await req(server, "POST", "/api/sessions", {
      body: { prompt: "Halo lagi", cwd: dir },
    });
    expect(second.status).toBe(429);
    const data = (await second.json()) as { error: string };
    expect(typeof data.error).toBe("string");

    manager.interrupt(first.id);
    await manager.done(first.id);
  });
});

describe("GET /api/sessions/:id/events (SSE)", () => {
  test("mengirim bingkai agent berurutan lalu end selesai", async () => {
    const server = makeApp();
    const { id } = await createSession(server);
    const res = await req(server, "GET", `/api/sessions/${id}/events`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");

    const { frames, raw } = await readStream(res);
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("event: end");

    const agentFrames = frames.filter((frame) => frame.event === "agent");
    expect(agentFrames.map((frame) => Number(frame.id))).toEqual(
      agentFrames.map((_, index) => index + 1),
    );
    const events = agentFrames.map((frame) => JSON.parse(frame.data ?? "{}") as { type: string });
    expect(events.some((event) => event.type === "result")).toBe(true);
    expect(frames[frames.length - 1]?.event).toBe("end");
    expect(JSON.parse(frames[frames.length - 1]?.data ?? "{}")).toEqual({ status: "selesai" });
  });

  test("Last-Event-ID hanya mengirim seq lebih besar", async () => {
    const server = makeApp();
    const { id } = await createSession(server);
    const res = await req(server, "GET", `/api/sessions/${id}/events`, {
      headers: { "last-event-id": "3" },
    });
    const { frames } = await readStream(res);
    const ids = frames.filter((frame) => frame.event === "agent").map((frame) => Number(frame.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((value) => value > 3)).toBe(true);
    expect(ids[0]).toBe(4);
  });

  test("query after dipakai, header menang, angka tidak valid jadi 0", async () => {
    const server = makeApp();
    const { id } = await createSession(server);

    const queryFrames = await readStream(
      await req(server, "GET", `/api/sessions/${id}/events?after=2`),
    );
    const queryIds = queryFrames.frames
      .filter((frame) => frame.event === "agent")
      .map((frame) => Number(frame.id));
    expect(queryIds[0]).toBe(3);

    const headerFrames = await readStream(
      await req(server, "GET", `/api/sessions/${id}/events?after=5`, {
        headers: { "last-event-id": "1" },
      }),
    );
    const headerIds = headerFrames.frames
      .filter((frame) => frame.event === "agent")
      .map((frame) => Number(frame.id));
    expect(headerIds[0]).toBe(2);

    const invalidFrames = await readStream(
      await req(server, "GET", `/api/sessions/${id}/events?after=abc`),
    );
    const invalidIds = invalidFrames.frames
      .filter((frame) => frame.event === "agent")
      .map((frame) => Number(frame.id));
    expect(invalidIds[0]).toBe(1);
  });

  test("id tak ada 404 untuk detail, events, dan interrupt", async () => {
    const server = makeApp();
    for (const [method, path] of [
      ["GET", "/api/sessions/s_tidakada"],
      ["GET", "/api/sessions/s_tidakada/events"],
      ["POST", "/api/sessions/s_tidakada/interrupt"],
    ] as const) {
      const res = await req(server, method, path, method === "POST" ? { body: {} } : {});
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toHaveProperty("error");
    }
  });

  test("aliran SSE tidak memuat key profil", async () => {
    const leaking: AgentRunner = {
      async *run() {
        yield { type: "text", text: `kunci ${KEY} bocor` };
        yield { type: "tool_call", id: "t1", name: "Bash", input: { command: `echo ${KEY}` } };
        yield { type: "result", ok: true, summary: `ringkas ${KEY}` };
      },
    };
    const server = makeApp({ runner: leaking });
    const { id } = await createSession(server);
    const { raw } = await readStream(await req(server, "GET", `/api/sessions/${id}/events`));
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("***");
  });
});

describe("POST /api/sessions/:id/interrupt", () => {
  test("menghentikan sesi dan SSE berakhir dibatalkan", async () => {
    const runner = waitingRunner();
    const manager = new SessionManager({
      runner,
      resolveProvider: async () => ({ profileId: "lokal", apiKey: KEY }),
    });
    const server = makeApp({ runner, sessions: manager });
    const { id } = await createSession(server);

    const eventsRes = await req(server, "GET", `/api/sessions/${id}/events`);
    const reader = eventsRes.body?.getReader();
    if (reader === undefined) throw new Error("stream kosong");
    const decoder = new TextDecoder();
    let raw = "";
    while (!raw.includes("event: agent")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }

    const interrupt = await req(server, "POST", `/api/sessions/${id}/interrupt`, { body: {} });
    expect(interrupt.status).toBe(200);
    expect(await interrupt.json()).toEqual({ ok: true, interrupted: true });

    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value !== undefined) raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();

    await manager.done(id);
    expect(manager.get(id)?.status).toBe("dibatalkan");

    const frames = parseFrames(raw);
    expect(frames[frames.length - 1]?.event).toBe("end");
    expect(JSON.parse(frames[frames.length - 1]?.data ?? "{}")).toEqual({ status: "dibatalkan" });

    const again = await req(server, "POST", `/api/sessions/${id}/interrupt`, { body: {} });
    expect(await again.json()).toEqual({ ok: true, interrupted: false });
  });
});

describe("guard pada API sesi", () => {
  test("Host evil.test ditolak 403", async () => {
    const res = await req(makeApp(), "GET", "/api/sessions", { headers: { host: "evil.test" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("POST tanpa content-type json ditolak 415", async () => {
    const res = await makeApp().handle(
      new Request("http://127.0.0.1:3000/api/sessions", {
        method: "POST",
        headers: { host: "127.0.0.1:3000" },
        body: JSON.stringify({ prompt: "Halo", cwd: dir }),
      }),
    );
    expect(res.status).toBe(415);
  });
});
