import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const ORIGIN_KEY = "sk-asal-rahasia";
const FALLBACK_KEY = "sk-cadangan-rahasia";

const ORIGIN: ResolvedProvider = {
  profileId: "asal",
  apiKey: ORIGIN_KEY,
  model: "model-asal",
  price: { input: 100, output: 200 },
};

const FALLBACK: ResolvedProvider = {
  profileId: "cadangan",
  apiKey: FALLBACK_KEY,
  model: "model-cadangan",
  price: { input: 1, output: 2 },
};

let dir: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-fallback-"));
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(dir, { recursive: true, force: true });
});

function memoryAudit(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function manager(
  runner: AgentRunner,
  options: Partial<SessionManagerOptions> & {
    fallbackProvider?: ResolvedProvider | undefined;
    fallbackCalls?: string[];
  } = {},
): SessionManager {
  const { fallbackProvider, fallbackCalls, ...rest } = options;
  return new SessionManager({
    runner,
    resolveProvider: async (selection: ProviderSelection) => ({
      ...ORIGIN,
      ...(selection.profileId === undefined ? {} : { profileId: selection.profileId }),
    }),
    fallback: async (profileId) => {
      fallbackCalls?.push(profileId);
      return fallbackProvider;
    },
    ...rest,
  });
}

function connectionFailureRunner(): { runner: AgentRunner; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const runner: AgentRunner = {
    async *run(input) {
      index += 1;
      calls.push(input.provider.profileId);
      if (index === 1) {
        yield { type: "error", message: "connect ECONNREFUSED 127.0.0.1:443" };
        yield { type: "result", ok: false, error: "connect ECONNREFUSED 127.0.0.1:443" };
        return;
      }
      yield { type: "session", sessionId: "sdk-cadangan" };
      yield { type: "text", text: "halo dari cadangan" };
      yield {
        type: "result",
        ok: true,
        inputTokens: 1_000_000,
        outputTokens: 0,
      };
    },
  };
  return { runner, calls };
}

async function collect(mgr: SessionManager, id: string): Promise<SequencedEvent[]> {
  const events: SequencedEvent[] = [];
  for await (const item of mgr.events(id)) events.push(item);
  return events;
}

function eventsOf(items: SequencedEvent[]): AgentEvent[] {
  return items.map((item) => item.event);
}

function providerAudits(audit: AuditStore): AuditEntry[] {
  return audit.list({ kind: "provider", limit: 50 });
}

describe("SessionManager fallback provider", () => {
  test("(a) gagal koneksi sebelum output -> notice, audit, hasil sukses cadangan", async () => {
    const audit = memoryAudit();
    const { runner, calls } = connectionFailureRunner();
    const fallbackCalls: string[] = [];
    const mgr = manager(runner, {
      audit,
      fallbackProvider: FALLBACK,
      fallbackCalls,
    });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    const events = eventsOf(await collect(mgr, info.id));
    expect(calls).toEqual(["asal", "cadangan"]);
    expect(fallbackCalls).toEqual(["asal"]);

    // Event gagal percobaan pertama tidak masuk timeline.
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.some((event) => event.type === "result" && event.ok === false),
    ).toBe(false);

    const noticeIndex = events.findIndex((event) => event.type === "notice");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(events[noticeIndex]).toMatchObject({
      type: "notice",
      level: "warn",
      text: "Profil asal gagal (koneksi gagal); memakai cadangan.",
    });

    const result = events.find(
      (event): event is Extract<AgentEvent, { type: "result" }> =>
        event.type === "result" && event.ok,
    );
    expect(result?.ok).toBe(true);
    // Biaya memakai harga cadangan (1_000_000 * 1 / 1e6).
    expect(result?.estimatedCostUsd).toBeCloseTo(1, 9);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    const entries = providerAudits(audit);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toBe("Fallback provider: asal → cadangan");
    expect(entries[0]?.meta).toEqual({ dari: "asal", ke: "cadangan", alasan: "koneksi" });
  });

  test("galat API dari SDK (teks sintetis + result generik) memicu fallback", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        if (calls.length === 1) {
          yield {
            type: "text",
            text: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
          };
          yield { type: "result", ok: false, error: "eksekusi gagal (success)" };
          return;
        }
        yield { type: "text", text: "ok" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager(runner, { fallbackProvider: FALLBACK });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    const events = eventsOf(await collect(mgr, info.id));
    expect(calls).toEqual(["asal", "cadangan"]);
    expect(
      events.some((e) => e.type === "text" && e.text.startsWith("API Error")),
    ).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(true);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("teks 'API Error' tanpa fallback dikonfigurasi tetap tampil", async () => {
    const runner: AgentRunner = {
      async *run() {
        yield { type: "text", text: "API Error: Connection refused (ECONNREFUSED)" };
        yield { type: "result", ok: false, error: "eksekusi gagal (success)" };
      },
    };
    const mgr = manager(runner, { fallbackProvider: undefined });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);
    const events = eventsOf(await collect(mgr, info.id));
    expect(events.some((e) => e.type === "text" && e.text.startsWith("API Error"))).toBe(true);
    expect(mgr.get(info.id)?.status).toBe("gagal");
  });

  test("(b) galat setelah teks pertama tidak memicu fallback", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        yield { type: "text", text: "sudah mulai" };
        yield { type: "error", message: "socket hang up" };
        yield { type: "result", ok: false, error: "socket hang up" };
      },
    };
    const fallbackCalls: string[] = [];
    const mgr = manager(runner, { fallbackProvider: FALLBACK, fallbackCalls });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal"]);
    expect(fallbackCalls).toEqual([]);
    expect(mgr.get(info.id)?.status).toBe("gagal");
    const events = eventsOf(await collect(mgr, info.id));
    expect(events.some((event) => event.type === "notice")).toBe(false);
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
  });

  test("(c) galat non-provider tidak memicu fallback", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        yield { type: "error", message: "izin tool ditolak" };
        yield { type: "result", ok: false, error: "izin tool ditolak" };
      },
    };
    const fallbackCalls: string[] = [];
    const mgr = manager(runner, { fallbackProvider: FALLBACK, fallbackCalls });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal"]);
    expect(fallbackCalls).toEqual([]);
    expect(mgr.get(info.id)?.status).toBe("gagal");
  });

  test("(d) dibatalkan tidak memicu fallback", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
      },
    };
    const fallbackCalls: string[] = [];
    const mgr = manager(runner, { fallbackProvider: FALLBACK, fallbackCalls });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal"]);
    expect(fallbackCalls).toEqual([]);
    expect(mgr.get(info.id)?.status).toBe("dibatalkan");
  });

  test("(e) cadangan juga gagal -> gagal tanpa loop (runner dipanggil 2 kali)", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        yield { type: "error", message: "fetch failed" };
        yield { type: "result", ok: false, error: "fetch failed" };
      },
    };
    const fallbackCalls: string[] = [];
    const audit = memoryAudit();
    const mgr = manager(runner, { fallbackProvider: FALLBACK, fallbackCalls, audit });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal", "cadangan"]);
    expect(fallbackCalls).toEqual(["asal"]);
    expect(mgr.get(info.id)?.status).toBe("gagal");

    const events = eventsOf(await collect(mgr, info.id));
    expect(events.some((event) => event.type === "error")).toBe(true);
    // Hanya satu notice fallback, bukan dua.
    expect(events.filter((event) => event.type === "notice")).toHaveLength(1);
    expect(providerAudits(audit)).toHaveLength(1);
  });

  test("(f) tanpa fallback terkonfigurasi: perilaku lama", async () => {
    const runner: AgentRunner = {
      async *run() {
        yield { type: "error", message: "fetch failed" };
        yield { type: "result", ok: false, error: "fetch failed" };
      },
    };
    const mgr = new SessionManager({
      runner,
      resolveProvider: async () => ORIGIN,
    });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    const events = eventsOf(await collect(mgr, info.id));
    expect(events).toMatchObject([
      { type: "error", message: "fetch failed" },
      { type: "result", ok: false, error: "fetch failed" },
    ]);
    expect(mgr.get(info.id)?.status).toBe("gagal");
  });

  test("(f2) fallback mengembalikan undefined: perilaku lama", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        yield { type: "result", ok: false, error: "fetch failed" };
      },
    };
    const mgr = manager(runner, { fallbackProvider: undefined });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal"]);
    expect(mgr.get(info.id)?.status).toBe("gagal");
  });

  test("(g) info.profileId dan model tetap meski memakai cadangan", async () => {
    const { runner } = connectionFailureRunner();
    const mgr = manager(runner, { fallbackProvider: FALLBACK });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.profileId).toBe("asal");
    expect(mgr.get(info.id)?.model).toBe("model-asal");
  });

  test("(h) kunci asal dan cadangan tersanitasi dari pesan galat", async () => {
    const audit = memoryAudit();
    const runner: AgentRunner = {
      async *run() {
        yield {
          type: "error",
          message: `koneksi gagal dengan ${ORIGIN_KEY} dan ${FALLBACK_KEY}`,
        };
        yield {
          type: "result",
          ok: false,
          error: `koneksi gagal dengan ${ORIGIN_KEY} dan ${FALLBACK_KEY}`,
        };
      },
    };
    const mgr = manager(runner, { fallbackProvider: FALLBACK, audit });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    const events = eventsOf(await collect(mgr, info.id));
    const flat = JSON.stringify(events);
    expect(flat).not.toContain(ORIGIN_KEY);
    expect(flat).not.toContain(FALLBACK_KEY);
    expect(flat).toContain("***");
  });

  test("exception provider sebelum output memicu fallback", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async *run(input) {
        calls.push(input.provider.profileId);
        if (calls.length === 1) throw new Error("ETIMEDOUT");
        yield { type: "text", text: "ok" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager(runner, { fallbackProvider: FALLBACK });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual(["asal", "cadangan"]);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("event non-substantif yang tertahan diteruskan berurutan bila sukses", async () => {
    const runner: AgentRunner = {
      async *run() {
        yield { type: "session", sessionId: "sdk-asal" };
        yield { type: "notice", text: "catatan awal" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager(runner, { fallbackProvider: FALLBACK });

    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    const events = eventsOf(await collect(mgr, info.id));
    expect(events.map((event) => event.type)).toEqual(["session", "notice", "result"]);
  });
});
