import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner, RunInput } from "../src/server/agent";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";

const API_KEY = "sk-rahasia-123";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-rewind-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function provider(selection: ProviderSelection): ResolvedProvider {
  return { profileId: selection.profileId ?? "lokal", apiKey: API_KEY, model: "model-uji" };
}

function manager(options: Partial<SessionManagerOptions> & { runner: AgentRunner }) {
  return new SessionManager({
    resolveProvider: async (selection) => provider(selection),
    ...options,
  });
}

async function collect(iterable: AsyncIterable<SequencedEvent>): Promise<SequencedEvent[]> {
  const result: SequencedEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

/** Runner yang memberi jangkar (uuid) per giliran dan mencatat input run. */
function anchorRunner(seen: RunInput[]): AgentRunner {
  let giliran = 0;
  return {
    async *run(input) {
      seen.push(input);
      giliran += 1;
      yield { type: "session", sessionId: `sdk-${giliran}` };
      yield { type: "text", text: `balasan ${giliran}` };
      yield { type: "result", ok: true, anchorUuid: `anchor-${giliran}` };
    },
  };
}

/** Runner yang tanpa jangkar (result tidak punya anchorUuid). */
function runnerTanpaJangkar(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1" };
      yield { type: "text", text: "balasan" };
      yield { type: "result", ok: true };
    },
  };
}

/** Runner yang menggantung sampai dibatalkan; sesi tetap "berjalan". */
function runnerMenunggu(): AgentRunner {
  return {
    async *run(input) {
      yield { type: "text", text: "menunggu" };
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted === true) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "result", ok: false, error: "dibatalkan" };
    },
  };
}

/** Sesi dengan satu giliran lanjutan; mengembalikan seq pesan pengguna. */
async function sesiDenganPesan(
  mgr: SessionManager,
): Promise<{ id: string; userSeq: number }> {
  const info = await mgr.create({ prompt: "Halo dunia", cwd: dir });
  await mgr.done(info.id);
  await mgr.send(info.id, "pesan kedua");
  await mgr.done(info.id);

  const events = await collect(mgr.events(info.id));
  const user = events.find((item) => item.event.type === "user_message");
  if (user === undefined) throw new Error("pesan pengguna tidak ditemukan");
  return { id: info.id, userSeq: user.seq };
}

describe("SessionManager.rewindConversation", () => {
  test("memotong buffer dan penyimpanan serta mengembalikan teks pesan", async () => {
    const store = new SqliteSessionStore(":memory:");
    const mgr = manager({ runner: anchorRunner([]), store });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    const result = await mgr.rewindConversation(id, userSeq);

    expect(result.text).toBe("pesan kedua");

    const events = await collect(mgr.events(id));
    expect(events.map((item) => item.event.type)).toEqual(["session", "text", "result"]);
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3]);

    const stored = store.loadEvents(id);
    expect(stored.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(stored.some((item) => item.event.type === "user_message")).toBe(false);

    expect(mgr.get(id)?.eventCount).toBe(3);
    expect(mgr.get(id)?.queued).toBe(0);
    store.close();
  });

  test("menyimpan target mundur di baris sesi", async () => {
    const store = new SqliteSessionStore(":memory:");
    const mgr = manager({ runner: anchorRunner([]), store });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    await mgr.rewindConversation(id, userSeq);

    const stored = store.loadSessions()[0];
    expect(stored?.info.rewindTo).toEqual({ uuid: "anchor-1", sdkSessionId: "sdk-1" });
    store.close();
  });

  test("giliran berikutnya memakai sesi lama, jangkar, dan fork", async () => {
    const seen: RunInput[] = [];
    const store = new SqliteSessionStore(":memory:");
    const mgr = manager({ runner: anchorRunner(seen), store });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    await mgr.rewindConversation(id, userSeq);
    seen.length = 0;
    await mgr.send(id, "pesan kedua");
    await mgr.done(id);

    const input = seen[0];
    expect(input?.resumeSessionId).toBe("sdk-1");
    expect(input?.resumeAt).toBe("anchor-1");
    expect(input?.fork).toBe(true);
    store.close();
  });

  test("event session menimpa sdkSessionId dan membersihkan target mundur", async () => {
    const seen: RunInput[] = [];
    const store = new SqliteSessionStore(":memory:");
    const mgr = manager({ runner: anchorRunner(seen), store });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    await mgr.rewindConversation(id, userSeq);
    await mgr.send(id, "pesan kedua");
    await mgr.done(id);

    const stored = store.loadSessions()[0];
    expect(stored?.sdkSessionId).toBe("sdk-3");
    expect(stored?.info.rewindTo).toBeUndefined();

    // Giliran berikutnya memakai sesi hasil fork.
    seen.length = 0;
    await mgr.send(id, "pesan ketiga");
    await mgr.done(id);
    expect(seen[0]?.resumeSessionId).toBe("sdk-3");
    store.close();
  });

  test("target mundur bertahan setelah manager dibuat ulang dari store yang sama", async () => {
    const path = join(dir, "sessions.db");
    const store = new SqliteSessionStore(path);
    const mgr = manager({ runner: anchorRunner([]), store });
    const { id, userSeq } = await sesiDenganPesan(mgr);
    await mgr.rewindConversation(id, userSeq);
    store.close();

    // Restart server: manager baru dari store yang sama.
    const storeLagi = new SqliteSessionStore(path);
    const seen: RunInput[] = [];
    const mgrLagi = manager({ runner: anchorRunner(seen), store: storeLagi });

    await mgrLagi.send(id, "pesan kedua");
    await mgrLagi.done(id);

    const input = seen[0];
    expect(input?.resumeSessionId).toBe("sdk-1");
    expect(input?.resumeAt).toBe("anchor-1");
    expect(input?.fork).toBe(true);
    storeLagi.close();
  });

  test("run yang gagal sebelum event session mempertahankan target mundur", async () => {
    const store = new SqliteSessionStore(":memory:");
    const runner: AgentRunner = {
      async *run(input) {
        if (input.resumeAt !== undefined) {
          yield { type: "error", message: "SDK tumbang" };
          yield { type: "result", ok: false, error: "SDK tumbang" };
          return;
        }
        yield { type: "session", sessionId: "sdk-1" };
        yield { type: "text", text: "balasan" };
        yield { type: "result", ok: true, anchorUuid: "anchor-1" };
      },
    };
    const mgr = manager({ runner, store });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    await mgr.rewindConversation(id, userSeq);
    await mgr.send(id, "pesan kedua");
    await mgr.done(id);

    const stored = store.loadSessions()[0];
    expect(stored?.info.rewindTo).toEqual({ uuid: "anchor-1", sdkSessionId: "sdk-1" });
    store.close();
  });

  test("sesi tak ada ditolak dengan tidak-ditemukan", async () => {
    const mgr = manager({ runner: anchorRunner([]) });

    await expect(mgr.rewindConversation("s_tidakada", 4)).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
  });

  test("sesi berjalan ditolak dengan konflik", async () => {
    const mgr = manager({ runner: runnerMenunggu() });
    const info = await mgr.create({ prompt: "Halo dunia", cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(mgr.rewindConversation(info.id, 1)).rejects.toMatchObject({
      code: "konflik",
    });

    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });

  test("target yang bukan pesan pengguna ditolak dengan tidak-valid", async () => {
    const mgr = manager({ runner: anchorRunner([]) });
    const { id } = await sesiDenganPesan(mgr);

    // Seq 1 adalah event session, bukan pesan pengguna.
    await expect(mgr.rewindConversation(id, 1)).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(mgr.rewindConversation(id, 2)).rejects.toMatchObject({
      code: "tidak-valid",
    });
  });

  test("pesan tanpa jangkar giliran sebelumnya ditolak dengan tidak-valid", async () => {
    const mgr = manager({ runner: runnerTanpaJangkar() });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    await expect(mgr.rewindConversation(id, userSeq)).rejects.toMatchObject({
      code: "tidak-valid",
    });
  });

  test("eventSeq yang bukan nomor urut ditolak dengan tidak-valid", async () => {
    const mgr = manager({ runner: anchorRunner([]) });
    const { id, userSeq } = await sesiDenganPesan(mgr);

    for (const nilai of ["4", 4.5, -1, 0, undefined, null]) {
      await expect(mgr.rewindConversation(id, nilai)).rejects.toMatchObject({
        code: "tidak-valid",
      });
    }
    expect(userSeq).toBeGreaterThan(0);
  });

  test("target yang tidak ada ditolak dengan tidak-valid", async () => {
    const mgr = manager({ runner: anchorRunner([]) });
    const { id } = await sesiDenganPesan(mgr);

    await expect(mgr.rewindConversation(id, 999)).rejects.toMatchObject({
      code: "tidak-valid",
    });
  });
});

describe("POST /api/sessions/:id/rewind", () => {
  let providersFile: string;

  beforeEach(async () => {
    providersFile = join(dir, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        profiles: [
          {
            id: "lokal",
            name: "Lokal",
            baseUrl: "https://lokal.test",
            apiKey: API_KEY,
            models: [{ id: "mock-model" }],
            defaultModel: "mock-model",
          },
        ],
        activeProfileId: "lokal",
      }),
      "utf8",
    );
  });

  type App = ReturnType<typeof createApp>;

  function makeApp(manager: SessionManager): App {
    return createApp({
      providersPath: providersFile,
      env: { MOCK: "true" },
      runner: anchorRunner([]),
      sessions: manager,
    });
  }

  function req(
    server: App,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return server.handle(
      new Request(`http://127.0.0.1:3000${path}`, { method, headers, body: payload }),
    );
  }

  test("mundur berhasil menghasilkan 200 dengan teks pesan", async () => {
    const mgr = manager({ runner: anchorRunner([]) });
    const server = makeApp(mgr);
    const { id, userSeq } = await sesiDenganPesan(mgr);

    const res = await req(server, "POST", `/api/sessions/${id}/rewind`, { eventSeq: userSeq });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "pesan kedua" });
  });

  test("body tanpa eventSeq atau eventSeq bukan bilangan ditolak 400", async () => {
    const mgr = manager({ runner: anchorRunner([]) });
    const server = makeApp(mgr);
    const { id, userSeq } = await sesiDenganPesan(mgr);

    for (const body of [{}, { eventSeq: "4" }, { eventSeq: 1.5 }, { eventSeq: null }]) {
      const res = await req(server, "POST", `/api/sessions/${id}/rewind`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(userSeq).toBeGreaterThan(0);
  });

  test("sesi tak ada menghasilkan 404", async () => {
    const server = makeApp(manager({ runner: anchorRunner([]) }));

    const res = await req(server, "POST", "/api/sessions/s_tidakada/rewind", { eventSeq: 1 });

    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  test("sesi yang sedang berjalan menghasilkan 409", async () => {
    const mgr = manager({ runner: runnerMenunggu() });
    const server = makeApp(mgr);
    const info = await mgr.create({ prompt: "Halo dunia", cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const res = await req(server, "POST", `/api/sessions/${info.id}/rewind`, { eventSeq: 1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toHaveProperty("error");

    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });

  test("body non-JSON ditolak guard content-type", async () => {
    const server = makeApp(manager({ runner: anchorRunner([]) }));

    const res = await server.handle(
      new Request("http://127.0.0.1:3000/api/sessions/s_1/rewind", {
        method: "POST",
        headers: { host: "127.0.0.1:3000" },
        body: JSON.stringify({ eventSeq: 1 }),
      }),
    );

    expect(res.status).toBe(415);
  });
});
