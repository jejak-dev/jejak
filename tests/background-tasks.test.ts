import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldBackgroundTasks } from "../src/server/agent/background-tasks";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { mapSdkMessage } from "../src/server/agent/sdk-mapper";
import { SessionError, SessionManager } from "../src/server/sessions/session-manager";
import { backgroundKindLabel, backgroundStatusLabel, formatElapsed, groupBackgroundTasks } from "../src/client/lib/background-tasks";

const started = { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "npm run dev", task_type: "local_bash", is_backgrounded: true };

describe("mapper tugas latar", () => {
  test("task_started menjadi bg_task running", () => {
    expect(mapSdkMessage(started)).toEqual([
      {
        type: "bg_task",
        taskId: "t1",
        status: "running",
        at: expect.any(Number),
        toolUseId: "tu1",
        description: "npm run dev",
        kind: "local_bash",
        background: true,
      } as unknown as AgentEvent,
    ]);
  });

  test("task_notification memetakan status dan ringkasan; status asing diabaikan", () => {
    const [event] = mapSdkMessage({ type: "system", subtype: "task_notification", task_id: "t1", status: "failed", summary: "exit 1" });
    expect(event).toMatchObject({ type: "bg_task", taskId: "t1", status: "failed", summary: "exit 1" });
    expect(mapSdkMessage({ type: "system", subtype: "task_notification", task_id: "t1", status: "aneh" })).toEqual([]);
  });

  test("task_updated: killed menjadi stopped; patch kosong diabaikan", () => {
    const [event] = mapSdkMessage({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "killed" } });
    expect(event).toMatchObject({ status: "stopped" });
    expect(mapSdkMessage({ type: "system", subtype: "task_updated", task_id: "t1", patch: {} })).toEqual([]);
  });

  test("background_tasks_changed menjadi sync tanpa tugas ambient", () => {
    const [event] = mapSdkMessage({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "a" }, { task_id: "b", ambient: true }],
    });
    expect(event).toMatchObject({ type: "bg_tasks_sync", taskIds: ["a"] });
  });

  test("tugas ambient tak dipetakan", () => {
    expect(mapSdkMessage({ ...started, ambient: true })).toEqual([]);
  });
});

const ev = (e: unknown): AgentEvent => e as AgentEvent;

describe("foldBackgroundTasks", () => {
  test("mulai, selesai, dan tak dibuka kembali", () => {
    const tasks = foldBackgroundTasks([
      ev({ type: "bg_task", taskId: "t1", status: "running", at: 1000, description: "dev" }),
      ev({ type: "bg_task", taskId: "t1", status: "completed", at: 4000, summary: "ok" }),
      ev({ type: "bg_task", taskId: "t1", status: "running", at: 5000 }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "completed", startedAt: 1000, endedAt: 4000, summary: "ok" });
  });

  test("sync menghentikan yang tak ada di himpunan; result menghentikan sisanya", () => {
    const tasks = foldBackgroundTasks([
      ev({ type: "bg_task", taskId: "a", status: "running", at: 1, description: "a" }),
      ev({ type: "bg_task", taskId: "b", status: "running", at: 1, description: "b" }),
      ev({ type: "bg_tasks_sync", taskIds: ["b"], at: 2 }),
    ]);
    expect(tasks.map((t) => t.status)).toEqual(["stopped", "running"]);
    const after = foldBackgroundTasks([...[
      ev({ type: "bg_task", taskId: "b", status: "running", at: 1, description: "b" }),
    ], ev({ type: "result", ok: true })]);
    expect(after[0]).toMatchObject({ status: "stopped", endedByTurn: true });
    expect(backgroundStatusLabel(after[0]!)).toContain("giliran berakhir");
  });

  test("tugas latar depan tak masuk daftar, sampai dipindah ke latar", () => {
    const fg = ev({ type: "bg_task", taskId: "f", status: "running", at: 1, description: "f", background: false });
    expect(foldBackgroundTasks([fg])).toEqual([]);
    const moved = ev({ type: "bg_task", taskId: "f", status: "running", at: 2, background: true });
    expect(foldBackgroundTasks([fg, moved])).toHaveLength(1);
  });

  test("pengelompokan dan format lama berjalan", () => {
    const tasks = foldBackgroundTasks([
      ev({ type: "bg_task", taskId: "a", status: "failed", at: 1, description: "a" }),
      ev({ type: "bg_task", taskId: "b", status: "running", at: 1, description: "b" }),
      ev({ type: "bg_task", taskId: "c", status: "completed", at: 1, description: "c" }),
    ]);
    const g = groupBackgroundTasks(tasks);
    expect(g.running).toHaveLength(1);
    expect(g.finished.map((t) => t.taskId)).toEqual(["c", "a"]);
    expect(g.failed).toBe(1);
    expect(backgroundKindLabel("local_agent")).toBe("Subagent");
    expect(backgroundKindLabel("lainnya")).toBe("lainnya");
    expect(formatElapsed(5000)).toBe("5 dtk");
    expect(formatElapsed(185000)).toBe("3 mnt 5 dtk");
    expect(formatElapsed(3720000)).toBe("1 j 2 mnt");
  });
});

describe("SessionManager.stopBackgroundTask", () => {
  async function setup(): Promise<{ root: string; project: string }> {
    const root = await mkdtemp(join(tmpdir(), "jejak-bgtask-"));
    const project = join(root, "proyek");
    await mkdir(project, { recursive: true });
    return { root, project: await realpath(project) };
  }

  test("meneruskan ke penghenti giliran berjalan dan menolak setelah selesai", async () => {
    const { root, project } = await setup();
    const stopped: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner: AgentRunner = {
      async *run(input) {
        input.registerStopTask?.(async (id) => {
          stopped.push(id);
        });
        yield { type: "session", sessionId: "s0" };
        await gate;
        yield { type: "result", ok: true };
      },
    };
    const mgr = new SessionManager({
      runner,
      resolveProvider: async () => ({ profileId: "lokal", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" }),
      home: "/rumah/uji",
    });
    try {
      const info = await mgr.create({ prompt: "mulai", cwd: project });
      for (let i = 0; i < 100 && mgr.get(info.id)?.status !== "berjalan"; i += 1) {
        await new Promise((r) => setTimeout(r, 2));
      }
      await mgr.stopBackgroundTask(info.id, "t1");
      expect(stopped).toEqual(["t1"]);
      release();
      await mgr.done(info.id);
      let galat: unknown;
      try {
        await mgr.stopBackgroundTask(info.id, "t1");
      } catch (caught) {
        galat = caught;
      }
      expect(galat).toBeInstanceOf(SessionError);
      expect((galat as SessionError).code).toBe("konflik");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
