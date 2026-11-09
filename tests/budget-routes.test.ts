import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { FileBudgetStore } from "../src/server/budget/budget-store";
import { SqliteUsageLedger, type UsageLedger } from "../src/server/budget/usage-ledger";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let root: string;
let ledgers: UsageLedger[] = [];
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-budget-rute-"));
});

afterEach(async () => {
  for (const ledger of ledgers) ledger.close();
  for (const audit of audits) audit.close();
  ledgers = [];
  audits = [];
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function runner(): AgentRunner {
  return {
    async *run() {
      yield { type: "result", ok: true } as AgentEvent;
    },
  };
}

function setup(options: { store?: FileBudgetStore | false; ledger?: UsageLedger; audit?: AuditStore } = {}) {
  const store =
    options.store === false ? undefined : options.store ?? new FileBudgetStore(":memory:", { warnAt: 0.8 });
  const ledger = options.ledger ?? new SqliteUsageLedger(":memory:");
  if (options.ledger === undefined) ledgers.push(ledger);
  const manager = new SessionManager({
    runner: runner(),
    resolveProvider: async () => PROVIDER,
  });
  const app = createApp({
    sessions: manager,
    env: { MOCK: "true", JEJAK_HOME: join(root, "home") },
    ...(store === undefined ? {} : { budget: store }),
    usageLedger: ledger,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  return { app, store, ledger, manager };
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

describe("rute anggaran", () => {
  test("GET membaca config", async () => {
    const { app } = setup();
    const res = await req(app, "GET", "/api/budget");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warnAt: 0.8 });
  });

  test("PUT menyimpan, menghapus batas dengan null, dan mencatat audit", async () => {
    const audit = new SqliteAuditStore(":memory:");
    audits.push(audit);
    const { app, store } = setup({ audit });

    const saved = await req(app, "PUT", "/api/budget", {
      sessionUsd: 1.5,
      dailyUsd: 10,
      warnAt: 0.9,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });
    expect(store?.get()).toEqual({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });

    const cleared = await req(app, "PUT", "/api/budget", { sessionUsd: null, warnAt: 0.8 });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ warnAt: 0.8 });

    const entries = audit.list({ kind: "pengaturan", limit: 20 });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry: AuditEntry) => entry.summary)).toEqual([
      "Batas anggaran diubah",
      "Batas anggaran diubah",
    ]);
    expect(entries[1]?.meta).toEqual({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });
    expect(entries[0]?.meta).toEqual({ sessionUsd: null, dailyUsd: null, warnAt: 0.8 });
  });

  test("PUT tidak valid menjawab 400 tanpa menyimpan", async () => {
    const { app, store } = setup();
    for (const body of [
      { lain: 1 },
      { sessionUsd: -1 },
      { warnAt: 0.2 },
      "bukan json",
      "[1]",
      { sessionUsd: "1" },
    ]) {
      const res = await req(app, "PUT", "/api/budget", body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(typeof payload.error).toBe("string");
      expect(payload.error.length).toBeGreaterThan(0);
    }
    expect(store?.get()).toEqual({ warnAt: 0.8 });
  });

  test("status memuat todayUsd dan level", async () => {
    const ledger = new SqliteUsageLedger(":memory:");
    ledgers.push(ledger);
    const store = new FileBudgetStore(":memory:", {
      sessionUsd: 1,
      dailyUsd: 10,
      warnAt: 0.8,
    });
    ledger.record({
      ts: new Date().toISOString(),
      sessionId: "s_uji",
      profileId: "lokal",
      costUsd: 0.9,
    });
    const { app } = setup({ store, ledger });

    const res = await req(app, "GET", "/api/budget/status");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.config).toEqual({ sessionUsd: 1, dailyUsd: 10, warnAt: 0.8 });
    expect(payload.todayUsd).toBeCloseTo(0.9, 6);
    expect(payload.dayLevel).toBe("ok");
    expect("sessionUsd" in payload).toBe(false);

    const withSession = await req(app, "GET", "/api/budget/status?session=s_uji");
    const sessionPayload = (await withSession.json()) as Record<string, unknown>;
    expect(sessionPayload.sessionUsd).toBeCloseTo(0.9, 6);
    expect(sessionPayload.sessionLevel).toBe("warn");
  });

  test("tanpa store semua rute 503", async () => {
    const { app } = setup({ store: false });
    for (const [method, path] of [
      ["GET", "/api/budget"],
      ["PUT", "/api/budget"],
      ["GET", "/api/budget/status"],
    ] as const) {
      const res = await req(app, method, path, method === "PUT" ? {} : undefined);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Anggaran dimatikan." });
    }
  });
});
