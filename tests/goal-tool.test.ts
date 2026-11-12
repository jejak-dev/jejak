import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRunner, type AgentEvent } from "../src/server/agent";
import { firstGoalPrompt } from "../src/server/goals/goal-prompts";
import type { GoalReport, GoalReportResult } from "../src/server/goals/goal";
import { MemoryService } from "../src/server/memory/memory-service";
import { createMemoryBridge } from "../src/server/memory/memory-bridge";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { MemoryTools } from "../src/server/memory/memory-tools";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-goal-tool-"));
  store = new FileMemoryStore({ dir });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: { sessionId?: string } = {}) {
  return { sessionId: overrides.sessionId ?? "s_uji", projectKey: dir, cwd: dir };
}

/** Manajer sesi dengan jembatan MCP palsu; dipakai untuk menguji batas. */
async function managerWithGoal(objective = "Rapikan repo"): Promise<{
  manager: SessionManager;
  id: string;
}> {
  let manager: SessionManager | undefined;
  const bridge = {
    async open(input: { sessionId: string }) {
      const memory = {
        indexLine: "",
        tools: ["goal_update"],
        async call(name: string, args: unknown) {
          if (name !== "goal_update") {
            return { text: "tidak dikenal", isError: true };
          }
          const result = manager!.reportGoal(input.sessionId, args as GoalReport);
          return {
            text: result.ok ? "Status tujuan tercatat." : (result.error ?? "gagal"),
            isError: !result.ok,
          };
        },
      };
      return { memory, close: () => {} };
    },
  };
  manager = new SessionManager({
    runner: {
      async *run(input) {
        yield { type: "session", sessionId: "sdk-uji" };
        if (!input.prompt.includes("<tujuan>")) {
          yield { type: "result", ok: true };
          return;
        }
        // Giliran tujuan dibiarkan berjalan agar tujuan tetap aktif saat diuji.
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
    resolveProvider: async () => PROVIDER,
    memoryBridge: bridge,
  });
  const info = await manager.create({ prompt: "Halo", cwd: dir });
  await manager.done(info.id);
  manager.startGoal(info.id, { objective });
  return { manager, id: info.id };
}

describe("tool goal_update", () => {
  test("ditolak jelas bila sesi tidak punya tujuan aktif", async () => {
    const tools = new MemoryTools(service, {
      goalReporter: (): GoalReportResult => ({
        ok: false,
        error: "Sesi ini tidak punya tujuan aktif.",
      }),
    });

    const result = await tools.call(ctx(), "goal_update", {
      status: "done",
      summary: "selesai",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tidak punya tujuan aktif");
  });

  test("ditolak tanpa pelapor goal di server", async () => {
    const tools = new MemoryTools(service);

    const result = await tools.call(ctx(), "goal_update", {
      status: "done",
      summary: "selesai",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tidak tersedia");
  });

  test("status dan summary divalidasi", async () => {
    const tools = new MemoryTools(service, {
      goalReporter: () => ({ ok: true }),
    });

    expect((await tools.call(ctx(), "goal_update", { status: "selesai", summary: "x" })).isError).toBe(
      true,
    );
    expect((await tools.call(ctx(), "goal_update", { status: "done" })).isError).toBe(true);
    expect((await tools.call(ctx(), "goal_update", { status: "done", summary: "  " })).isError).toBe(
      true,
    );
    expect(
      (await tools.call(ctx(), "goal_update", { status: "done", summary: "x".repeat(1001) })).isError,
    ).toBe(true);
  });

  test("tidak boleh mengubah batas giliran, biaya, atau mode izin", async () => {
    const tools = new MemoryTools(service, {
      goalReporter: () => ({ ok: true }),
    });

    for (const args of [
      { status: "done", summary: "x", maxTurns: 99 },
      { status: "done", summary: "x", costCapUsd: 1000 },
      { status: "done", summary: "x", permissionMode: "bypassPermissions" },
    ]) {
      const result = await tools.call(ctx(), "goal_update", args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("tidak dikenal");
    }
  });

  test("laporan valid dicatat pada goal aktif tanpa mengubah batas", async () => {
    const { manager, id } = await managerWithGoal();
    const tools = new MemoryTools(service, {
      goalReporter: (sessionId, report) => manager.reportGoal(sessionId, report),
    });

    const sebelum = manager.getGoal(id);
    const result = await tools.call(ctx({ sessionId: id }), "goal_update", {
      status: "progress",
      summary: "sedang berjalan",
    });
    expect(result.isError).toBe(false);

    const sesudah = manager.getGoal(id);
    expect(sesudah?.reportedStatus).toBe("progress");
    expect(sesudah?.summary).toBe("sedang berjalan");
    expect(sesudah?.maxTurns).toBe(sebelum?.maxTurns);
    expect(sesudah?.status).toBe("active");
  });

  test("tanpa tujuan aktif, pelapor menolak dan batas tidak berubah", async () => {
    const { manager } = await managerWithGoal();
    const tools = new MemoryTools(service, {
      goalReporter: (sessionId, report) => manager.reportGoal(sessionId, report),
    });

    const hasil = await tools.call(ctx({ sessionId: "s_tidak-ada" }), "goal_update", {
      status: "done",
      summary: "x",
    });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toContain("tidak ditemukan");
  });
});

describe("jembatan MCP dan tool goal_update", () => {
  test("tool goal_update hanya tampil saat sesi punya tujuan aktif", async () => {
    const { bridge } = createMemoryBridge({
      service,
      goalActive: (sessionId) => sessionId === "s_aktif",
    });

    const tanpa = await bridge.open({ sessionId: "s_biasa", cwd: dir });
    expect(tanpa.memory.tools).toEqual(["memory_search", "memory_propose"]);

    const dengan = await bridge.open({ sessionId: "s_aktif", cwd: dir });
    expect(dengan.memory.tools).toEqual([
      "memory_search",
      "memory_propose",
      "goal_update",
    ]);
  });

  test("pemanggilan goal_update tanpa tujuan aktif ditolak dengan jelas", async () => {
    const { bridge } = createMemoryBridge({
      service,
      goalActive: () => false,
      goalReporter: () => ({ ok: false, error: "Sesi ini tidak punya tujuan aktif." }),
    });

    const opened = await bridge.open({ sessionId: "s_biasa", cwd: dir });
    const hasil = await opened.memory.call("goal_update", {
      status: "done",
      summary: "x",
    });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toContain("tidak punya tujuan aktif");
  });
});

describe("mock runner penanda goal", () => {
  test("memanggil goal_update saat prompt memuat blok tujuan dan penanda", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const memory = {
      indexLine: "",
      tools: ["goal_update"],
      async call(name: string, args: unknown) {
        calls.push({ name, args });
        return { text: "Status tujuan tercatat.", isError: false };
      },
    };

    const runner = createMockRunner();
    const events: AgentEvent[] = [];
    for await (const event of runner.run({
      prompt: firstGoalPrompt("[goal:done] rapikan repo", 10),
      cwd: dir,
      provider: PROVIDER,
      memory,
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("goal_update");
    expect((calls[0]?.args as { status: string }).status).toBe("done");
    const toolCall = events.find((event) => event.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  test("penanda blocked menghasilkan status blocked", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const memory = {
      indexLine: "",
      tools: ["goal_update"],
      async call(name: string, args: unknown) {
        calls.push({ name, args });
        return { text: "ok", isError: false };
      },
    };

    const runner = createMockRunner();
    for await (const event of runner.run({
      prompt: firstGoalPrompt("[goal:blocked] buntu di sini", 10),
      cwd: dir,
      provider: PROVIDER,
      memory,
    })) {
      void event;
    }

    expect((calls[0]?.args as { status: string }).status).toBe("blocked");
  });

  test("prompt tanpa blok tujuan tidak memanggil goal_update", async () => {
    const calls: string[] = [];
    const memory = {
      indexLine: "",
      tools: ["goal_update"],
      async call(name: string) {
        calls.push(name);
        return { text: "ok", isError: false };
      },
    };

    const runner = createMockRunner();
    for await (const event of runner.run({
      prompt: "Halo biasa",
      cwd: dir,
      provider: PROVIDER,
      memory,
    })) {
      void event;
    }

    expect(calls).toHaveLength(0);
  });
});
