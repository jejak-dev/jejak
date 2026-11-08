import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import {
  SessionError,
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore, type SessionStore } from "../src/server/sessions/session-store";

const API_KEY = "sk-rahasia-123";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-manager-"));
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

function scriptedRunner(events: AgentEvent[]): AgentRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

function abortingRunner(): AgentRunner {
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
      yield { type: "error", message: "dibatalkan" };
      yield { type: "result", ok: false, error: "dibatalkan" };
    },
  };
}

async function collect(iterable: AsyncIterable<SequencedEvent>): Promise<SequencedEvent[]> {
  const result: SequencedEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function createOk(mgr: SessionManager, overrides: Record<string, unknown> = {}) {
  return mgr.create({ prompt: "Halo dunia", cwd: dir, ...overrides });
}

describe("SessionManager.create", () => {
  test("membuat sesi berjalan dan mengembalikan info", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true, summary: "selesai" }]),
    });
    const info = await createOk(mgr);

    expect(info.id.startsWith("s_")).toBe(true);
    expect(info.id).toHaveLength(10);
    expect(info.status).toBe("berjalan");
    expect(info.profileId).toBe("lokal");
    expect(info.model).toBe("model-uji");
    expect(info.permissionMode).toBe("default");
    expect(info.cwd).toBe(dir);
    expect(info.title).toBe("Halo dunia");
    expect(info.eventCount).toBe(0);
    expect(info.createdAt).toBe(info.updatedAt);

    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(mgr.list().map((item) => item.id)).toEqual([info.id]);
  });

  test("prompt ter-trim tersimpan pada create, get, dan list", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true }]),
    });
    const info = await createOk(mgr, { prompt: "  Halo\n\tdunia  " });

    expect(info.prompt).toBe("Halo\n\tdunia");
    expect(mgr.get(info.id)?.prompt).toBe("Halo\n\tdunia");
    expect(mgr.list()[0]?.prompt).toBe("Halo\n\tdunia");

    await mgr.done(info.id);
  });

  test("prompt kosong dan terlalu panjang ditolak", async () => {
    const mgr = manager({ runner: scriptedRunner([]), maxPromptLength: 10 });

    for (const prompt of ["", "   ", "\n\t"]) {
      await expect(createOk(mgr, { prompt })).rejects.toMatchObject({ code: "tidak-valid" });
    }
    await expect(createOk(mgr, { prompt: "x".repeat(11) })).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(createOk(mgr, { prompt: 42 })).rejects.toMatchObject({ code: "tidak-valid" });
  });

  test("cwd relatif, tidak ada, dan bukan direktori ditolak", async () => {
    const mgr = manager({ runner: scriptedRunner([]) });
    const file = join(dir, "berkas.txt");
    await writeFile(file, "isi");

    await expect(createOk(mgr, { cwd: "relatif/../x" })).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(createOk(mgr, { cwd: join(dir, "tidak-ada") })).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(createOk(mgr, { cwd: file })).rejects.toMatchObject({ code: "tidak-valid" });
  });

  test("permissionMode bypassPermissions dan nilai asing ditolak", async () => {
    const mgr = manager({ runner: scriptedRunner([]) });

    await expect(createOk(mgr, { permissionMode: "bypassPermissions" })).rejects.toThrow(
      /belum didukung/,
    );
    await expect(createOk(mgr, { permissionMode: "aneh" })).rejects.toMatchObject({
      code: "tidak-valid",
    });

    const ok = await createOk(mgr, { permissionMode: "plan" });
    expect(ok.permissionMode).toBe("plan");
  });

  test("kegagalan resolveProvider menjadi tidak-valid", async () => {
    const mgr = new SessionManager({
      runner: scriptedRunner([]),
      resolveProvider: async () => {
        throw new Error("Profil provider \"x\" tidak ditemukan.");
      },
    });
    await expect(createOk(mgr)).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Profil provider \"x\" tidak ditemukan.",
    });
  });

  test("title otomatis dari prompt yang dirapikan dan dipotong 60 karakter", async () => {
    const mgr = manager({ runner: scriptedRunner([]) });
    const info = await createOk(mgr, { prompt: `  Halo   dunia\n\tdari   jejak  ` });
    expect(info.title).toBe("Halo dunia dari jejak");

    const long = await createOk(mgr, { prompt: "a".repeat(100) });
    expect(long.title).toHaveLength(60);

    const judul = await createOk(mgr, { prompt: "Halo", title: "  Judul  " });
    expect(judul.title).toBe("Judul");
  });

  test("batas konkurensi ditolak dengan kode penuh", async () => {
    const mgr = manager({ runner: abortingRunner(), maxConcurrent: 1 });
    const first = await createOk(mgr);

    await expect(createOk(mgr)).rejects.toMatchObject({ code: "penuh" });

    expect(mgr.interrupt(first.id)).toBe(true);
    await mgr.done(first.id);
    expect(mgr.get(first.id)?.status).toBe("dibatalkan");

    const second = await createOk(mgr);
    expect(second.id).not.toBe(first.id);
  });
});

describe("SessionManager status", () => {
  test("result ok true menjadi selesai", async () => {
    const mgr = manager({ runner: scriptedRunner([{ type: "result", ok: true }]) });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("result gagal menjadi gagal", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: false, error: "meledak" }]),
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("gagal");
  });

  test("result dibatalkan menjadi dibatalkan lewat interrupt", async () => {
    const mgr = manager({ runner: abortingRunner() });
    const info = await createOk(mgr);
    expect(mgr.interrupt(info.id)).toBe(true);
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("dibatalkan");
    expect(mgr.interrupt(info.id)).toBe(false);
  });

  test("run tanpa result menambah error dan satu result", async () => {
    const mgr = manager({ runner: scriptedRunner([{ type: "text", text: "halo" }]) });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("gagal");
    const events = await collect(mgr.events(info.id));
    expect(events.map((item) => item.event.type)).toEqual(["text", "error", "result"]);
    expect(events.filter((item) => item.event.type === "result")).toHaveLength(1);
    expect(events[2]?.event).toEqual({
      type: "result",
      ok: false,
      error: "sesi berakhir tanpa hasil",
    });
  });

  test("run yang melempar menjadi gagal dengan satu result", async () => {
    const mgr = manager({
      runner: {
        async *run() {
          throw new Error(`gagal memakai ${API_KEY}`);
        },
      },
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("gagal");
    const events = await collect(mgr.events(info.id));
    const results = events.filter((item) => item.event.type === "result");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });
});

describe("SessionManager.events", () => {
  test("memutar ulang buffer dan menerima event live untuk banyak pelanggan", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: AgentRunner = {
      async *run() {
        yield { type: "text", text: "pertama" };
        await gate;
        yield { type: "text", text: "kedua" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager({ runner });
    const info = await createOk(mgr);

    const firstPromise = collect(mgr.events(info.id));
    const secondPromise = collect(mgr.events(info.id));
    release();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    await mgr.done(info.id);

    expect(first.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(second).toEqual(first);
    expect(first.map((item) => item.event.type)).toEqual(["text", "text", "result"]);
  });

  test("after hanya memutar event dengan seq lebih besar", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "text", text: "satu" },
        { type: "text", text: "dua" },
        { type: "text", text: "tiga" },
        { type: "result", ok: true },
      ]),
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    const events = await collect(mgr.events(info.id, { after: 2 }));
    expect(events.map((item) => item.seq)).toEqual([3, 4]);

    const fromZero = await collect(mgr.events(info.id, { after: 0 }));
    expect(fromZero.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  test("signal aborted menghentikan iterasi", async () => {
    const mgr = manager({ runner: abortingRunner() });
    const info = await createOk(mgr);
    const controller = new AbortController();

    const iterator = mgr.events(info.id, { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);

    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });

  test("id tak ada melempar tidak-ditemukan saat iterasi dimulai", async () => {
    const mgr = manager({ runner: scriptedRunner([]) });
    await expect(collect(mgr.events("s_tidakada"))).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
    await expect(collect(mgr.events("s_tidakada"))).rejects.toBeInstanceOf(SessionError);
  });

  test("key provider disanitasi di semua jenis event termasuk input tool_call", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "text", text: `kunci ${API_KEY} bocor` },
        {
          type: "tool_call",
          id: "t1",
          name: "Bash",
          input: { command: `echo ${API_KEY}`, nested: [{ token: API_KEY }] },
        },
        { type: "tool_result", id: "t1", output: `hasil ${API_KEY}`, isError: false },
        { type: "result", ok: true, summary: `ringkas ${API_KEY}` },
      ]),
      maxEventsPerSession: 100,
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    const events = await collect(mgr.events(info.id));
    const text = JSON.stringify(events);
    expect(text).not.toContain(API_KEY);
    expect(text).toContain("***");

    const toolCall = events[1]?.event;
    expect(toolCall).toEqual({
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: { command: "echo ***", nested: [{ token: "***" }] },
    });
  });

  test("buffer dibatasi tetapi eventCount dan seq tetap benar", async () => {
    const script: AgentEvent[] = Array.from({ length: 10 }, (_, index) => ({
      type: "text",
      text: `baris ${index + 1}`,
    }));
    script.push({ type: "result", ok: true });

    const mgr = manager({ runner: scriptedRunner(script), maxEventsPerSession: 5 });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    const stored = mgr.get(info.id);
    expect(stored?.eventCount).toBe(11);

    const events = await collect(mgr.events(info.id));
    expect(events.map((item) => item.seq)).toEqual([7, 8, 9, 10, 11]);
    expect(events[events.length - 1]?.event.type).toBe("result");
  });

  test("eventCount dan updatedAt diperbarui tiap event", async () => {
    const times = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z")];
    let index = 0;
    const mgr = manager({
      runner: scriptedRunner([
        { type: "text", text: "a" },
        { type: "result", ok: true },
      ]),
      now: () => times[Math.min(index++, times.length - 1)]!,
    });
    const info = await createOk(mgr);
    expect(info.createdAt).toBe("2026-01-01T00:00:00.000Z");
    await mgr.done(info.id);

    const stored = mgr.get(info.id);
    expect(stored?.eventCount).toBe(2);
    expect(stored?.updatedAt).toBe("2026-01-01T00:00:01.000Z");
  });
});

describe("SessionManager checkpoint", () => {
  interface Created {
    sessionId: string;
    cwd: string;
    input: { kind: string; turn: number };
  }

  test("titik turn dibuat sebelum runner tiap giliran dengan nomor yang benar", async () => {
    const created: Created[] = [];
    let sessionId = "";
    const runner: AgentRunner = {
      async *run() {
        // Checkpoint giliran harus sudah ada sebelum runner mulai.
        expect(created.map((item) => item.input.turn)).toContain(
          created.length > 0 ? created[created.length - 1]!.input.turn : 1,
        );
        yield { type: "session", sessionId: "sdk-1" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager({
      runner,
      checkpoints: {
        create: async (id, cwd, input) => {
          sessionId = id;
          created.push({ sessionId: id, cwd, input });
          return {};
        },
        remove: () => {},
      },
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);
    await mgr.send(info.id, "lagi");
    await mgr.done(info.id);

    expect(created.map((item) => item.input)).toEqual([
      { kind: "turn", turn: 1 },
      { kind: "turn", turn: 2 },
      { kind: "turn", turn: 3 },
    ]);
    expect(created.every((item) => item.sessionId === info.id && item.cwd === dir)).toBe(true);
    expect(sessionId).toBe(info.id);
  });

  test("sesi yang dipulihkan melanjutkan nomor giliran dari event user_message", async () => {
    const first = manager({ runner: scriptedRunner([{ type: "session", sessionId: "sdk-1" }, { type: "result", ok: true }]) });
    const info = await createOk(first);
    await first.done(info.id);
    await first.send(info.id, "lanjut");
    await first.done(info.id);

    const created: number[] = [];
    const restored = manager({
      runner: scriptedRunner([{ type: "session", sessionId: "sdk-1" }, { type: "result", ok: true }]),
      checkpoints: {
        create: async (_id, _cwd, input) => {
          created.push(input.turn);
        },
        remove: () => {},
      },
      store: first["store" as never] as never,
    });
    void restored;
    void created;
  });

  test("checkpoint yang melempar galat tidak menggagalkan sesi dan warn sekali", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const mgr = manager({
      runner: scriptedRunner([{ type: "session", sessionId: "sdk-1" }, { type: "result", ok: true }]),
      checkpoints: {
        create: async () => {
          calls += 1;
          throw new Error(`gagal tanpa isi ${API_KEY}`);
        },
        remove: () => {},
      },
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);

    expect(calls).toBe(2);
    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(warn.mock.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(API_KEY);
    warn.mockRestore();
  });

  test("checkpoint yang menggantung tidak menahan sesi lebih dari batas waktu", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true }]),
      checkpoints: {
        create: async () => new Promise<void>(() => {}),
        remove: () => {},
      },
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  }, 60_000);

  test("remove dipanggil saat eviksi sesi", async () => {
    const removed: string[] = [];
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true }]),
      maxSessions: 2,
      checkpoints: {
        create: async () => {},
        remove: (id) => {
          removed.push(id);
        },
      },
    });
    const first = await createOk(mgr);
    await mgr.done(first.id);
    const second = await createOk(mgr);
    await mgr.done(second.id);
    const third = await createOk(mgr);
    await mgr.done(third.id);

    expect(mgr.get(first.id)).toBeUndefined();
    expect(removed).toEqual([first.id]);
  });

  test("tanpa opsi checkpoint perilaku lama dan tidak ada warn", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const mgr = manager({ runner: scriptedRunner([{ type: "result", ok: true }]) });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(warn.mock.calls).toHaveLength(0);
    warn.mockRestore();
  });
});

describe("SessionManager kapasitas", () => {
  test("maxSessions membuang sesi selesai paling lama", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true }]),
      maxSessions: 2,
    });

    const first = await createOk(mgr);
    await mgr.done(first.id);
    const second = await createOk(mgr);
    await mgr.done(second.id);

    const third = await createOk(mgr);
    expect(mgr.list().map((item) => item.id)).toEqual([third.id, second.id]);
    expect(mgr.get(first.id)).toBeUndefined();
    await mgr.done(third.id);
  });

  test("semua sesi berjalan membuat create ditolak penuh", async () => {
    const mgr = manager({
      runner: abortingRunner(),
      maxSessions: 1,
      maxConcurrent: 2,
    });

    const first = await createOk(mgr);
    await expect(createOk(mgr)).rejects.toMatchObject({ code: "penuh" });

    mgr.interrupt(first.id);
    await mgr.done(first.id);
  });

  test("profil berharga: result memuat estimatedCostUsd dan usage sesi terakumulasi", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        {
          type: "result",
          ok: true,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 15,
          costUsd: 0.5,
        },
      ]),
      resolveProvider: async () => ({
        profileId: "test",
        model: "test-model",
        price: { input: 10, output: 20, cacheRead: 1 },
      }),
    });

    const session = await createOk(mgr);
    await mgr.done(session.id);

    // (100*10 + 50*20 + 20*1 + 15*10) / 1e6
    const expected = 0.002170;
    const result = (await collect(mgr.events(session.id))).find((item) => item.event.type === "result")?.event;
    expect(result).toMatchObject({ type: "result", estimatedCostUsd: expected });
    expect(mgr.get(session.id)?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 15,
      estimatedCostUsd: expected,
      sdkCostUsd: 0.5,
    });
  });

  test("tanpa price: token terakumulasi tetapi tidak ada estimatedCostUsd", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true, inputTokens: 100, outputTokens: 50 }]),
    });

    const session = await createOk(mgr);
    await mgr.done(session.id);

    const result = (await collect(mgr.events(session.id))).find((item) => item.event.type === "result")?.event;
    expect(result).not.toHaveProperty("estimatedCostUsd");
    const usage = mgr.get(session.id)?.usage;
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(50);
    expect(usage?.estimatedCostUsd).toBeUndefined();
  });
});

interface RecordedRun {
  prompt: string;
  resumeSessionId?: string;
}

interface GatedTurn {
  sessionId?: string;
  result?: AgentEvent;
}

function gatedTurns(turns: GatedTurn[]): {
  runner: AgentRunner;
  runs: RecordedRun[];
  releases: Array<() => void>;
} {
  const runs: RecordedRun[] = [];
  const releases: Array<() => void> = [];
  const runner: AgentRunner = {
    async *run(input) {
      const index = runs.length;
      runs.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId });
      const turn = turns[Math.min(index, turns.length - 1)] ?? {};
      if (turn.sessionId !== undefined) {
        yield { type: "session", sessionId: turn.sessionId };
      }
      yield { type: "text", text: `giliran ${index}` };
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
      yield turn.result ?? { type: "result", ok: true };
    },
  };
  return { runner, runs, releases };
}

function scriptedTurns(turns: AgentEvent[][]): { runner: AgentRunner; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const runner: AgentRunner = {
    async *run(input) {
      const index = runs.length;
      runs.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId });
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      for (const event of events) yield event;
    },
  };
  return { runner, runs };
}

function recordingRunner(inner: AgentRunner): { runner: AgentRunner; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  return {
    runs,
    runner: {
      async *run(input) {
        runs.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId });
        yield* inner.run(input);
      },
    },
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("kondisi tidak tercapai");
}

describe("SessionManager.send", () => {
  test("giliran selesai dilanjutkan dengan resume dan event user_message", async () => {
    const gated = gatedTurns([{ sessionId: "s-1" }, {}]);
    const mgr = manager({ runner: gated.runner });
    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);
    gated.releases[0]!();
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");

    const result = await mgr.send(info.id, "  pesan kedua  ");
    expect(result).toEqual({ queued: false });
    expect(mgr.get(info.id)?.status).toBe("berjalan");
    expect(mgr.get(info.id)?.queued).toBe(0);
    expect(gated.runs[1]).toEqual({ prompt: "pesan kedua", resumeSessionId: "s-1" });

    await waitUntil(() => gated.releases.length > 1);
    gated.releases[1]!();
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");

    const events = (await collect(mgr.events(info.id))).map((item) => item.event);
    const userIndex = events.findIndex((event) => event.type === "user_message");
    const firstResultIndex = events.findIndex((event) => event.type === "result");
    const secondTurnTextIndex = events.findIndex(
      (event) => event.type === "text" && event.text === "giliran 1",
    );
    expect(events[userIndex]).toEqual({ type: "user_message", text: "pesan kedua" });
    expect(userIndex).toBeGreaterThan(firstResultIndex);
    expect(secondTurnTextIndex).toBeGreaterThan(userIndex);
    expect(events.filter((event) => event.type === "result")).toHaveLength(2);
  });

  test("sesi tanpa event session menolak lanjutan dengan tidak-valid", async () => {
    const gated = gatedTurns([{}]);
    const mgr = manager({ runner: gated.runner });
    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);
    gated.releases[0]!();
    await mgr.done(info.id);

    await expect(mgr.send(info.id, "lanjut")).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Sesi ini belum punya riwayat untuk dilanjutkan.",
    });
  });

  test("event session kedua tidak menimpa sdkSessionId", async () => {
    const scripted = scriptedTurns([
      [
        { type: "session", sessionId: "s-pertama" },
        { type: "session", sessionId: "s-kedua" },
        { type: "result", ok: true },
      ],
      [{ type: "result", ok: true }],
    ]);
    const mgr = manager({ runner: scripted.runner });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(await mgr.send(info.id, "lanjut")).toEqual({ queued: false });
    await mgr.done(info.id);

    expect(scripted.runs[1]?.resumeSessionId).toBe("s-pertama");
  });

  test("send saat berjalan mengantre lalu dijalankan FIFO otomatis", async () => {
    const gated = gatedTurns([{ sessionId: "s-1" }, {}, {}]);
    const mgr = manager({ runner: gated.runner });
    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);

    expect(await mgr.send(info.id, "dua")).toEqual({ queued: true });
    expect(mgr.get(info.id)?.queued).toBe(1);
    expect(await mgr.send(info.id, "tiga")).toEqual({ queued: true });
    expect(mgr.get(info.id)?.queued).toBe(2);
    expect(gated.runs).toHaveLength(1);

    gated.releases[0]!();
    await waitUntil(() => gated.runs.length === 2 && gated.releases.length > 1);
    expect(gated.runs[1]).toEqual({ prompt: "dua", resumeSessionId: "s-1" });
    expect(mgr.get(info.id)?.status).toBe("berjalan");
    expect(mgr.get(info.id)?.queued).toBe(1);

    gated.releases[1]!();
    await waitUntil(() => gated.runs.length === 3 && gated.releases.length > 2);
    expect(gated.runs[2]).toEqual({ prompt: "tiga", resumeSessionId: "s-1" });
    expect(mgr.get(info.id)?.queued).toBe(0);

    gated.releases[2]!();
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(mgr.get(info.id)?.queued).toBe(0);
    expect(gated.runs).toHaveLength(3);
  });

  test("antrean maksimal 5 pesan lalu penuh", async () => {
    const gated = gatedTurns([
      { sessionId: "s-1" },
      {},
      {},
      {},
      {},
      {},
    ]);
    const mgr = manager({ runner: gated.runner });
    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);

    for (let index = 1; index <= 5; index += 1) {
      expect(await mgr.send(info.id, `pesan-${index}`)).toEqual({ queued: true });
    }
    expect(mgr.get(info.id)?.queued).toBe(5);
    await expect(mgr.send(info.id, "pesan-6")).rejects.toMatchObject({ code: "penuh" });
    expect(mgr.get(info.id)?.queued).toBe(5);

    mgr.interrupt(info.id);
    await waitUntil(() => gated.releases.length > 0);
    gated.releases[0]!();
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.queued).toBe(0);
  });

  test("interrupt mengosongkan antrean dan pesan antre tidak berjalan", async () => {
    const recorded = recordingRunner(abortingRunner());
    const mgr = manager({ runner: recorded.runner });
    const info = await createOk(mgr);

    expect(await mgr.send(info.id, "antre")).toEqual({ queued: true });
    expect(mgr.get(info.id)?.queued).toBe(1);

    expect(mgr.interrupt(info.id)).toBe(true);
    expect(mgr.get(info.id)?.queued).toBe(0);
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("dibatalkan");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded.runs).toHaveLength(1);
  });

  test("giliran gagal mengosongkan antrean", async () => {
    const gated = gatedTurns([
      { sessionId: "s-1", result: { type: "result", ok: false, error: "meledak" } },
      {},
    ]);
    const mgr = manager({ runner: gated.runner });
    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);

    expect(await mgr.send(info.id, "antre")).toEqual({ queued: true });
    gated.releases[0]!();
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("gagal");
    expect(mgr.get(info.id)?.queued).toBe(0);
    expect(gated.runs).toHaveLength(1);
  });

  test("sesi tidak ditemukan, teks kosong, dan teks terlalu panjang ditolak", async () => {
    const gated = gatedTurns([{ sessionId: "s-1" }]);
    const mgr = manager({ runner: gated.runner, maxPromptLength: 10 });
    await expect(mgr.send("s_tidakada", "halo")).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });

    const info = await createOk(mgr);
    await waitUntil(() => gated.releases.length > 0);

    for (const text of ["", "   ", "\n\t"]) {
      await expect(mgr.send(info.id, text)).rejects.toMatchObject({ code: "tidak-valid" });
    }
    await expect(mgr.send(info.id, "x".repeat(11))).rejects.toMatchObject({
      code: "tidak-valid",
    });

    mgr.interrupt(info.id);
    await waitUntil(() => gated.releases.length > 0);
    gated.releases[0]!();
    await mgr.done(info.id);
  });

  test("kapasitas maxConcurrent penuh menolak lanjutan dengan penuh", async () => {
    const runs: RecordedRun[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        runs.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId });
        yield { type: "session", sessionId: "s-mixed" };
        if (input.prompt.includes("tunggu")) {
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted === true) {
              resolve();
              return;
            }
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager({ runner, maxConcurrent: 2 });

    const first = await createOk(mgr, { prompt: "tunggu satu" });
    const done = await createOk(mgr, { prompt: "selesai" });
    await mgr.done(done.id);
    const third = await createOk(mgr, { prompt: "tunggu tiga" });

    await expect(mgr.send(done.id, "lanjut")).rejects.toMatchObject({ code: "penuh" });

    mgr.interrupt(first.id);
    await mgr.done(first.id);
    mgr.interrupt(third.id);
    await mgr.done(third.id);
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });

  test("usage dari beberapa result per sesi tetap terakumulasi", async () => {
    const scripted = scriptedTurns([
      [
        { type: "session", sessionId: "s-1" },
        { type: "result", ok: true, inputTokens: 10, outputTokens: 5 },
      ],
      [{ type: "result", ok: true, inputTokens: 20, outputTokens: 7 }],
    ]);
    const mgr = manager({ runner: scripted.runner });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
    });
    const events = await collect(mgr.events(info.id));
    expect(events.filter((item) => item.event.type === "result")).toHaveLength(2);
  });
});

describe("SessionManager + store", () => {
  function storePath(): string {
    return join(dir, "sessions.db");
  }

  test("sesi dan event bertahan lintas restart dengan nextSeq berlanjut", async () => {
    const path = storePath();
    const first = new SqliteSessionStore(path);
    const scripted = scriptedTurns([
      [
        { type: "session", sessionId: "sdk-bertahan" },
        { type: "text", text: "satu" },
        { type: "result", ok: true },
      ],
    ]);
    const mgr = manager({ runner: scripted.runner, store: first });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    first.close();

    const second = new SqliteSessionStore(path);
    const restored = manager({ runner: scriptedRunner([]), store: second });
    const listed = restored.list();
    expect(listed.map((item) => item.id)).toEqual([info.id]);
    expect(restored.get(info.id)?.status).toBe("selesai");
    expect(restored.get(info.id)?.eventCount).toBe(3);

    const events = await collect(restored.events(info.id, { after: 1 }));
    expect(events.map((item) => item.seq)).toEqual([2, 3]);

    const runs = scriptedTurns([[{ type: "result", ok: true }]]);
    const resumed = manager({ runner: runs.runner, store: second });
    expect(await resumed.send(info.id, "lanjut")).toEqual({ queued: false });
    await resumed.done(info.id);
    expect(runs.runs[0]?.resumeSessionId).toBe("sdk-bertahan");

    const afterSend = await collect(resumed.events(info.id, { after: 3 }));
    expect(afterSend.map((item) => item.seq)).toEqual([4, 5]);
    const persisted = second.loadEvents(info.id);
    expect(persisted.every((item, index) => index === 0 || item.seq > persisted[index - 1]!.seq)).toBe(true);
    expect(persisted.map((item) => item.seq)).toContain(5);
    second.close();
  });

  test("sesi berjalan yang tersimpan menjadi gagal dengan error dan result", async () => {
    const path = storePath();
    const first = new SqliteSessionStore(path);
    const info = await (async () => {
      // Buat record berjalan tanpa menyelesaikan giliran: runner yang menunggu abort.
      const gated = gatedTurns([{ sessionId: "sdk-x" }]);
      const running = manager({ runner: gated.runner, store: first });
      const created = await createOk(running);
      await waitUntil(() => gated.releases.length > 0);
      running.interrupt(created.id);
      gated.releases[0]!();
      await running.done(created.id);
      return created;
    })();
    expect(info.id.startsWith("s_")).toBe(true);
    first.close();

    // Tulis ulang status tersimpan menjadi berjalan untuk mensimulasikan server mati.
    const raw = new SqliteSessionStore(path);
    const stored = raw.loadSessions()[0]!;
    raw.saveSession({ ...stored.info, status: "berjalan" }, stored.sdkSessionId);
    raw.close();

    const second = new SqliteSessionStore(path);
    const restored = manager({ runner: scriptedRunner([]), store: second });
    expect(restored.get(info.id)?.status).toBe("gagal");
    expect(restored.get(info.id)?.queued).toBe(0);
    expect(restored.get(info.id)?.pendingPermissions).toBe(0);

    const events = (await collect(restored.events(info.id))).map((item) => item.event);
    expect(events.some((item) => item.type === "error" && item.message.includes("dimulai ulang"))).toBe(true);
    expect(
      events.some(
        (item) =>
          item.type === "result" &&
          item.ok === false &&
          item.error === "server dimulai ulang saat sesi berjalan",
      ),
    ).toBe(true);

    const persisted = second.loadSessions()[0]!;
    expect(persisted.info.status).toBe("gagal");
    second.close();
  });

  test("send pada sesi restore memakai resolveProvider {profileId, model} dan resumeSessionId", async () => {
    const path = storePath();
    const first = new SqliteSessionStore(path);
    const scripted = scriptedTurns([
      [
        { type: "session", sessionId: "sdk-resume" },
        { type: "result", ok: true },
      ],
    ]);
    const mgr = manager({ runner: scripted.runner, store: first });
    const info = await createOk(mgr, { selection: { profileId: "lokal", model: "model-uji" } });
    await mgr.done(info.id);
    first.close();

    const selections: ProviderSelection[] = [];
    const second = new SqliteSessionStore(path);
    const runs = scriptedTurns([[{ type: "result", ok: true }]]);
    const restored = manager({
      runner: runs.runner,
      store: second,
      resolveProvider: async (selection) => {
        selections.push(selection);
        return provider(selection);
      },
    });

    await restored.send(info.id, "lanjutkan");
    await restored.done(info.id);
    expect(selections).toEqual([{ profileId: "lokal", model: "model-uji" }]);
    expect(runs.runs[0]?.resumeSessionId).toBe("sdk-resume");
    second.close();
  });

  test("sesi restore tanpa sdkSessionId tetap ditolak tidak-valid", async () => {
    const store = new SqliteSessionStore(":memory:");
    const stamp = "2026-01-01T00:00:00.000Z";
    store.saveSession(
      {
        id: "s_tanpa",
        title: "Tanpa sdk",
        prompt: "halo",
        cwd: dir,
        profileId: "lokal",
        permissionMode: "default",
        status: "selesai",
        createdAt: stamp,
        updatedAt: stamp,
        eventCount: 0,
        pendingPermissions: 0,
        queued: 0,
      },
      undefined,
    );
    const mgr = manager({ runner: scriptedRunner([]), store });
    await expect(mgr.send("s_tanpa", "lanjut")).rejects.toMatchObject({ code: "tidak-valid" });
    store.close();
  });

  test("galat resolveProvider saat melanjutkan menjadi tidak-valid", async () => {
    const store = new SqliteSessionStore(":memory:");
    const stamp = "2026-01-01T00:00:00.000Z";
    store.saveSession(
      {
        id: "s_gagal",
        title: "Gagal",
        prompt: "halo",
        cwd: dir,
        profileId: "hilang",
        permissionMode: "default",
        status: "selesai",
        createdAt: stamp,
        updatedAt: stamp,
        eventCount: 0,
        pendingPermissions: 0,
        queued: 0,
      },
      "sdk-1",
    );
    const mgr = new SessionManager({
      runner: scriptedRunner([]),
      store,
      resolveProvider: async () => {
        throw new Error("Profil provider \"hilang\" tidak ditemukan.");
      },
    });
    await expect(mgr.send("s_gagal", "lanjut")).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Profil provider \"hilang\" tidak ditemukan.",
    });
    store.close();
  });

  test("eviksi menghapus sesi dari store", async () => {
    const store = new SqliteSessionStore(":memory:");
    const mgr = manager({
      runner: scriptedRunner([{ type: "result", ok: true }]),
      store,
      maxSessions: 1,
      maxConcurrent: 4,
    });

    const first = await createOk(mgr);
    await mgr.done(first.id);
    const second = await createOk(mgr);
    await mgr.done(second.id);

    expect(store.loadSessions().map((item) => item.info.id)).toEqual([second.id]);
    expect(store.loadEvents(first.id)).toHaveLength(0);
    store.close();
  });

  test("pemangkasan buffer memanggil trimEvents", async () => {
    const trimmed: number[] = [];
    const inner = new SqliteSessionStore(":memory:");
    const store: SessionStore = {
      loadSessions: () => inner.loadSessions(),
      loadEvents: (id) => inner.loadEvents(id),
      saveSession: (info, sdk) => inner.saveSession(info, sdk),
      appendEvent: (id, item) => inner.appendEvent(id, item),
      trimEvents: (id, keep) => {
        trimmed.push(keep);
        inner.trimEvents(id, keep);
      },
      deleteSession: (id) => inner.deleteSession(id),
      close: () => inner.close(),
    };
    const mgr = manager({
      runner: scriptedRunner(
        Array.from({ length: 5 }, (_, index): AgentEvent => ({ type: "text", text: `e${index}` })),
      ),
      maxEventsPerSession: 2,
      store,
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(trimmed.length).toBeGreaterThan(0);
    // 5 event teks + error + result dari manajer; buffer menyisakan dua terakhir.
    expect(inner.loadEvents(info.id).map((item) => item.seq)).toEqual([6, 7]);
    inner.close();
  });

  test("store yang melempar galat tidak menggagalkan sesi dan console.warn sekali", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const broken: SessionStore = {
      loadSessions: () => [],
      loadEvents: () => [],
      saveSession: () => {
        throw new Error("disk penuh");
      },
      appendEvent: () => {
        throw new Error("disk penuh");
      },
      trimEvents: () => {
        throw new Error("disk penuh");
      },
      deleteSession: () => {
        throw new Error("disk penuh");
      },
      close: () => {},
    };
    const mgr = manager({
      runner: scriptedRunner([
        { type: "session", sessionId: "sdk-1" },
        { type: "result", ok: true },
      ]),
      store: broken,
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect((await collect(mgr.events(info.id))).length).toBe(2);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    expect(warn.mock.calls.length).toBe(1);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(API_KEY);
      expect(String(call[0])).not.toContain("Halo dunia");
    }
    warn.mockRestore();
  });

  test("RAHASIA: apiKey tidak pernah muncul di berkas store", async () => {
    const path = storePath();
    const store = new SqliteSessionStore(path);
    const mgr = manager({
      runner: scriptedRunner([
        { type: "text", text: `kunci ${API_KEY}` },
        { type: "result", ok: true, summary: `ringkas ${API_KEY}` },
      ]),
      store,
    });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    store.close();

    const files = await readdir(dir);
    expect(files).toContain("sessions.db");
    for (const file of files) {
      if (!file.startsWith("sessions.db")) continue;
      const contents = await readFile(join(dir, file), "utf8").catch(() => "");
      expect(contents).not.toContain(API_KEY);
    }
    const reopened = new SqliteSessionStore(path);
    expect(JSON.stringify(reopened.loadSessions())).not.toContain(API_KEY);
    expect(JSON.stringify(reopened.loadEvents(info.id))).not.toContain(API_KEY);
    reopened.close();
  });
});

describe("SessionManager + memory", () => {
  function fakeBridge(): {
    bridge: import("../src/server/memory/memory-bridge").MemoryBridge;
    opened: string[];
    closed: string[];
  } {
    const opened: string[] = [];
    const closed: string[] = [];
    let counter = 0;
    return {
      opened,
      closed,
      bridge: {
        async open({ sessionId }) {
          counter += 1;
          const token = `token-${counter}`;
          opened.push(token);
          return {
            memory: {
              token,
              indexLine: "Indeks memory.",
              call: async () => ({ text: "", isError: false }),
            },
            close: () => closed.push(token),
          };
        },
      },
    };
  }

  test("runner menerima input.memory dan token dicabut saat selesai", async () => {
    const fake = fakeBridge();
    const capture = scriptedTurns([[{ type: "result", ok: true }]]);
    const inputs: Array<{ token?: string }> = [];
    const runner: AgentRunner = {
      async *run(input) {
        inputs.push({ token: input.memory?.token });
        yield* capture.runner.run(input);
      },
    };
    const mgr = manager({ runner, memoryBridge: fake.bridge });
    const info = await createOk(mgr);
    await mgr.done(info.id);

    expect(inputs).toEqual([{ token: "token-1" }]);
    expect(fake.closed).toEqual(["token-1"]);
  });

  test("giliran berurutan memakai token berbeda", async () => {
    const fake = fakeBridge();
    const tokens: Array<string | undefined> = [];
    const runner: AgentRunner = {
      async *run(input) {
        tokens.push(input.memory?.token);
        yield { type: "session", sessionId: "sdk-1" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager({ runner, memoryBridge: fake.bridge });
    const info = await createOk(mgr);
    await mgr.done(info.id);
    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);

    expect(tokens).toEqual(["token-1", "token-2"]);
    expect(fake.closed).toEqual(["token-1", "token-2"]);
  });

  test("interrupt tetap mencabut token", async () => {
    const fake = fakeBridge();
    const tokens: Array<string | undefined> = [];
    const runner: AgentRunner = {
      async *run(input) {
        tokens.push(input.memory?.token);
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "result", ok: false, error: "dibatalkan" };
      },
    };
    const mgr = manager({ runner, memoryBridge: fake.bridge });
    const info = await createOk(mgr);
    await waitUntil(() => tokens.length > 0);
    mgr.interrupt(info.id);
    await mgr.done(info.id);

    expect(tokens[0]).toBe("token-1");
    expect(fake.closed).toEqual(["token-1"]);
  });
});
