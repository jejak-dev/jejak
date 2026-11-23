import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { SqliteUsageLedger } from "../src/server/budget/usage-ledger";
import { WorktreeService } from "../src/server/git/worktree-service";
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

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal: ${err}`);
  return out;
}

/** Jadikan `project` repo git dengan satu commit. */
async function initRepo(): Promise<void> {
  await git(project, ["init", "-q", "-b", "main"]);
  await git(project, ["config", "user.name", "t"]);
  await git(project, ["config", "user.email", "t@t"]);
  await writeFile(join(project, "awal.txt"), "awal\n");
  await git(project, ["add", "-A"]);
  await git(project, ["commit", "-q", "-m", "awal"]);
}

function worktreeService(): WorktreeService {
  return new WorktreeService({ root: join(root, "worktrees") });
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

describe("spawnChild worktree auto", () => {
  test("non-git mode default ditolak dengan pesan repo git", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { worktrees: worktreeService() });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const galat = await galatDari(
      mgr.spawnChild(induk.id, { prompt: "tugas", worktree: "auto" }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
    expect((galat as SessionError).message).toBe(
      "Anak yang mengubah berkas butuh repo git (worktree); gunakan mode plan untuk anak baca-saja.",
    );
    expect(mgr.childrenOf(induk.id)).toEqual([]);

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("non-git mode plan lolos tanpa worktree", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { worktrees: worktreeService() });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const anak = await mgr.spawnChild(induk.id, {
      prompt: "tugas",
      worktree: "auto",
      permissionMode: "plan",
    });
    expect(anak.worktree).toBeUndefined();
    expect(anak.cwd).toBe(project);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("repo git bersih memakai worktree", async () => {
    await initRepo();
    const { runner } = holdingRunner();
    const mgr = manager(runner, { worktrees: worktreeService() });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const anak = await mgr.spawnChild(induk.id, {
      prompt: "tugas",
      title: "Fitur",
      worktree: "auto",
    });
    expect(anak.worktree).toBeDefined();
    expect(anak.worktree?.branch.startsWith("jejak/")).toBe(true);
    expect(anak.cwd).toBe(anak.worktree!.path);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("worktree mati diperlakukan seperti non-git", async () => {
    await initRepo();
    const { runner } = holdingRunner();
    // Tanpa layanan worktree, `"auto"` tak bisa memakai worktree.
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });

    const galat = await galatDari(
      mgr.spawnChild(induk.id, { prompt: "tugas", worktree: "auto" }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });
});

describe("childDetail dan childReport", () => {
  test("kepemilikan: id milik induk lain dijawab undefined", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const lain = await mgr.create({ prompt: "lain", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });

    expect(mgr.childDetail(lain.id, anak.id)).toBeUndefined();
    expect(mgr.childReport(lain.id, anak.id)).toBeUndefined();
    expect(mgr.childDetail(induk.id, anak.id)).toBeDefined();
    expect(mgr.childDetail(induk.id, "s_tidak_ada")).toBeUndefined();

    for (const id of [anak.id, induk.id, lain.id]) {
      mgr.interrupt(id);
      await tungguSelesai(mgr, id);
    }
  });

  test("ringkasan dari event teks giliran terakhir; status dipetakan", async () => {
    const mgr = manager(quickRunner());
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);
    await tungguSelesai(mgr, induk.id);

    const laporan = mgr.childReport(induk.id, anak.id);
    expect(laporan?.status).toBe("selesai");
    expect(laporan?.summary).toContain("selesai");
    expect(laporan?.branch).toBeUndefined();

    const detail = mgr.childDetail(induk.id, anak.id);
    expect(detail?.id).toBe(anak.id);
    expect(detail?.turns).toBe(1);
    expect(detail?.recentActions).toEqual([]);
  });

  test("status dibatalkan dipetakan ke dihentikan", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);

    expect(mgr.childReport(induk.id, anak.id)?.status).toBe("dihentikan");

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("recentActions memuat maks 5 aksi tool terakhir, disamarkan", async () => {
    const rahasia = "sk-abcdefgh1234";
    const runner: AgentRunner = {
      async *run() {
        yield { type: "session", sessionId: "sdk-0" };
        for (let index = 0; index < 7; index += 1) {
          yield {
            type: "tool_call",
            id: `t${index}`,
            name: index === 6 ? "Bash" : "Read",
            input: { file_path: `/tmp/berkas-${index}.ts`, token: rahasia },
          };
        }
        yield { type: "text", text: "selesai" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);
    await tungguSelesai(mgr, induk.id);

    const detail = mgr.childDetail(induk.id, anak.id);
    expect(detail?.recentActions).toHaveLength(5);
    expect(detail?.recentActions.at(-1)).toContain("Bash");
    for (const aksi of detail!.recentActions) {
      expect(aksi.length).toBeLessThanOrEqual(120);
      expect(aksi).not.toContain(rahasia);
    }
  });

  test("biaya dilaporkan bila ledger ada", async () => {
    const ledger = new SqliteUsageLedger(":memory:");
    const { runner } = holdingRunner();
    const mgr = manager(runner, {
      budget: { ledger, store: { get: () => ({ warnAt: 0.8 }), set: () => undefined } },
    });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    ledger.record({
      ts: new Date().toISOString(),
      sessionId: anak.id,
      profileId: "lokal",
      costUsd: 0.75,
    });

    expect(mgr.childReport(induk.id, anak.id)?.costUsd).toBe(0.75);
    expect(mgr.childDetail(induk.id, anak.id)?.costUsd).toBe(0.75);

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    ledger.close();
  });

  test("spawnChild paralel tidak melewati batas anak aktif (balapan pemeriksaan)", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner, { maxConcurrent: 8, team: { maxActiveChildren: 1 } });
    const induk = await mgr.create({ prompt: "induk", cwd: project });

    const hasil = await Promise.all([
      galatDari(mgr.spawnChild(induk.id, { prompt: "anak a" })),
      galatDari(mgr.spawnChild(induk.id, { prompt: "anak b" })),
      galatDari(mgr.spawnChild(induk.id, { prompt: "anak c" })),
    ]);
    const galat = hasil.filter((item) => item instanceof SessionError) as SessionError[];
    expect(mgr.childrenOf(induk.id).length).toBe(1);
    expect(galat.length).toBe(2);
    expect(galat.every((item) => item.code === "penuh")).toBe(true);

    // Penghitung sementara tidak bocor: setelah anak selesai slot bisa dipakai lagi.
    const anak = mgr.childrenOf(induk.id)[0]!;
    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    const lagi = await mgr.spawnChild(induk.id, { prompt: "anak d" });
    expect(lagi.team?.parentId).toBe(induk.id);

    for (const item of mgr.list()) mgr.interrupt(item.id);
  });

  test("balapan juga tertutup saat ada await probe worktree (worktree: auto)", async () => {
    const { runner } = holdingRunner();
    const lambat = {
      probe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return false;
      },
    } as unknown as SessionManagerOptions["worktrees"];
    const mgr = manager(runner, {
      maxConcurrent: 8,
      team: { maxActiveChildren: 1 },
      worktrees: lambat,
    });
    const induk = await mgr.create({ prompt: "induk", cwd: project });
    const hasil = await Promise.all(
      ["a", "b", "c"].map((nama) =>
        galatDari(
          mgr.spawnChild(induk.id, { prompt: `anak ${nama}`, worktree: "auto", permissionMode: "plan" }),
        ),
      ),
    );
    expect(mgr.childrenOf(induk.id).length).toBe(1);
    expect(hasil.filter((item) => item instanceof SessionError).length).toBe(2);
    for (const item of mgr.list()) mgr.interrupt(item.id);
  });
});
