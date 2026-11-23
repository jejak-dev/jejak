import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";
import { TEAM_BRIEF_MAX, TEAM_ROLE_MAX } from "../src/server/team/team";

const HOME = "/rumah/uji";

let root: string;
let project: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-tim-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = await realpath(project);
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(root, { recursive: true, force: true });
});

function waitAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Runner yang menahan setiap giliran sampai dibatalkan (sesi tetap berjalan). */
function holdingRunner(): { runner: AgentRunner; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input.prompt);
        yield { type: "session", sessionId: `sdk-${inputs.length}` };
        await waitAbort(input.signal);
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
      },
    },
  };
}

/** Runner yang langsung selesai. */
function quickRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-0" };
      yield { type: "text", text: "selesai" };
      yield { type: "result", ok: true };
    },
  };
}

function manager(
  runner: AgentRunner,
  extra: Partial<SessionManagerOptions> = {},
): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async (selection) => ({
      profileId: selection.profileId ?? "lokal",
      apiKey: "kunci",
      model: "model-uji",
      baseUrl: "https://api.provider.test/v1",
    }),
    home: HOME,
    ...extra,
  });
}

/** Tunggu sampai sesi tak berjalan. */
async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (info !== undefined && info.status !== "berjalan") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tak selesai");
}

async function galatDari(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("spawnChild", () => {
  test("membuat anak dengan team terisi, brief ter-redaksi, role dipangkas", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const rahasia = "pakai sk-abcdefgh1234 untuk tugas";
    const panjang = "x".repeat(TEAM_BRIEF_MAX + 50);
    const anak = await mgr.spawnChild(induk.id, {
      prompt: `${rahasia}\n${panjang}`,
      role: `  pelaksana-${"r".repeat(TEAM_ROLE_MAX)}  `,
    });

    const info = mgr.get(anak.id);
    expect(info?.team?.parentId).toBe(induk.id);
    expect(info?.team?.role).toHaveLength(TEAM_ROLE_MAX);
    expect(info?.team?.role?.startsWith("pelaksana-")).toBe(true);
    expect(info?.team?.spawnedAt).toBeString();
    expect(info?.team?.brief).not.toContain("sk-abcdefgh1234");
    expect(info?.team?.brief).toContain("[disembunyikan:kunci API]");
    expect(info?.team?.brief.length).toBeLessThanOrEqual(TEAM_BRIEF_MAX);
    expect(info?.permissionMode).toBe("default");
    expect(info?.cwd).toBe(project);

    expect(mgr.childrenOf(induk.id).map((item) => item.id)).toEqual([anak.id]);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("anak tanpa role tidak menyimpan field role", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas", role: "   " });
    expect(mgr.get(anak.id)?.team?.role).toBeUndefined();

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("mode lebih longgar ditolak sesuai mode induk", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const longgar = await galatDari(
      mgr.spawnChild(induk.id, { prompt: "tugas", permissionMode: "acceptEdits" }),
    );
    expect(longgar).toBeInstanceOf(SessionError);
    expect((longgar as SessionError).code).toBe("tidak-valid");

    const bypass = await mgr.create({
      prompt: "bypass",
      cwd: project,
      permissionMode: "bypassPermissions",
      confirmBypass: true,
    });
    const bypassAnak = await galatDari(
      mgr.spawnChild(bypass.id, { prompt: "tugas", permissionMode: "bypassPermissions" }),
    );
    expect(bypassAnak).toBeInstanceOf(SessionError);
    expect((bypassAnak as SessionError).code).toBe("tidak-valid");

    const edits = await mgr.create({
      prompt: "edits",
      cwd: project,
      permissionMode: "acceptEdits",
    });
    const plan = await mgr.spawnChild(edits.id, { prompt: "tugas", permissionMode: "plan" });
    expect(plan.permissionMode).toBe("plan");

    for (const id of [plan.id, edits.id, bypass.id, induk.id]) {
      mgr.interrupt(id);
      await tungguSelesai(mgr, id);
    }
  });

  test("anak tak boleh beranak", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });

    const galat = await galatDari(mgr.spawnChild(anak.id, { prompt: "cucu" }));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("batas anak aktif mengikuti maxConcurrent dan pulih setelah anak selesai", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { maxConcurrent: 4 });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const satu = await mgr.spawnChild(induk.id, { prompt: "satu" });
    const dua = await mgr.spawnChild(induk.id, { prompt: "dua" });
    const ketiga = await galatDari(mgr.spawnChild(induk.id, { prompt: "tiga" }));
    expect(ketiga).toBeInstanceOf(SessionError);
    expect((ketiga as SessionError).code).toBe("penuh");

    mgr.interrupt(satu.id);
    await tungguSelesai(mgr, satu.id);

    const lagi = await mgr.spawnChild(induk.id, { prompt: "lagi" });
    expect(mgr.childrenOf(induk.id).map((item) => item.id).sort()).toEqual(
      [satu.id, dua.id, lagi.id].sort(),
    );

    for (const id of [lagi.id, dua.id, induk.id]) {
      mgr.interrupt(id);
      await tungguSelesai(mgr, id);
    }
  });

  test("batas total anak lewat opsi team", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { team: { maxTotalChildren: 2 } });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const satu = await mgr.spawnChild(induk.id, { prompt: "satu" });
    const dua = await mgr.spawnChild(induk.id, { prompt: "dua" });
    mgr.interrupt(satu.id);
    await tungguSelesai(mgr, satu.id);

    const ketiga = await galatDari(mgr.spawnChild(induk.id, { prompt: "tiga" }));
    expect(ketiga).toBeInstanceOf(SessionError);
    expect((ketiga as SessionError).code).toBe("penuh");

    for (const id of [dua.id, induk.id]) {
      mgr.interrupt(id);
      await tungguSelesai(mgr, id);
    }
  });

  test("team dimatikan menolak semua spawn", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { team: { enabled: false } });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const galat = await galatDari(mgr.spawnChild(induk.id, { prompt: "tugas" }));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");
    expect(mgr.childrenOf(induk.id)).toEqual([]);

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("hapus induk melepas anak menjadi sesi biasa", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    mgr.delete(induk.id);

    const info = mgr.get(anak.id);
    expect(info).toBeDefined();
    expect(info?.team).toBeUndefined();
    expect(mgr.childrenOf(induk.id)).toEqual([]);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
  });

  test("team bertahan lintas restart dengan store yang sama", async () => {
    const path = join(root, "sessions.db");
    const first = new SqliteSessionStore(path);
    const { runner } = holdingRunner();
    const mgr = manager(runner, { store: first });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas", role: "peneliti" });
    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    first.close();

    const second = new SqliteSessionStore(path);
    const restored = manager(quickRunner(), { store: second });
    const info = restored.get(anak.id);
    expect(info?.team?.parentId).toBe(induk.id);
    expect(info?.team?.role).toBe("peneliti");
    expect(restored.childrenOf(induk.id).map((item) => item.id)).toEqual([anak.id]);
    second.close();
  });

  test("audit mencatat team-spawn dan team-lepas", async () => {
    const audit = new SqliteAuditStore(":memory:");
    audits.push(audit);
    const { runner } = holdingRunner();
    const mgr = manager(runner, { audit });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });

    const spawnEntries = audit.list({ session: induk.id, kind: "pengaturan", limit: 50 });
    expect(spawnEntries.some((entry) => entry.meta?.aksi === "team-spawn")).toBe(true);
    expect(
      spawnEntries.some(
        (entry) => entry.meta?.aksi === "team-spawn" && entry.meta?.anak === anak.id,
      ),
    ).toBe(true);

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    mgr.delete(induk.id);

    const lepasEntries = audit.list({ session: induk.id, kind: "pengaturan", limit: 50 });
    expect(
      lepasEntries.some(
        (entry) => entry.meta?.aksi === "team-lepas" && entry.meta?.anak === anak.id,
      ),
    ).toBe(true);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
  });
});
