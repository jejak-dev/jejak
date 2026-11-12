import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { FileBudgetStore } from "../src/server/budget/budget-store";
import { SqliteUsageLedger, type UsageLedger } from "../src/server/budget/usage-ledger";
import type { GoalReport } from "../src/server/goals/goal";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";
import type { ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore, type SessionStore } from "../src/server/sessions/session-store";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let dir: string;
const ledgers: UsageLedger[] = [];
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-goal-"));
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

interface TurnPlan {
  /** Jumlah tool call yang dikeluarkan pada giliran ini. */
  toolCalls?: number;
  /** Laporan status tujuan lewat tool `goal_update`. */
  report?: "progress" | "done" | "blocked";
  /** Ringkasan yang dilaporkan agent. */
  summary?: string;
  /** Hasil giliran gagal. */
  fail?: boolean;
  /** Biaya giliran (USD). */
  costUsd?: number;
  /** Tunggu sinyal sebelum mengakhiri giliran. */
  wait?: Promise<void>;
  /** Ajukan izin yang tidak dijawab. */
  askPermission?: boolean;
}

/** Runner palsu: giliran biasa mengikuti skrip awal, giliran Goal mengikuti skrip goal. */
function goalRunner(
  plans: TurnPlan[],
  prompts: string[] = [],
  initial: TurnPlan = {},
): AgentRunner {
  let index = 0;
  return {
    async *run(input) {
      prompts.push(input.prompt);
      const isGoal = input.prompt.includes("<tujuan>");
      const plan = isGoal ? (plans[Math.min(index, plans.length - 1)] ?? {}) : initial;
      if (isGoal) index += 1;

      yield { type: "session", sessionId: "sdk-uji" };

      if (plan.askPermission === true && input.requestPermission !== undefined) {
        // Izin yang tidak dijawab: sesi punya izin tertunda.
        void input.requestPermission(
          { name: "Write", input: { file_path: "a.txt", content: "x" } },
          input.signal ?? new AbortController().signal,
        );
        await aborted(input.signal);
      }
      if (plan.wait !== undefined) {
        await Promise.race([plan.wait, aborted(input.signal)]);
      }
      if (input.signal?.aborted === true) {
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
        return;
      }
      if (plan.fail === true) {
        yield { type: "error", message: "giliran gagal" };
        yield { type: "result", ok: false, error: "giliran gagal" };
        return;
      }

      for (let i = 0; i < (plan.toolCalls ?? 0); i += 1) {
        const id = `tool-${i}`;
        yield { type: "tool_call", id, name: "Read", input: { file_path: "a.txt" } };
        yield { type: "tool_result", id, output: "isi", isError: false };
      }
      if (plan.report !== undefined) {
        const id = "goal-report";
        const args = { status: plan.report, summary: plan.summary ?? "ringkasan uji" };
        yield {
          type: "tool_call",
          id,
          name: "mcp__jejak-memory__goal_update",
          input: args,
        };
        const memory = input.memory;
        let outcome = { text: "memory tidak tersedia", isError: true };
        if (memory !== undefined) {
          try {
            outcome = await memory.call("goal_update", args);
          } catch {
            outcome = { text: "laporan gagal", isError: true };
          }
        }
        yield { type: "tool_result", id, output: outcome.text, isError: outcome.isError };
      }
      yield { type: "text", text: "giliran selesai" };
      yield {
        type: "result",
        ok: true,
        ...(plan.costUsd === undefined ? {} : { estimatedCostUsd: plan.costUsd }),
      };
    },
  };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Jembatan MCP palsu: tool `goal_update` diteruskan ke manajer sesi. */
function memoryBridgeFor(getManager: () => SessionManager): MemoryBridge {
  return {
    async open(input) {
      const memory = {
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
      };
      return { memory, close: () => {} };
    },
  };
}

function makeManager(
  runner: AgentRunner,
  options: Partial<SessionManagerOptions> = {},
  withBridge = true,
): SessionManager {
  let manager: SessionManager | undefined;
  const bridge = memoryBridgeFor(() => manager!);
  manager = new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...(withBridge ? { memoryBridge: bridge } : {}),
    ...options,
  });
  return manager;
}

/** Sesi baru yang sudah selesai; goal butuh sesi yang tidak berjalan. */
async function newSession(mgr: SessionManager, overrides: Record<string, unknown> = {}) {
  const info = await mgr.create({ prompt: "Halo", cwd: dir, ...overrides });
  await mgr.done(info.id);
  return info.id;
}

async function waitIdle(mgr: SessionManager, id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await mgr.done(id);
    if (mgr.get(id)?.status !== "berjalan") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("sesi tidak berhenti");
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("kondisi tidak terpenuhi");
}

async function collect(mgr: SessionManager, id: string): Promise<SequencedEvent[]> {
  const events: SequencedEvent[] = [];
  for await (const item of mgr.events(id)) events.push(item);
  return events;
}

function goalPrompts(prompts: string[]): string[] {
  return prompts.filter((prompt) => prompt.includes("<tujuan>"));
}

describe("SessionManager mode Goal", () => {
  test("lanjut otomatis sampai agent melaporkan selesai", async () => {
    const prompts: string[] = [];
    const runner = goalRunner(
      [
        { report: "progress", summary: "masih jalan" },
        { report: "done", summary: "semua tes hijau" },
      ],
      prompts,
    );
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Buat tes auth hijau" });
    await waitIdle(mgr, id);

    const goal = mgr.getGoal(id);
    expect(goal?.status).toBe("achieved");
    expect(goal?.endedReason).toBe("selesai");
    expect(goal?.summary).toBe("semua tes hijau");
    expect(goal?.autoTurns).toBe(1);
    expect(goalPrompts(prompts)).toHaveLength(2);
    expect(goalPrompts(prompts)[1]).toContain("(giliran otomatis 1 dari 10)");

    const events = await collect(mgr, id);
    const otomatis = events.filter(
      (item) => item.event.type === "user_message" && item.event.auto === "goal",
    );
    expect(otomatis).toHaveLength(1);
  });

  test("laporan blocked menutup tujuan sebagai buntu", async () => {
    const runner = goalRunner([{ report: "blocked", summary: "butuh akses privat" }]);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Perbaiki modul x" });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("blocked");
    expect(mgr.getGoal(id)?.endedReason).toBe("buntu");
    expect(mgr.getGoal(id)?.summary).toBe("butuh akses privat");
  });

  test("berhenti di plafon giliran otomatis", async () => {
    const prompts: string[] = [];
    const runner = goalRunner([{ report: "progress" }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Rapikan repo", maxTurns: 2 });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("paused");
    expect(mgr.getGoal(id)?.endedReason).toBe("plafon-giliran");
    expect(mgr.getGoal(id)?.autoTurns).toBe(2);
    expect(goalPrompts(prompts)).toHaveLength(3);
  });

  test("berhenti di plafon biaya", async () => {
    const ledger = memoryLedger();
    const runner = goalRunner([{ report: "progress", costUsd: 0.6 }]);
    const mgr = makeManager(runner, {
      budget: { ledger, store: new FileBudgetStore(":memory:", { warnAt: 0.8 }) },
    });
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Mahal", costCapUsd: 0.5 });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("paused");
    expect(mgr.getGoal(id)?.endedReason).toBe("plafon-biaya");
  });

  test("berhenti saat anggaran sesi over", async () => {
    const ledger = memoryLedger();
    const runner = goalRunner([{ report: "progress", costUsd: 0.5 }]);
    const mgr = makeManager(runner, {
      budget: {
        ledger,
        store: new FileBudgetStore(":memory:", { sessionUsd: 0.1, warnAt: 0.8 }),
      },
    });
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Mahal" });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("paused");
    expect(mgr.getGoal(id)?.endedReason).toBe("anggaran-sesi");
  });

  test("berhenti tanpa kemajuan setelah dua giliran otomatis tanpa tool call", async () => {
    const prompts: string[] = [];
    const runner = goalRunner([{}], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Mandek" });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("paused");
    expect(mgr.getGoal(id)?.endedReason).toBe("tanpa-kemajuan");
    expect(goalPrompts(prompts)).toHaveLength(3);
  });

  test("antrean pengguna didahulukan dari kelanjutan otomatis", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner(
      [
        { wait: gate, report: "progress" },
        { report: "done", summary: "selesai setelah antrean" },
      ],
      prompts,
    );
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Kerjakan" });
    await waitFor(() => goalPrompts(prompts).length === 1);
    await mgr.send(id, "pesan antrean");
    release();
    await waitIdle(mgr, id);

    // Urutan: giliran goal pertama, pesan antrean, lalu kelanjutan otomatis.
    const antrean = prompts.indexOf("pesan antrean");
    expect(antrean).toBeGreaterThan(0);
    expect(goalPrompts(prompts)).toHaveLength(2);
    expect(antrean).toBeLessThan(prompts.indexOf(goalPrompts(prompts)[1]!));
    expect(mgr.getGoal(id)?.status).toBe("achieved");
  });

  test("jeda saat giliran berjalan: giliran dibiarkan selesai tanpa lanjutan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner([{ wait: gate, report: "progress" }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Kerjakan" });
    await waitFor(() => goalPrompts(prompts).length === 1);
    mgr.pauseGoal(id);
    expect(mgr.getGoal(id)?.status).toBe("paused");
    release();
    await waitIdle(mgr, id);

    expect(goalPrompts(prompts)).toHaveLength(1);
    expect(mgr.getGoal(id)?.status).toBe("paused");
  });

  test("lanjut dari jeda: penghitung direset dan satu giliran lanjutan dimulai", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner(
      [
        { wait: gate, report: "progress" },
        { report: "done", summary: "selesai" },
      ],
      prompts,
    );
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Kerjakan", maxTurns: 3 });
    await waitFor(() => goalPrompts(prompts).length === 1);
    mgr.pauseGoal(id);
    release();
    await waitIdle(mgr, id);

    mgr.resumeGoal(id);
    await waitIdle(mgr, id);

    expect(goalPrompts(prompts)).toHaveLength(2);
    expect(goalPrompts(prompts)[1]).toContain("(giliran otomatis 1 dari 3)");
    expect(mgr.getGoal(id)?.status).toBe("achieved");
  });

  test("hentikan tujuan: giliran dibatalkan dan status menjadi stopped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner([{ wait: gate, report: "progress" }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Kerjakan" });
    await waitFor(() => goalPrompts(prompts).length === 1);
    mgr.stopGoal(id);
    release();
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("stopped");
    expect(mgr.getGoal(id)?.endedReason).toBe("dihentikan");
    expect(goalPrompts(prompts)).toHaveLength(1);
  });

  test("restart server memulihkan tujuan aktif sebagai paused", async () => {
    const store: SessionStore = new SqliteSessionStore(join(dir, "sesi.db"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner([{ wait: gate, report: "progress" }], prompts);
    const mgr = makeManager(runner, { store });
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Kerjakan" });
    await waitFor(() => goalPrompts(prompts).length === 1);

    // Server restart: manajer baru membaca baris sesi yang sama.
    const managerBaru = makeManager(goalRunner([{}]), { store });
    const restored = managerBaru.getGoal(id);
    expect(restored?.status).toBe("paused");
    expect(restored?.endedReason).toBe("dihentikan");

    release();
    await waitIdle(mgr, id);
  });

  test("giliran gagal tidak melanjutkan tujuan", async () => {
    const prompts: string[] = [];
    const runner = goalRunner([{ fail: true }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "Gagal" });
    await waitIdle(mgr, id);

    expect(mgr.getGoal(id)?.status).toBe("stopped");
    expect(mgr.getGoal(id)?.endedReason).toBe("gagal");
    expect(goalPrompts(prompts)).toHaveLength(1);
  });

  test("tolak mulai di mode izin plan", async () => {
    const runner = goalRunner([{ report: "done" }]);
    const mgr = makeManager(runner);
    const id = await newSession(mgr, { permissionMode: "plan" });

    expect(() => mgr.startGoal(id, { objective: "x" })).toThrow(/plan/);
    expect(mgr.getGoal(id)).toBeNull();
  });

  test("tolak mulai saat sesi berjalan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = goalRunner([{ report: "done" }], [], { wait: gate });
    const mgr = makeManager(runner);
    const info = await mgr.create({ prompt: "Halo", cwd: dir });

    expect(() => mgr.startGoal(info.id, { objective: "x" })).toThrow(/berjalan/);
    release();
    await mgr.done(info.id);
  });

  test("tolak mulai saat ada izin tertunda", async () => {
    const runner = goalRunner([{ report: "done" }], [], { askPermission: true });
    const mgr = makeManager(runner);
    const info = await mgr.create({ prompt: "Halo", cwd: dir });
    await waitFor(() => (mgr.get(info.id)?.pendingPermissions ?? 0) > 0);

    expect(() => mgr.startGoal(info.id, { objective: "x" })).toThrow(/berjalan|izin/);
    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });

  test("tolak mulai saat sudah ada tujuan aktif", async () => {
    const runner = goalRunner([{ report: "progress" }]);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);
    mgr.startGoal(id, { objective: "x", maxTurns: 1 });

    expect(() => mgr.startGoal(id, { objective: "y" })).toThrow(/tujuan aktif/);
    await waitIdle(mgr, id);
  });

  test("tolak mulai saat jembatan MCP internal mati", async () => {
    const runner = goalRunner([{ report: "done" }]);
    const mgr = makeManager(runner, {}, false);
    const id = await newSession(mgr);

    expect(() => mgr.startGoal(id, { objective: "x" })).toThrow(/MCP internal aktif/);
    expect(mgr.getGoal(id)).toBeNull();
  });

  test("rewind ditolak selama tujuan aktif", async () => {
    const runner = goalRunner([{ report: "progress" }]);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);
    mgr.startGoal(id, { objective: "x", maxTurns: 1 });

    await expect(mgr.rewindConversation(id, 1)).rejects.toMatchObject({
      code: "konflik",
    });
    await waitIdle(mgr, id);
  });

  test("pesan otomatis tidak bisa dimundurkan", async () => {
    const prompts: string[] = [];
    const runner = goalRunner([{ report: "progress" }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);
    mgr.startGoal(id, { objective: "x", maxTurns: 1 });
    await waitIdle(mgr, id);

    // Tujuan sudah dijeda (plafon giliran), tapi pesan otomatisnya tetap
    // tidak boleh dimundurkan.
    const events = await collect(mgr, id);
    const otomatis = events.find(
      (item) => item.event.type === "user_message" && item.event.auto === "goal",
    );
    expect(otomatis).toBeDefined();
    await expect(mgr.rewindConversation(id, otomatis!.seq)).rejects.toMatchObject({
      code: "tidak-valid",
    });
  });

  test("objective dipotong 200 karakter di audit dan ringkasan agent tidak masuk audit", async () => {
    const audit = memoryAudit();
    const objective = "a".repeat(300);
    const runner = goalRunner([{ report: "done", summary: "ringkasan agent" }]);
    const mgr = makeManager(runner, { audit });
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective });
    await waitIdle(mgr, id);

    const entries = audit.list({ kind: "pengaturan", limit: 200 });
    const mulai = entries.find((entry) => entry.meta.aksi === "goal-mulai");
    expect(mulai).toBeDefined();
    expect(String(mulai?.meta.tujuan ?? "").length).toBe(200);
    const selesai = entries.find((entry) => entry.meta.aksi === "goal-selesai");
    expect(selesai?.meta.alasan).toBe("selesai");
    const semua = JSON.stringify(audit.list({ limit: 500 }));
    expect(semua).not.toContain("ringkasan agent");
  });

  test("audit mencatat aksi goal-mulai, goal-jeda, goal-lanjut, dan goal-henti", async () => {
    const audit = memoryAudit();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = goalRunner([{ wait: gate, report: "progress" }]);
    const mgr = makeManager(runner, { audit });
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "x" });
    await waitFor(() => goalPrompts.length >= 0 && (mgr.get(id)?.status ?? "") === "berjalan");
    mgr.pauseGoal(id);
    release();
    await waitIdle(mgr, id);
    mgr.resumeGoal(id);
    await waitIdle(mgr, id);
    mgr.stopGoal(id);

    const aksi = audit
      .list({ kind: "pengaturan", limit: 200 })
      .map((entry) => entry.meta.aksi);
    expect(aksi).toContain("goal-mulai");
    expect(aksi).toContain("goal-jeda");
    expect(aksi).toContain("goal-lanjut");
    expect(aksi).toContain("goal-henti");
  });

  test("ganti mode izin ke plan menjeda tujuan aktif", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const runner = goalRunner([{ wait: gate, report: "progress" }], prompts);
    const mgr = makeManager(runner);
    const id = await newSession(mgr);

    mgr.startGoal(id, { objective: "x" });
    await waitFor(() => goalPrompts(prompts).length === 1);
    mgr.setPermissionMode(id, "plan");
    expect(mgr.getGoal(id)?.status).toBe("paused");
    release();
    await waitIdle(mgr, id);
    expect(goalPrompts(prompts)).toHaveLength(1);
  });
});
