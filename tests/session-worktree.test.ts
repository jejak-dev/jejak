import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { CheckpointService } from "../src/server/checkpoints/checkpoint-service";
import { WorktreeService } from "../src/server/git/worktree-service";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import { SessionError, SessionManager, type SessionManagerOptions } from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";

let dir: string;
let repo: string;
let home: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-worktree-"));
  repo = join(dir, "repo");
  home = join(dir, "home");
  root = join(home, "worktrees");
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

async function initRepo(): Promise<void> {
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await writeFile(join(repo, "awal.txt"), "awal\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "awal"]);
}

function provider(selection: ProviderSelection): ResolvedProvider {
  return { profileId: selection.profileId ?? "lokal", apiKey: "sk-uji", model: "model-uji" };
}

function captureRunner(events: AgentEvent[] = [{ type: "result", ok: true }]): {
  runner: AgentRunner;
  inputs: RunInput[];
} {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        for (const event of events) yield event;
      },
    },
  };
}

function makeManager(
  runner: AgentRunner,
  extra: Partial<SessionManagerOptions> = {},
): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async (selection) => provider(selection),
    ...extra,
  });
}

function worktrees(): WorktreeService {
  return new WorktreeService({ root });
}

describe("SessionManager + worktree", () => {
  test("create worktree mengisi cwd dan info.worktree; runner menerima cwd worktree", async () => {
    await initRepo();
    const capture = captureRunner();
    const mgr = makeManager(capture.runner, { worktrees: worktrees() });

    const info = await mgr.create({ prompt: "halo", cwd: repo, title: "Fitur Baru", worktree: true });
    await mgr.done(info.id);

    expect(info.worktree).toBeDefined();
    expect(info.worktree?.repoRoot).toBe((await git(repo, ["rev-parse", "--show-toplevel"])).trim());
    expect(info.worktree?.path).toBe(join(root, info.id));
    expect(info.worktree?.branch).toBe(`jejak/fitur-baru-${info.id}`);
    expect(info.worktree?.removed).toBeUndefined();
    expect(info.dirtyInSource).toBe(false);
    expect(info.cwd).toBe(info.worktree!.path);

    expect(capture.inputs[0]?.cwd).toBe(info.worktree!.path);
    expect((await git(info.cwd, ["rev-parse", "--show-toplevel"])).trim()).toBe(await realpath(info.worktree!.path));
  });

  test("cwd kerja memakai subdir saat cwd di subfolder repo", async () => {
    await initRepo();
    const sub = join(repo, "paket");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "a.txt"), "a\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "sub"]);

    const capture = captureRunner();
    const mgr = makeManager(capture.runner, { worktrees: worktrees() });
    const info = await mgr.create({ prompt: "halo", cwd: sub, title: "Sub", worktree: true });
    await mgr.done(info.id);

    expect(info.worktree?.subdir).toBe("paket");
    expect(info.cwd).toBe(join(info.worktree!.path, "paket"));
    expect(capture.inputs[0]?.cwd).toBe(info.cwd);
    expect(existsSync(join(info.cwd, "a.txt"))).toBe(true);
  });

  test("projectKey memory memakai repo asli, sama dengan sesi tanpa worktree", async () => {
    await initRepo();
    const cwds: string[] = [];
    const bridge = {
      async open(input: { sessionId: string; cwd: string }) {
        cwds.push(input.cwd);
        return {
          memory: { indexLine: "", tools: [], call: async () => ({ text: "", isError: false }) },
          close: () => {},
        };
      },
    };
    const plain = makeManager(captureRunner().runner, { memoryBridge: bridge });
    const withWorktree = makeManager(captureRunner().runner, {
      memoryBridge: bridge,
      worktrees: worktrees(),
    });

    const a = await plain.create({ prompt: "halo", cwd: repo });
    await plain.done(a.id);
    const b = await withWorktree.create({ prompt: "halo", cwd: repo, title: "Worktree", worktree: true });
    await withWorktree.done(b.id);

    expect(cwds).toHaveLength(2);
    const { projectKeyFor } = await import("../src/server/memory/memory-tools");
    // Sesi worktree mengirim repoRoot (realpath repo asli), bukan path worktree.
    expect(cwds[1]).toBe(b.worktree!.repoRoot);
    expect(cwds[1]).not.toBe(b.cwd);
    expect(await projectKeyFor(cwds[0]!)).toBe(await projectKeyFor(cwds[1]!));
  });

  test("projectKey dari subfolder sama antara sesi biasa dan sesi worktree", async () => {
    await initRepo();
    const sub = join(repo, "pkg");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "a.txt"), "a\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "sub"]);

    const cwds: string[] = [];
    const bridge = {
      async open(input: { sessionId: string; cwd: string }) {
        cwds.push(input.cwd);
        return {
          memory: { indexLine: "", tools: [], call: async () => ({ text: "", isError: false }) },
          close: () => {},
        };
      },
    };
    const plain = makeManager(captureRunner().runner, { memoryBridge: bridge });
    const withWorktree = makeManager(captureRunner().runner, {
      memoryBridge: bridge,
      worktrees: worktrees(),
    });

    const a = await plain.create({ prompt: "halo", cwd: sub });
    await plain.done(a.id);
    const b = await withWorktree.create({ prompt: "halo", cwd: sub, title: "Sub", worktree: true });
    await withWorktree.done(b.id);

    expect(cwds).toHaveLength(2);
    const { projectKeyFor } = await import("../src/server/memory/memory-tools");
    expect(cwds[0]).toBe(sub);
    expect(cwds[1]).toBe(join(b.worktree!.repoRoot, "pkg"));
    expect(await projectKeyFor(cwds[0]!)).toBe(await projectKeyFor(cwds[1]!));
  });

  test("checkpoint dibuat dan di-rewind di cwd worktree tanpa galat", async () => {
    await initRepo();
    const checkpointDir = join(home, "checkpoints");
    const checkpoints = new CheckpointService({ root: checkpointDir });
    const mgr = makeManager(captureRunner().runner, {
      worktrees: worktrees(),
      checkpoints,
    });

    const info = await mgr.create({ prompt: "halo", cwd: repo, title: "Checkpoint", worktree: true });
    await mgr.done(info.id);

    const points = await checkpoints.list(info.id, info.cwd);
    expect(points.enabled).toBe(true);
    expect(points.items.length).toBeGreaterThan(0);
    const point = points.items[0]!;
    const rewind = await checkpoints.rewind(info.id, info.cwd, point.id);
    expect(rewind.restored + rewind.recreated + rewind.removed).toBeGreaterThanOrEqual(0);
  });

  test("worktree + workspaceId ditolak; tanpa worktrees ditolak", async () => {
    await initRepo();
    const mgr = makeManager(captureRunner().runner, { worktrees: worktrees() });
    await expect(
      mgr.create({ prompt: "halo", cwd: repo, workspaceId: "ws-1", worktree: true }),
    ).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Worktree belum didukung untuk sesi workspace.",
    });

    const tanpa = makeManager(captureRunner().runner);
    await expect(tanpa.create({ prompt: "halo", cwd: repo, worktree: true })).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Worktree dimatikan.",
    });

    await expect(
      mgr.create({ prompt: "halo", cwd: repo, worktree: "ya" as unknown as boolean }),
    ).rejects.toMatchObject({ code: "tidak-valid" });
  });

  test("dirtyInSource dilaporkan saat repo asli kotor", async () => {
    await initRepo();
    await writeFile(join(repo, "kotor.txt"), "kotor\n");
    const mgr = makeManager(captureRunner().runner, { worktrees: worktrees() });
    const info = await mgr.create({ prompt: "halo", cwd: repo, worktree: true });
    await mgr.done(info.id);
    expect(info.dirtyInSource).toBe(true);
    expect(existsSync(join(info.cwd, "kotor.txt"))).toBe(false);
  });

  test("sesi dimuat ulang dari store mempertahankan worktree", async () => {
    await initRepo();
    const dbPath = join(home, "sessions.db");
    const first = new SqliteSessionStore(dbPath);
    const mgr = makeManager(captureRunner().runner, {
      worktrees: worktrees(),
      store: first,
    });
    const info = await mgr.create({ prompt: "halo", cwd: repo, title: "Simpan", worktree: true });
    await mgr.done(info.id);
    first.close();

    const second = new SqliteSessionStore(dbPath);
    const reloaded = makeManager(captureRunner().runner, {
      worktrees: worktrees(),
      store: second,
    });
    const restored = reloaded.get(info.id);
    expect(restored?.worktree).toEqual({ ...info.worktree!, missing: false });
    expect(restored?.cwd).toBe(info.cwd);
    second.close();
  });

  test("hapus sesi tidak menghapus worktree", async () => {
    await initRepo();
    const mgr = makeManager(captureRunner().runner, { worktrees: worktrees() });
    const info = await mgr.create({ prompt: "halo", cwd: repo, worktree: true });
    await mgr.done(info.id);

    mgr.delete(info.id);
    expect(existsSync(info.worktree!.path)).toBe(true);
    expect((await git(repo, ["branch", "--list", info.worktree!.branch])).trim()).toContain(
      info.worktree!.branch,
    );
  });

  test("pesan lanjutan ke sesi worktree yang dihapus atau folder hilang -> 409", async () => {
    await initRepo();
    const mgr = makeManager(captureRunner().runner, { worktrees: worktrees() });
    const a = await mgr.create({ prompt: "halo", cwd: repo, title: "A", worktree: true });
    await mgr.done(a.id);

    await mgr.removeWorktree(a.id);
    await expect(mgr.send(a.id, "lanjut")).rejects.toMatchObject({
      code: "konflik",
      message: "Worktree sesi sudah dihapus.",
    });

    const b = await mgr.create({ prompt: "halo", cwd: repo, title: "B", worktree: true });
    await mgr.done(b.id);
    await rm(b.worktree!.path, { recursive: true, force: true });
    await expect(mgr.send(b.id, "lanjut")).rejects.toMatchObject({
      code: "konflik",
      message: "Folder worktree hilang; pulihkan dulu.",
    });
    // Pembacaan tetap boleh.
    expect(mgr.get(b.id)?.worktree?.missing).toBe(true);
  });

  test("gagal membuat sesi sesudah worktree tidak meninggalkan sisa", async () => {
    await initRepo();
    const svc = worktrees();
    const mgr = makeManager(captureRunner().runner, { worktrees: svc });
    let madePath = "";
    const original = svc.create.bind(svc);
    svc.create = async (input) => {
      const result = await original(input);
      madePath = result.info.path;
      return result;
    };
    const originalRemove = svc.remove.bind(svc);
    svc.remove = async (info, options) => {
      await originalRemove(info, options);
    };

    // Kegagalan pada pemeriksaan kapasitas ketiga (setelah worktree dibuat).
    const instance = mgr as unknown as { ensureCapacity: () => void };
    const realEnsure = instance.ensureCapacity.bind(mgr);
    let calls = 0;
    instance.ensureCapacity = () => {
      calls += 1;
      if (calls >= 3) throw new SessionError("Kapasitas sesi penuh.", "penuh");
      realEnsure();
    };

    await expect(
      mgr.create({ prompt: "halo", cwd: repo, title: "Batal", worktree: true }),
    ).rejects.toMatchObject({ code: "penuh" });

    expect(madePath).not.toBe("");
    expect(existsSync(madePath)).toBe(false);
    // Cabang sengaja tidak dihapus oleh remove; yang penting tidak ada folder yatim.
    const listing = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(listing).not.toContain(madePath);
  });

});
