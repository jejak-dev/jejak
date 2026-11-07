import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
