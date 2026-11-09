import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { FileBudgetStore } from "../src/server/budget/budget-store";
import { SqliteUsageLedger, type UsageLedger } from "../src/server/budget/usage-ledger";
import type { ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let dir: string;
const ledgers: UsageLedger[] = [];
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-budget-"));
});

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const audit of audits.splice(0)) audit.close();
  await rm(dir, { recursive: true, force: true });
});

function memoryLedger(): SqliteUsageLedger {
  const ledger = new SqliteUsageLedger(":memory:");
  ledgers.push(ledger);
  return ledger;
}

function memoryAudit(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function memoryBudget(sessionUsd?: number): FileBudgetStore {
  return new FileBudgetStore(
    ":memory:",
    sessionUsd === undefined ? { warnAt: 0.8 } : { sessionUsd, warnAt: 0.8 },
  );
}

function manager(
  runner: AgentRunner,
  options: Partial<SessionManagerOptions> = {},
): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...options,
  });
}

/** Runner yang mengeluarkan satu result berbiaya per giliran. */
function pricedRunner(costs: number[]): AgentRunner {
  let index = 0;
  return {
    async *run() {
      const cost = costs[index] ?? 0;
      index += 1;
      if (index === 1) yield { type: "session", sessionId: "sdk-uji" };
      yield {
        type: "result",
        ok: true,
        estimatedCostUsd: cost,
        inputTokens: 10,
        outputTokens: 5,
      };
    },
  };
}

/** Runner tanpa harga (model tanpa tarif). */
function unpricedRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-uji" };
      yield { type: "result", ok: true };
    },
  };
}

async function collect(mgr: SessionManager, id: string): Promise<SequencedEvent[]> {
  const events: SequencedEvent[] = [];
  for await (const item of mgr.events(id)) events.push(item);
  return events;
}

function notices(events: SequencedEvent[]): Array<Extract<AgentEvent, { type: "notice" }>> {
  return events.flatMap((item) => (item.event.type === "notice" ? [item.event] : []));
}

function budgetAudits(audit: AuditStore): AuditEntry[] {
  return audit.list({ kind: "anggaran", limit: 200 });
}

describe("SessionManager anggaran", () => {
  test("result bernilai mengisi ledger dan info.budget", async () => {
    const ledger = memoryLedger();
    const mgr = manager(pricedRunner([0.5]), {
      budget: { ledger, store: memoryBudget(1) },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(ledger.sumForSession(info.id)).toBeCloseTo(0.5, 6);
    expect(mgr.get(info.id)?.budget).toEqual({ session: "ok" });
    expect(notices(await collect(mgr, info.id))).toHaveLength(0);
  });

  test("kenaikan warn lalu over: satu notice dan satu audit per kenaikan", async () => {
    const ledger = memoryLedger();
    const audit = memoryAudit();
    const mgr = manager(pricedRunner([0.85, 0.85, 0.85]), {
      budget: { ledger, store: memoryBudget(1) },
      audit,
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);
    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);
    await mgr.send(info.id, "lagi");
    await mgr.done(info.id);

    const notes = notices(await collect(mgr, info.id));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({
      type: "notice",
      level: "warn",
      text: "Anggaran sesi 80% terpakai (US$0,85 dari US$1,00).",
    });
    expect(notes[1]?.text).toBe(
      "Anggaran sesi terlewati (US$1,70 dari US$1,00). Sesi tidak dihentikan.",
    );

    const entries = budgetAudits(audit);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.meta)).toEqual([
      { cakupan: "sesi", tingkat: "over", batas: 1 },
      { cakupan: "sesi", tingkat: "warn", batas: 1 },
    ]);
    expect(entries[1]?.summary).toBe("Anggaran sesi 80% terpakai");
    expect(entries[0]?.summary).toBe("Anggaran sesi terlewati. Sesi tidak dihentikan.");
    expect(mgr.get(info.id)?.budget).toEqual({ session: "over" });
  });

  test("tingkat sama tidak mengulang notice", async () => {
    const ledger = memoryLedger();
    const mgr = manager(pricedRunner([0.4, 0.4, 0]), {
      budget: { ledger, store: memoryBudget(1) },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);
    await mgr.send(info.id, "dua");
    await mgr.done(info.id);
    await mgr.send(info.id, "tiga");
    await mgr.done(info.id);

    expect(ledger.sumForSession(info.id)).toBeCloseTo(0.8, 6);
    expect(notices(await collect(mgr, info.id))).toHaveLength(1);
    expect(mgr.get(info.id)?.budget).toEqual({ session: "warn" });
  });

  test("batas harian memakai state per hari dan tidak menghentikan sesi", async () => {
    const ledger = memoryLedger();
    const audit = memoryAudit();
    const store = new FileBudgetStore(":memory:", { dailyUsd: 1, warnAt: 0.8 });
    const mgr = manager(pricedRunner([5, 0]), { budget: { ledger, store }, audit });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    const notes = notices(await collect(mgr, info.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text.startsWith("Anggaran hari terlewati")).toBe(true);

    const result = await mgr.send(info.id, "lanjut");
    expect(result.queued).toBe(false);
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
    // Satu giliran tanpa biaya tidak menurunkan/mengulang tingkat harian.
    expect(notices(await collect(mgr, info.id))).toHaveLength(1);
    expect(budgetAudits(audit)).toHaveLength(1);
  });

  test("tanpa harga tidak mencatat dan tidak ada budget", async () => {
    const ledger = memoryLedger();
    const mgr = manager(unpricedRunner(), {
      budget: { ledger, store: memoryBudget(1) },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(ledger.sumForSession(info.id)).toBe(0);
    expect(notices(await collect(mgr, info.id))).toHaveLength(0);
  });

  test("tanpa batas tidak ada info.budget", async () => {
    const ledger = memoryLedger();
    const mgr = manager(pricedRunner([0.5]), {
      budget: { ledger, store: memoryBudget() },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(ledger.sumForSession(info.id)).toBeCloseTo(0.5, 6);
    expect(mgr.get(info.id)?.budget).toBeUndefined();
  });

  test("galat ledger tidak menggagalkan sesi", async () => {
    const ledger: UsageLedger = {
      record() {
        throw new Error("ledger rusak");
      },
      sumSince() {
        throw new Error("ledger rusak");
      },
      sumForSession() {
        throw new Error("ledger rusak");
      },
      prune() {},
      close() {},
    };
    const mgr = manager(pricedRunner([0.5]), {
      budget: { ledger, store: memoryBudget(1) },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await mgr.done(info.id);

    expect(mgr.get(info.id)?.status).toBe("selesai");
    expect(mgr.get(info.id)?.budget).toBeUndefined();
  });
});
