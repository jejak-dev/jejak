import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";

const API_KEY = "sk-rahasia-123";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sesi-terputus-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function provider(selection: ProviderSelection): ResolvedProvider {
  return { profileId: selection.profileId ?? "lokal", apiKey: API_KEY, model: "model-uji" };
}

function manager(options: Partial<SessionManagerOptions> & { runner: AgentRunner }): SessionManager {
  return new SessionManager({
    resolveProvider: async (selection) => provider(selection),
    ...options,
  });
}

interface RecordedRun {
  prompt: string;
  resumeSessionId?: string;
}

/** Runner yang mencatat prompt lalu menandai giliran selesai. */
function recordingRunner(): { runner: AgentRunner; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  return {
    runs,
    runner: {
      async *run(input) {
        runs.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId });
        yield { type: "result", ok: true };
      },
    },
  };
}

/** Runner yang menunggu abort; dipakai untuk sesi yang sedang berjalan. */
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

interface SeedOptions {
  id: string;
  status: "berjalan" | "selesai" | "gagal";
  permissionMode?: "default" | "plan";
  sdkSessionId?: string;
  events: AgentEvent[];
}

/** Tulis sesi dan event-nya ke store, lalu tutup store. */
function seedStore(path: string, options: SeedOptions): void {
  const store = new SqliteSessionStore(path);
  const stamp = new Date().toISOString();
  store.saveSession(
    {
      id: options.id,
      title: "Sesi uji",
      prompt: "Halo dunia",
      cwd: dir,
      profileId: "lokal",
      permissionMode: options.permissionMode ?? "default",
      status: options.status,
      createdAt: stamp,
      updatedAt: stamp,
      eventCount: options.events.length,
      pendingPermissions: 0,
      queued: 0,
    },
    options.sdkSessionId,
  );
  options.events.forEach((event, index) => {
    store.appendEvent(options.id, { seq: index + 1, event });
  });
  store.close();
}

interface Restored {
  mgr: SessionManager;
  runs: RecordedRun[];
  store: SqliteSessionStore;
}

/** Muat ulang sesi dari store; pemulihan menutup izin yang menggantung. */
function restore(path: string, options: SeedOptions): Restored {
  seedStore(path, options);
  const store = new SqliteSessionStore(path);
  const recorded = recordingRunner();
  const mgr = manager({ runner: recorded.runner, store });
  return { mgr, runs: recorded.runs, store };
}

function permissionRequest(id: string, name: string, input: unknown = {}): AgentEvent {
  return { type: "permission_request", id, name, input };
}

async function eventsOf(mgr: SessionManager, id: string): Promise<AgentEvent[]> {
  return (await collect(mgr.events(id))).map((item) => item.event);
}

describe("pemulihan sesi terputus", () => {
  test("izin menggantung ditutup dengan pesan terputus dan idempoten", async () => {
    const path = join(dir, "s.db");
    const { mgr, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    const events = await eventsOf(mgr, "s1");
    const terputus = events.filter(
      (item): item is Extract<AgentEvent, { type: "permission_resolved" }> =>
        item.type === "permission_resolved" && item.id === "p1",
    );
    expect(terputus).toHaveLength(1);
    expect(terputus[0]?.decision).toBe("deny");
    expect(terputus[0]?.message).toBe("sesi terputus");
    store.close();

    // Muat ulang lagi: tak ada event ganda.
    const lagi = new SqliteSessionStore(path);
    const mgrLagi = manager({ runner: recordingRunner().runner, store: lagi });
    const eventsLagi = await eventsOf(mgrLagi, "s1");
    expect(
      eventsLagi.filter((item) => item.type === "permission_resolved" && item.id === "p1"),
    ).toHaveLength(1);
    lagi.close();
  });

  test("sesi lama berstatus gagal dengan izin menggantung juga ditutup", async () => {
    const path = join(dir, "s.db");
    const { mgr, store } = restore(path, {
      id: "s1",
      status: "gagal",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "AskUserQuestion", { questions: [] })],
    });

    const events = await eventsOf(mgr, "s1");
    const resolved = events.filter((item) => item.type === "permission_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.message).toBe("sesi terputus");
    expect(mgr.get("s1")?.status).toBe("gagal");
    store.close();
  });
});

describe("jalur yatim: keputusan izin yang sudah terputus", () => {
  test("rencana disetujui: mode jadi default, pesan lanjutan terkirim, izin jadi diizinkan", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      permissionMode: "plan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    await mgr.resolvePermission("s1", "p1", "allow");
    await mgr.done("s1");

    expect(mgr.get("s1")?.permissionMode).toBe("default");
    expect(runs[0]?.prompt).toBe(
      "Rencana yang kamu ajukan sudah disetujui. Lanjutkan implementasi sesuai rencana itu.",
    );
    expect(runs[0]?.resumeSessionId).toBe("sdk-1");

    const events = await eventsOf(mgr, "s1");
    const diizinkan = events.filter(
      (item): item is Extract<AgentEvent, { type: "permission_resolved" }> =>
        item.type === "permission_resolved" && item.id === "p1" && item.decision === "allow",
    );
    expect(diizinkan).toHaveLength(1);
    store.close();
  });

  test("rencana ditolak dengan catatan: pesan revisi terkirim, mode tetap plan", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      permissionMode: "plan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    await mgr.resolvePermission("s1", "p1", "deny", "kurang detail");
    await mgr.done("s1");

    expect(mgr.get("s1")?.permissionMode).toBe("plan");
    expect(runs[0]?.prompt).toBe(
      "Rencana perlu direvisi: kurang detail. Susun ulang rencananya sesuai catatan itu lalu ajukan lagi.",
    );
    store.close();
  });

  test("rencana ditolak tanpa catatan: pesan susun ulang", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      permissionMode: "plan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    await mgr.resolvePermission("s1", "p1", "deny");
    await mgr.done("s1");

    expect(runs[0]?.prompt).toBe("Rencana ditolak; susun ulang.");
    store.close();
  });

  test("pertanyaan dijawab: ringkasan jawaban terkirim", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [
        permissionRequest("p1", "AskUserQuestion", {
          questions: [{ question: "Warna apa?", header: "Warna" }],
        }),
      ],
    });

    await mgr.resolvePermission("s1", "p1", "allow", undefined, { "Warna apa?": "Biru" });
    await mgr.done("s1");

    expect(runs[0]?.prompt).toBe(
      "Jawaban untuk pertanyaanmu sebelum sesi terputus:\nWarna apa? → Biru",
    );
    const events = await eventsOf(mgr, "s1");
    const diizinkan = events.filter(
      (item): item is Extract<AgentEvent, { type: "permission_resolved" }> =>
        item.type === "permission_resolved" && item.id === "p1" && item.decision === "allow",
    );
    expect(diizinkan[0]?.answers).toEqual({ "Warna apa?": "Biru" });
    store.close();
  });

  test("pertanyaan dilewati: pesan lewati terkirim", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "AskUserQuestion", { questions: [] })],
    });

    await mgr.resolvePermission("s1", "p1", "deny");
    await mgr.done("s1");

    expect(runs[0]?.prompt).toBe("Pengguna melewati pertanyaan tadi.");
    store.close();
  });

  test("izin tool lain tak pernah disetujui otomatis", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "Bash", { command: "rm -rf /" })],
    });

    await expect(mgr.resolvePermission("s1", "p1", "allow")).rejects.toMatchObject({
      code: "konflik",
      message: "Sesi terputus; pilih Lanjutkan sesi agar agent mengulang pekerjaannya dan meminta izin lagi.",
    });
    await expect(mgr.resolvePermission("s1", "p1", "deny")).rejects.toMatchObject({
      code: "konflik",
    });
    expect(runs).toHaveLength(0);
    store.close();
  });

  test("izin yang sudah usang ditolak dengan konflik", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      permissionMode: "plan",
      sdkSessionId: "sdk-1",
      events: [
        permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" }),
        { type: "user_message", text: "lanjut saja" },
      ],
    });

    await expect(mgr.resolvePermission("s1", "p1", "allow")).rejects.toMatchObject({
      code: "konflik",
      message: "Izin ini sudah usang; sesi sudah berlanjut.",
    });
    expect(runs).toHaveLength(0);
    store.close();
  });

  test("izin yang tak ada sama sekali ditolak", async () => {
    const path = join(dir, "s.db");
    const { mgr, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    await expect(mgr.resolvePermission("s1", "p9", "allow")).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
    store.close();
  });

  test("sesi berjalan tak terpengaruh: jalur normal tetap berlaku", async () => {
    const path = join(dir, "s.db");
    seedStore(path, {
      id: "s1",
      status: "selesai",
      sdkSessionId: "sdk-1",
      events: [{ type: "result", ok: true }],
    });
    const store = new SqliteSessionStore(path);
    const recorded = recordingRunner();
    const mgr = manager({ runner: recorded.runner, store });

    // Sesi tak berjalan dan tanpa izin menggantung: error lama (404).
    await expect(mgr.resolvePermission("s1", "p1", "allow")).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
    expect(recorded.runs).toHaveLength(0);
    store.close();
  });
});

describe("lanjutkan sesi", () => {
  test("sesi terputus dilanjutkan dengan pesan lanjutan", async () => {
    const path = join(dir, "s.db");
    const { mgr, runs, store } = restore(path, {
      id: "s1",
      status: "berjalan",
      sdkSessionId: "sdk-1",
      events: [permissionRequest("p1", "ExitPlanMode", { plan: "# Rencana" })],
    });

    expect(await mgr.continue("s1")).toEqual({ queued: false });
    await mgr.done("s1");
    expect(runs[0]?.prompt).toBe(
      "Sesi sempat terputus karena aplikasi berhenti. Lanjutkan pekerjaan terakhirmu dari titik tadi dan minta izin lagi bila perlu.",
    );
    expect(mgr.get("s1")?.canContinue).toBe(true);
    store.close();
  });

  test("sesi berjalan ditolak", async () => {
    const mgr = manager({ runner: abortingRunner() });
    const info = await mgr.create({ prompt: "Halo dunia", cwd: dir });
    await expect(mgr.continue(info.id)).rejects.toMatchObject({ code: "konflik" });
    mgr.interrupt(info.id);
    await mgr.done(info.id);
  });

  test("sesi tanpa riwayat ditolak", async () => {
    const pathLain = join(dir, "s2.db");
    const kedua = restore(pathLain, {
      id: "s2",
      status: "gagal",
      events: [{ type: "result", ok: false, error: "gagal" }],
    });
    await expect(kedua.mgr.continue("s2")).rejects.toMatchObject({ code: "tidak-valid" });
    kedua.store.close();
  });

  test("sesi tak ditemukan ditolak", async () => {
    const path = join(dir, "s.db");
    const { mgr, store } = restore(path, {
      id: "s1",
      status: "gagal",
      sdkSessionId: "sdk-1",
      events: [{ type: "result", ok: false, error: "gagal" }],
    });

    await expect(mgr.continue("s_tak_ada")).rejects.toMatchObject({ code: "tidak-ditemukan" });
    store.close();
  });
});
