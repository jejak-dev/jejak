import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeError,
  WorktreeService,
  worktreeSlug,
} from "../src/server/git/worktree-service";

let dir: string;
let repo: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-worktree-"));
  repo = join(dir, "repo");
  root = join(dir, "worktrees");
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

async function initRepo(cwd = repo, commit = true): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-q", "-b", "main"]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "user.email", "t@t"]);
  if (commit) {
    await writeFile(join(cwd, "awal.txt"), "awal\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "awal"]);
  }
}

function service(): WorktreeService {
  return new WorktreeService({ root });
}

async function expectCode(promise: Promise<unknown>, code: WorktreeError["code"]): Promise<WorktreeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).code).toBe(code);
    return error as WorktreeError;
  }
  throw new Error(`seharusnya melempar WorktreeError ${code}`);
}

describe("worktreeSlug", () => {
  test("huruf kecil, aman, dan pendek", () => {
    expect(worktreeSlug("Perbaiki Bug Login")).toBe("perbaiki-bug-login");
    expect(worktreeSlug("Ünïcode 🚀 emoji")).toBe("n-code-emoji");
    expect(worktreeSlug("   ")).toBe("sesi");
    expect(worktreeSlug("🎉🎉")).toBe("sesi");
    expect(worktreeSlug("a".repeat(100)).length).toBeLessThanOrEqual(30);
    expect(worktreeSlug("a".repeat(100))).toBe("a".repeat(30));
  });
});

describe("WorktreeService.create", () => {
  test("membuat cabang, path, dan baseCommit", async () => {
    await initRepo();
    const svc = service();
    const result = await svc.create({ sessionId: "s_1234abcd", title: "Tambah Fitur", cwd: repo });

    expect(result.info.repoRoot).toBe(await git(repo, ["rev-parse", "--show-toplevel"]).then((v) => v.trim()));
    expect(result.info.path).toBe(join(root, "s_1234abcd"));
    expect(result.info.branch).toBe("jejak/tambah-fitur-s_1234abcd");
    expect(result.info.baseCommit).toBe((await git(repo, ["rev-parse", "HEAD"])).trim());
    expect(result.info.subdir).toBeUndefined();
    expect(result.dirtyInSource).toBe(false);

    expect((await stat(result.info.path)).isDirectory()).toBe(true);
    const branch = (await git(result.info.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    expect(branch).toBe(result.info.branch);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  test("subdir dari cwd di subfolder", async () => {
    await initRepo();
    const sub = join(repo, "paket", "inti");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "x.txt"), "x\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "sub"]);

    const svc = service();
    const result = await svc.create({ sessionId: "s_sub", title: "Sub", cwd: sub });
    expect(result.info.subdir).toBe("paket/inti");
    expect(result.info.repoRoot).toBe((await git(repo, ["rev-parse", "--show-toplevel"])).trim());
  });

  test("perubahan belum di-commit tidak ikut dan dilaporkan dirtyInSource", async () => {
    await initRepo();
    await writeFile(join(repo, "belum.txt"), "belum\n");

    const svc = service();
    const result = await svc.create({ sessionId: "s_dirty", title: "Dirty", cwd: repo });
    expect(result.dirtyInSource).toBe(true);
    expect(existsSync(join(result.info.path, "belum.txt"))).toBe(false);
  });

  test("sessionId buruk ditolak", async () => {
    await initRepo();
    const svc = service();
    await expectCode(svc.create({ sessionId: "../x", title: "x", cwd: repo }), "tidak-valid");
    await expectCode(svc.create({ sessionId: "a b", title: "x", cwd: repo }), "tidak-valid");
    await expectCode(svc.create({ sessionId: "", title: "x", cwd: repo }), "tidak-valid");
  });

  test("bukan repo dan repo tanpa commit ditolak", async () => {
    const biasa = join(dir, "biasa");
    await mkdir(biasa, { recursive: true });
    const svc = service();
    await expectCode(svc.create({ sessionId: "s_a", title: "x", cwd: biasa }), "tidak-valid");

    const kosong = join(dir, "kosong");
    await initRepo(kosong, false);
    await expectCode(svc.create({ sessionId: "s_b", title: "x", cwd: kosong }), "tidak-valid");
  });

  test("gagal worktree add karena cabang sudah ada membersihkan sisa", async () => {
    await initRepo();
    await git(repo, ["branch", "jejak/bentrok-s_c1"]);
    const svc = service();
    await expectCode(svc.create({ sessionId: "s_c1", title: "Bentrok", cwd: repo }), "gagal");

    expect(existsSync(join(root, "s_c1"))).toBe(false);
    const branches = (await git(repo, ["branch", "--list", "jejak/*"])).trim();
    expect(branches).toContain("jejak/bentrok-s_c1");
    const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).trim();
    expect(worktrees).not.toContain(join(root, "s_c1"));
  });

  test("folder sudah ada -> konflik tanpa menyentuh isinya", async () => {
    await initRepo();
    await mkdir(join(root, "s_c2"), { recursive: true });
    await writeFile(join(root, "s_c2", "penanda.txt"), "jangan disentuh\n");
    const svc = service();
    await expectCode(svc.create({ sessionId: "s_c2", title: "Path", cwd: repo }), "konflik");

    expect(existsSync(join(root, "s_c2", "penanda.txt"))).toBe(true);
    const branches = (await git(repo, ["branch", "--list", "jejak/path-s_c2"])).trim();
    expect(branches).toBe("");
    const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).trim();
    expect(worktrees).not.toContain(join(root, "s_c2"));
  });

  test("dua create paralel pada repo yang sama berhasil", async () => {
    await initRepo();
    const svc = service();
    const [a, b] = await Promise.all([
      svc.create({ sessionId: "s_p1", title: "Satu", cwd: repo }),
      svc.create({ sessionId: "s_p2", title: "Dua", cwd: repo }),
    ]);
    expect((await stat(a.info.path)).isDirectory()).toBe(true);
    expect((await stat(b.info.path)).isDirectory()).toBe(true);
    expect(a.info.branch).not.toBe(b.info.branch);
  });
});

describe("WorktreeService.inspect", () => {
  test("dirty, commitsAhead, dan folder hilang", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_i1", title: "Inspect", cwd: repo });

    expect(await svc.inspect(info)).toEqual({
      exists: true,
      dirtyFiles: 0,
      commitsAhead: 0,
      branchExists: true,
    });

    await writeFile(join(info.path, "baru.txt"), "baru\n");
    await git(info.path, ["add", "-A"]);
    await git(info.path, ["commit", "-q", "-m", "kerja"]);
    await writeFile(join(info.path, "kotor.txt"), "kotor\n");

    const inspected = await svc.inspect(info);
    expect(inspected.exists).toBe(true);
    expect(inspected.dirtyFiles).toBe(1);
    expect(inspected.commitsAhead).toBe(1);

    await rm(info.path, { recursive: true, force: true });
    const missing = await svc.inspect(info);
    expect(missing.exists).toBe(false);
    expect(missing.branchExists).toBe(true);
  });
});

describe("WorktreeService.remove", () => {
  test("ditolak saat dirty atau ahead, force jalan, cabang tetap ada", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_r1", title: "Hapus", cwd: repo });

    await writeFile(join(info.path, "kotor.txt"), "kotor\n");
    const dirty = await expectCode(svc.remove(info), "konflik");
    expect(dirty.dirtyFiles).toBe(1);
    expect(dirty.commitsAhead).toBe(0);
    expect(existsSync(info.path)).toBe(true);

    await rm(join(info.path, "kotor.txt"));
    await writeFile(join(info.path, "kerja.txt"), "kerja\n");
    await git(info.path, ["add", "-A"]);
    await git(info.path, ["commit", "-q", "-m", "kerja"]);

    const ahead = await expectCode(svc.remove(info), "konflik");
    expect(ahead.commitsAhead).toBe(1);
    expect(ahead.dirtyFiles).toBe(0);

    await svc.remove(info, { force: true });
    expect(existsSync(info.path)).toBe(false);
    const branches = (await git(repo, ["branch", "--list", "jejak/hapus-s_r1"])).trim();
    expect(branches).toContain("jejak/hapus-s_r1");
  });

  test("folder hilang cukup prune", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_r2", title: "Prune", cwd: repo });
    await rm(info.path, { recursive: true, force: true });

    await svc.remove(info);
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(info.path);
    expect((await git(repo, ["branch", "--list", info.branch])).trim()).toContain(info.branch);
  });

  test("path di luar root tidak pernah dihapus", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_r3", title: "Luar", cwd: repo });
    const luar = join(repo, "penting.txt");
    await writeFile(luar, "penting\n");

    await expectCode(
      svc.remove({ ...info, path: luar }, { force: true }),
      "tidak-valid",
    );
    expect(existsSync(luar)).toBe(true);

    await expectCode(
      svc.remove({ ...info, path: join(dir, "di-luar") }, { force: true }),
      "tidak-valid",
    );
  });
});

describe("WorktreeService.restore", () => {
  test("folder hilang dipulihkan dari cabang", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_x1", title: "Pulih", cwd: repo });
    await rm(info.path, { recursive: true, force: true });

    await svc.restore(info);
    expect((await stat(info.path)).isDirectory()).toBe(true);
    expect((await git(info.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(info.branch);
  });

  test("folder sudah ada -> no-op", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_x2", title: "Ada", cwd: repo });
    await writeFile(join(info.path, "tetap.txt"), "tetap\n");
    await svc.restore(info);
    expect(existsSync(join(info.path, "tetap.txt"))).toBe(true);
  });

  test("cabang hilang -> tidak-ditemukan", async () => {
    await initRepo();
    const svc = service();
    const { info } = await svc.create({ sessionId: "s_x3", title: "Hilang", cwd: repo });
    await rm(info.path, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
    await git(repo, ["branch", "-D", info.branch]);

    await expectCode(svc.restore(info), "tidak-ditemukan");
  });
});
