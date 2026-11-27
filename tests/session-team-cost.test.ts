import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { FileBudgetStore } from "../src/server/budget/budget-store";
import { SqliteUsageLedger, type UsageLedger } from "../src/server/budget/usage-ledger";
import type { GoalReport } from "../src/server/goals/goal";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";
import type { ResolvedProvider } from "../src/server/provider";
import {
  SessionError,
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let dir: string;
const ledgers: UsageLedger[] = [];
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-biaya-tim-"));
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

/** Runner dengan biaya per prompt dan opsi menahan prompt tertentu. */
function costRunner(options: {
  costFor?: (prompt: string) => number | undefined;
  hold?: (prompt: string) => boolean;
  onGoalStart?: () => void;
  goalGate?: { promise: Promise<void> };
}): AgentRunner {
  return {
    async *run(input) {
      yield { type: "session", sessionId: "sdk-uji" };
      if (input.prompt.includes("<tujuan>")) {
        options.onGoalStart?.();
        if (options.goalGate !== undefined) {
          await Promise.race([waitAbort(input.signal), options.goalGate.promise]);
        }
      }
      if (options.hold?.(input.prompt) === true) {
        await waitAbort(input.signal);
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
        return;
      }
      if (input.signal?.aborted === true) {
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
        return;
      }
      const cost = options.costFor?.(input.prompt);
      yield { type: "text", text: "selesai" };
      yield {
        type: "result",
        ok: true,
        ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
      };
    },
  };
}

/** Jembatan MCP palsu: tool `goal_update` diteruskan ke manajer sesi. */
function memoryBridgeFor(getManager: () => SessionManager): MemoryBridge {
  return {
    async open(input) {
      return {
        memory: {
          indexLine: "",
          tools: ["goal_update"],
          async call(name: string, args: unknown) {
            if (name !== "goal_update") {
              return { text: `Tool "${name}" tidak dikenal.`, isError: true };
            }
            const result = getManager().reportGoal(input.sessionId, args as GoalReport);
            return {
              text: result.ok ? "Status tujuan tercatat." : (result.error ?? "gagal"),
              isError: !result.ok,
            };
          },
        },
        close: () => {},
      };
    },
  };
}

function makeManager(
  runner: AgentRunner,
  options: Partial<SessionManagerOptions> = {},
  withBridge = false,
): SessionManager {
  let manager: SessionManager | undefined;
  const bridge = memoryBridgeFor(() => manager!);
  manager = new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...(withBridge ? { memoryBridge: bridge } : {}),
    team: { notifyWindowMs: 5 },
    ...options,
  });
  return manager;
}

function waitAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (info !== undefined && info.status !== "berjalan") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tak selesai");
}

async function tunggu(predicate: () => boolean, pesan = "kondisi tak tercapai"): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(pesan);
}

async function galatDari(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function collect(mgr: SessionManager, id: string): Promise<SequencedEvent[]> {
  const events: SequencedEvent[] = [];
  for await (const item of mgr.events(id)) events.push(item);
  return events;
}

function notices(events: SequencedEvent[]): Array<{ text: string }> {
  return events.flatMap((item) => (item.event.type === "notice" ? [item.event] : []));
}

function capAudits(audit: AuditStore): AuditEntry[] {
  return audit.list({ kind: "anggaran", limit: 200 }).filter((entry) => entry.meta.aksi === "team-plafon");
}

describe("biaya tim", () => {
  test("teamCostUsd menjumlahkan induk dan anak", async () => {
    const ledger = memoryLedger();
    const mgr = makeManager(
      costRunner({
        costFor: (prompt) => {
          if (prompt === "induk") return 0.1;
          if (prompt.startsWith("tugas-a")) return 0.2;
          if (prompt.startsWith("tugas-b")) return 0.3;
          return undefined;
        },
      }),
      { budget: { ledger, store: memoryBudget() } },
    );
    const induk = await mgr.create({ prompt: "induk", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    const anakA = await mgr.spawnChild(induk.id, { prompt: "tugas-a" });
    await tungguSelesai(mgr, anakA.id);
    const anakB = await mgr.spawnChild(induk.id, { prompt: "tugas-b" });
    await tungguSelesai(mgr, anakB.id);

    expect(mgr.sessionCostUsd(induk.id)).toBeCloseTo(0.6, 6);
    expect(mgr.sessionCostUsd(anakA.id)).toBeCloseTo(0.2, 6);
    expect(mgr.sessionCostUsd(anakB.id)).toBeCloseTo(0.3, 6);
  });

  test("Goal induk berhenti karena biaya anak melewati costCapUsd", async () => {
    const ledger = memoryLedger();
    const gate = makeGate();
    let goalStarted = false;
    const mgr = makeManager(
      costRunner({
        goalGate: gate,
        onGoalStart: () => {
          goalStarted = true;
        },
        costFor: (prompt) => (prompt.startsWith("tugas") ? 0.3 : undefined),
      }),
      { budget: { ledger, store: memoryBudget() } },
      true,
    );
    const induk = await mgr.create({ prompt: "Halo", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    mgr.startGoal(induk.id, { objective: "Mahal", costCapUsd: 0.2 });
    await tunggu(() => goalStarted, "giliran Goal tak dimulai");

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);
    gate.release();
    await tungguSelesai(mgr, induk.id);

    expect(mgr.getGoal(induk.id)?.status).toBe("paused");
    expect(mgr.getGoal(induk.id)?.endedReason).toBe("plafon-biaya");
  });

  test("anak tim tidak bisa menjalankan Goal sendiri", async () => {
    const mgr = makeManager(costRunner({}));
    const induk = await mgr.create({ prompt: "Halo", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);

    expect(() => mgr.startGoal(anak.id, { objective: "x" })).toThrow(
      "Anak tim tidak bisa menjalankan Goal sendiri.",
    );
  });

  test("anggaran sesi induk berubah tingkat saat biaya anak naik", async () => {
    const ledger = memoryLedger();
    const mgr = makeManager(
      costRunner({
        costFor: (prompt) => (prompt === "induk" ? 0.2 : prompt.startsWith("tugas") ? 0.7 : undefined),
      }),
      { budget: { ledger, store: memoryBudget(1) } },
    );
    const induk = await mgr.create({ prompt: "induk", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    expect(mgr.get(induk.id)?.budget?.session).toBe("ok");

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);

    expect(mgr.get(anak.id)?.budget?.session).toBe("ok");
    expect(mgr.get(induk.id)?.budget?.session).toBe("warn");
    const notes = notices(await collect(mgr, induk.id));
    expect(notes.some((note) => note.text.startsWith("Anggaran sesi 80% terpakai"))).toBe(true);
  });

  test("plafon biaya tim menolak spawn dan menghentikan anak sekali saja", async () => {
    const ledger = memoryLedger();
    const audit = memoryAudit();
    const mgr = makeManager(
      costRunner({
        hold: (prompt) => prompt.startsWith("tugas-a"),
        costFor: (prompt) => (prompt.startsWith("tugas-b") ? 0.4 : undefined),
      }),
      {
        budget: { ledger, store: memoryBudget() },
        audit,
        team: { notifyWindowMs: 5, costCapUsd: 0.3 },
      },
    );
    const induk = await mgr.create({ prompt: "Halo", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    const anakA = await mgr.spawnChild(induk.id, { prompt: "tugas-a" });
    const anakB = await mgr.spawnChild(induk.id, { prompt: "tugas-b" });
    await tungguSelesai(mgr, anakB.id);
    await tungguSelesai(mgr, anakA.id);

    expect(mgr.get(anakA.id)?.status).toBe("dibatalkan");
    expect(notices(await collect(mgr, induk.id)).map((note) => note.text)).toContain(
      "Plafon biaya tim tercapai; anak dihentikan.",
    );
    const entries = capAudits(audit);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.meta).toMatchObject({
      aksi: "team-plafon",
      induk: induk.id,
      plafon: 0.3,
    });

    const error = await galatDari(mgr.spawnChild(induk.id, { prompt: "tugas-c" }));
    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).code).toBe("penuh");
    expect((error as SessionError).message).toContain("Plafon biaya tim tercapai");

    // Guard sekali per induk: biaya yang sama tidak mengulang audit.
    expect(capAudits(audit)).toHaveLength(1);
  });

  test("tanpa plafon perilaku lama: spawn tetap boleh", async () => {
    const ledger = memoryLedger();
    const audit = memoryAudit();
    const mgr = makeManager(
      costRunner({
        hold: (prompt) => prompt.startsWith("tugas-a"),
        costFor: (prompt) => (prompt.startsWith("tugas-b") ? 0.4 : undefined),
      }),
      { budget: { ledger, store: memoryBudget() }, audit },
    );
    const induk = await mgr.create({ prompt: "Halo", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    const anakA = await mgr.spawnChild(induk.id, { prompt: "tugas-a" });
    const anakB = await mgr.spawnChild(induk.id, { prompt: "tugas-b" });
    await tungguSelesai(mgr, anakB.id);

    expect(mgr.get(anakA.id)?.status).toBe("berjalan");
    const anakC = await mgr.spawnChild(induk.id, { prompt: "tugas-c" });
    expect(mgr.get(anakC.id)).toBeDefined();
    expect(audit.list({ kind: "anggaran", limit: 200 }).filter((entry) => entry.meta.aksi === "team-plafon")).toHaveLength(0);

    mgr.interrupt(anakA.id);
    await tungguSelesai(mgr, anakA.id);
    await tungguSelesai(mgr, anakC.id);
  });

  test("plafon dibersihkan saat induk dihapus", async () => {
    const ledger = memoryLedger();
    const audit = memoryAudit();
    const mgr = makeManager(
      costRunner({
        hold: (prompt) => prompt.startsWith("tugas-a"),
        costFor: (prompt) => (prompt.startsWith("tugas-b") ? 0.4 : undefined),
      }),
      {
        budget: { ledger, store: memoryBudget() },
        audit,
        team: { notifyWindowMs: 5, costCapUsd: 0.3 },
      },
    );
    const induk = await mgr.create({ prompt: "Halo", cwd: dir });
    await tungguSelesai(mgr, induk.id);
    const anakA = await mgr.spawnChild(induk.id, { prompt: "tugas-a" });
    const anakB = await mgr.spawnChild(induk.id, { prompt: "tugas-b" });
    await tungguSelesai(mgr, anakB.id);
    await tungguSelesai(mgr, anakA.id);

    const capHit = (mgr as unknown as { teamCapHit: Set<string> }).teamCapHit;
    expect(capHit.has(induk.id)).toBe(true);
    mgr.delete(induk.id);
    expect(capHit.has(induk.id)).toBe(false);
  });
});
