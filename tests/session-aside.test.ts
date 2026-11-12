import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
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
  dir = await mkdtemp(join(tmpdir(), "jejak-session-aside-"));
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

/** Runner yang mencatat input terakhir dan membalas dengan teks tertentu. */
function recordingRunner(
  events: AgentEvent[],
  seen: RunInput[],
): AgentRunner {
  return {
    async *run(input) {
      seen.push(input);
      for (const event of events) yield event;
    },
  };
}

async function collect(iterable: AsyncIterable<SequencedEvent>): Promise<SequencedEvent[]> {
  const result: SequencedEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function createOk(mgr: SessionManager, overrides: Record<string, unknown> = {}) {
  const info = await mgr.create({ prompt: "Halo dunia", cwd: dir, ...overrides });
  await mgr.done(info.id);
  return info;
}

describe("SessionManager.askAside", () => {
  test("mengembalikan teks gabungan dari event text", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "session", sessionId: "mock-session" },
        { type: "text", text: "Ini jawaban " },
        { type: "text", text: "sampingan." },
        { type: "result", ok: true },
      ]),
    });
    const info = await createOk(mgr);

    const result = await mgr.askAside(info.id, "apa agenda sesi ini?");

    expect(result.answer).toBe("Ini jawaban sampingan.");
  });

  test("tidak menambah event ke timeline dan status tidak berubah", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "session", sessionId: "mock-session" },
        { type: "text", text: "halo" },
        { type: "result", ok: true },
      ]),
    });
    const info = await createOk(mgr);

    const sebelum = await collect(mgr.events(info.id));
    const statusSebelum = mgr.get(info.id)?.status;
    const jumlahSebelum = mgr.get(info.id)?.eventCount;

    await mgr.askAside(info.id, "apa kabar?");

    const sesudah = await collect(mgr.events(info.id));
    expect(sesudah.length).toBe(sebelum.length);
    expect(mgr.get(info.id)?.status).toBe(statusSebelum);
    expect(mgr.get(info.id)?.eventCount).toBe(jumlahSebelum);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("sdkSessionId sesi asal tidak berubah meski fork mengembalikan session baru", async () => {
    const seen: RunInput[] = [];
    const mgr = manager({
      runner: recordingRunner(
        [
          { type: "session", sessionId: "mock-session" },
          { type: "text", text: "siap" },
          { type: "result", ok: true },
        ],
        seen,
      ),
    });
    const info = await createOk(mgr);

    await mgr.askAside(info.id, "ringkas dong");

    const input = seen[seen.length - 1];
    expect(input?.resumeSessionId).toBe("mock-session");
    expect(input?.fork).toBe(true);
    expect(input?.noTools).toBe(true);
    expect(input?.permissionMode).toBe("plan");
    expect(input?.cwd).toBe(dir);
  });

  test("event session dari fork diabaikan dan teks delta tidak dihitung", async () => {
    const seen: RunInput[] = [];
    const mgr = manager({
      runner: recordingRunner(
        [
          { type: "session", sessionId: "mock-session" },
          { type: "text", text: "final" },
          { type: "text_delta", text: "delta" },
          { type: "session", sessionId: "sesi-fork" },
          { type: "result", ok: true },
        ],
        seen,
      ),
    });
    const info = await createOk(mgr);

    const result = await mgr.askAside(info.id, "ya");

    expect(result.answer).toBe("final");
  });

  test("sesi tak ada ditolak dengan tidak-ditemukan", async () => {
    const mgr = manager({ runner: scriptedRunner([{ type: "result", ok: true }]) });
    await expect(mgr.askAside("s_tidakada", "halo")).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
    await expect(mgr.askAside("s_tidakada", "halo")).rejects.toBeInstanceOf(SessionError);
  });

  test("pertanyaan kosong dan bukan string ditolak", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "session", sessionId: "mock-session" },
        { type: "result", ok: true },
      ]),
    });
    const info = await createOk(mgr);

    await expect(mgr.askAside(info.id, "   ")).rejects.toMatchObject({ code: "tidak-valid" });
    await expect(mgr.askAside(info.id, "")).rejects.toMatchObject({ code: "tidak-valid" });
    await expect(mgr.askAside(info.id, 42)).rejects.toMatchObject({ code: "tidak-valid" });
    await expect(mgr.askAside(info.id, undefined)).rejects.toMatchObject({ code: "tidak-valid" });
  });

  test("sesi tanpa riwayat ditolak", async () => {
    const mgr = manager({
      runner: scriptedRunner([{ type: "text", text: "halo" }, { type: "result", ok: true }]),
    });
    const info = await createOk(mgr);

    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toThrow(
      "Sesi ini belum punya riwayat untuk ditanya.",
    );
  });

  test("galat runner menjadi SessionError", async () => {
    const mgr = manager({
      runner: {
        async *run() {
          yield { type: "session", sessionId: "mock-session" };
          throw new Error("SDK tumbang");
        },
      },
    });
    const info = await createOk(mgr);

    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toBeInstanceOf(SessionError);
    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toThrow("SDK tumbang");
  });

  test("result gagal menjadi SessionError dengan pesan galat", async () => {
    const mgr = manager({
      runner: scriptedRunner([
        { type: "session", sessionId: "mock-session" },
        { type: "error", message: "kegagalan model" },
        { type: "result", ok: false, error: "kegagalan model" },
      ]),
    });
    const info = await createOk(mgr);

    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toMatchObject({
      code: "tidak-valid",
    });
    await expect(mgr.askAside(info.id, "apa kabar?")).rejects.toThrow("kegagalan model");
  });

  test("provider yang sudah selesai tidak diubah oleh pertanyaan sampingan", async () => {
    const seen: RunInput[] = [];
    const mgr = manager({
      runner: recordingRunner(
        [
          { type: "session", sessionId: "mock-session" },
          { type: "text", text: "siap" },
          { type: "result", ok: true },
        ],
        seen,
      ),
    });
    const info = await createOk(mgr);

    await mgr.askAside(info.id, "ringkas");

    const input = seen[seen.length - 1];
    expect(input?.provider.profileId).toBe("lokal");
    expect(input?.provider.model).toBe("model-uji");
  });

  test("boleh berjalan saat sesi sedang berjalan", async () => {
    const mgr = manager({
      runner: {
        async *run(input) {
          if (input.fork === true) {
            yield { type: "text", text: "jawab" };
            yield { type: "result", ok: true };
            return;
          }
          yield { type: "session", sessionId: "mock-session" };
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
      },
    });
    const info = await mgr.create({ prompt: "Halo dunia", cwd: dir });
    // Tunggu giliran pertama sampai sesi SDK tercatat.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await mgr.askAside(info.id, "apa kabar?");

    expect(result.answer).toBe("jawab");
    expect(mgr.get(info.id)?.status).toBe("berjalan");

    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });
});
