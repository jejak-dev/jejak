import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, gitStatus } from "../src/server/git/git-read";
import { gitCommit, gitStage, gitUnstage } from "../src/server/git/git-write";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-git-write-"));
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

async function initRepo(cwd = dir, commit = true): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main", "."]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "user.email", "t@t"]);
  if (commit) {
    await git(cwd, ["commit", "-q", "--allow-empty", "-m", "awal"]);
  }
}

async function commitAll(cwd: string, message = "ubah"): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
}

async function expectCode(promise: Promise<unknown>, code: GitError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe(code);
    return;
  }
  throw new Error(`seharusnya melempar GitError ${code}`);
}

async function porcelain(cwd = dir): Promise<string> {
  return git(cwd, ["status", "--porcelain=v1"]);
}

describe("gitStage", () => {
  test("satu dan banyak berkas termasuk spasi, unicode, dan awalan -", async () => {
    await initRepo();
    await writeFile(join(dir, "biasa.txt"), "a\n");
    await writeFile(join(dir, "nama dengan spasi.txt"), "b\n");
    await mkdir(join(dir, "ünïcode"), { recursive: true });
    await writeFile(join(dir, "ünïcode", "berkas.txt"), "c\n");
    await writeFile(join(dir, "-awalan.txt"), "d\n");

    await gitStage(dir, { paths: ["biasa.txt", "nama dengan spasi.txt", "ünïcode/berkas.txt", "-awalan.txt"] });

    const status = await gitStatus(dir);
    expect(status.staged.map((file) => file.path).sort()).toEqual(
      ["-awalan.txt", "biasa.txt", "nama dengan spasi.txt", "ünïcode/berkas.txt"].sort(),
    );
  });

  test("glob dianggap literal, bukan pathspec", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "a\n");
    await writeFile(join(dir, "b.ts"), "b\n");

    await expectCode(gitStage(dir, { paths: ["*.ts"] }), "gagal");
    expect((await porcelain()).trim()).toBe("?? a.ts\n?? b.ts".trim());
  });

  test("berkas yang dihapus bisa di-stage", async () => {
    await initRepo();
    await writeFile(join(dir, "hapus.txt"), "isi\n");
    await commitAll(dir);
    await rm(join(dir, "hapus.txt"));

    await gitStage(dir, { paths: ["hapus.txt"] });
    const status = await gitStatus(dir);
    expect(status.staged).toEqual([{ path: "hapus.txt", status: "dihapus" }]);
  });

  test("all men-stage semua perubahan", async () => {
    await initRepo();
    await writeFile(join(dir, "ubah.txt"), "satu\n");
    await writeFile(join(dir, "hapus.txt"), "isi\n");
    await commitAll(dir);
    await writeFile(join(dir, "ubah.txt"), "dua\n");
    await rm(join(dir, "hapus.txt"));
    await writeFile(join(dir, "baru.txt"), "baru\n");

    await gitStage(dir, { all: true });
    const status = await gitStatus(dir);
    expect(status.staged.map((file) => file.path).sort()).toEqual(["baru.txt", "hapus.txt", "ubah.txt"]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  test("path tidak valid ditolak", async () => {
    await initRepo();
    for (const paths of [
      [".."],
      ["../luar.txt"],
      ["/etc/passwd"],
      ["C:\\Windows\\x"],
      ["a\0b"],
      [""],
      [],
      Array.from({ length: 201 }, (_, index) => `f${index}.txt`),
    ]) {
      await expectCode(gitStage(dir, { paths }), "tidak-valid");
    }
    await expectCode(gitStage(dir, { paths: ["a.txt"], all: true }), "tidak-valid");
    await expectCode(gitStage(dir, {}), "tidak-valid");
  });
});

describe("gitUnstage", () => {
  test("path dan all mengembalikan ke belum ter-stage", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    await gitStage(dir, { paths: ["a.txt"] });

    await gitUnstage(dir, { paths: ["a.txt"] });
    expect((await gitStatus(dir)).staged).toEqual([]);
    expect((await gitStatus(dir)).untracked.sort()).toEqual(["a.txt", "b.txt"]);

    await gitStage(dir, { all: true });
    expect((await gitStatus(dir)).staged.length).toBe(2);
    await gitUnstage(dir, { all: true });
    expect((await gitStatus(dir)).staged).toEqual([]);
  });

  test("bekerja di repo tanpa commit pertama", async () => {
    await initRepo(dir, false);
    await writeFile(join(dir, "a.txt"), "a\n");
    await gitStage(dir, { paths: ["a.txt"] });
    expect((await gitStatus(dir)).staged.length).toBe(1);

    await gitUnstage(dir, { paths: ["a.txt"] });
    const status = await gitStatus(dir);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual(["a.txt"]);

    await gitStage(dir, { all: true });
    await gitUnstage(dir, { all: true });
    expect((await gitStatus(dir)).staged).toEqual([]);
  });
});

describe("gitCommit", () => {
  test("sukses mengembalikan hash, short, subjek dan membersihkan indeks", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await gitStage(dir, { paths: ["a.txt"] });

    const result = await gitCommit(dir, "  tambah a  ");
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.short).toBe(result.hash.slice(0, 7));
    expect(result.subject).toBe("tambah a");
    expect((await gitStatus(dir)).staged).toEqual([]);
    expect((await porcelain(dir)).trim()).toBe("");
    expect((await git(dir, ["log", "-1", "--format=%H"])).trim()).toBe(result.hash);
  });

  test("tanpa perubahan ter-stage -> konflik", async () => {
    await initRepo();
    await writeFile(join(dir, "belum.txt"), "x\n");
    await expectCode(gitCommit(dir, "pesan"), "konflik");
  });

  test("pesan kosong, terlalu panjang, bukan teks, atau NUL ditolak", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await gitStage(dir, { paths: ["a.txt"] });
    for (const message of ["", "   ", "x".repeat(2001), "baris\0baru"]) {
      await expectCode(gitCommit(dir, message), "tidak-valid");
    }
    await expectCode(gitCommit(dir, 42 as unknown as string), "tidak-valid");
    expect((await gitStatus(dir)).staged.length).toBe(1);
  });

  test("merge yang sedang berlangsung -> konflik", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await gitStage(dir, { paths: ["a.txt"] });
    await writeFile(join(dir, ".git", "MERGE_HEAD"), "0".repeat(40) + "\n");

    await expectCode(gitCommit(dir, "pesan"), "konflik");
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("awal");
  });

  test("hook pre-commit yang gagal membatalkan commit", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await gitStage(dir, { paths: ["a.txt"] });
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expectCode(gitCommit(dir, "gagal hook"), "gagal");
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("awal");
    expect((await gitStatus(dir)).staged.length).toBe(1);
  });

  test("hook pre-commit yang sukses terbukti berjalan", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await gitStage(dir, { paths: ["a.txt"] });
    const marker = join(dir, "marker-hook");
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
    await chmod(hook, 0o755);

    const result = await gitCommit(dir, "dengan hook");
    expect(existsSync(marker)).toBe(true);
    expect(result.subject).toBe("dengan hook");
  });

  test("pesan multi-baris dan karakter shell tersimpan utuh", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await gitStage(dir, { paths: ["a.txt"] });
    const message = "-awalan\nbaris $(echo rawan) `id` & ; |";

    const result = await gitCommit(dir, message);
    // `%s` menggabungkan paragraf pertama; isi penuh diperiksa lewat %B.
    expect(result.subject).toBe("-awalan baris $(echo rawan) `id` & ; |");
    expect((await git(dir, ["log", "-1", "--format=%B"])).trim()).toBe(
      "-awalan\nbaris $(echo rawan) `id` & ; |",
    );
  });

  test("identitas git tidak diatur -> pesan ramah", async () => {
    await git(dir, ["init", "-q", "-b", "main", "."]);
    // Tanpa identitas lokal dan tanpa auto-detection: git menolak commit.
    await git(dir, ["config", "user.useConfigOnly", "true"]);
    await writeFile(join(dir, "a.txt"), "x\n");
    // Stage tanpa menjalankan commit (stage tidak butuh identitas).
    await git(dir, ["add", "a.txt"]);

    const emptyHome = await mkdtemp(join(tmpdir(), "jejak-git-nohome-"));
    try {
      await expect(gitCommit(dir, "tanpa identitas", {
        env: { GIT_CONFIG_GLOBAL: "/dev/null", HOME: emptyHome, XDG_CONFIG_HOME: emptyHome },
      })).rejects.toMatchObject({
        message: "Identitas git (user.name dan user.email) belum diatur.",
      });
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  test("folder bukan repo -> tidak-valid", async () => {
    await writeFile(join(dir, "a.txt"), "x\n");
    await expect(gitCommit(dir, "pesan")).rejects.toMatchObject({
      code: "tidak-valid",
      message: "Folder ini bukan repo git.",
    });
  });

  test("dua mutasi bersamaan tidak saling merusak", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");

    await Promise.all([
      gitStage(dir, { paths: ["a.txt"] }),
      gitStage(dir, { paths: ["b.txt"] }),
    ]);

    const status = await gitStatus(dir);
    expect(status.staged.map((file) => file.path).sort()).toEqual(["a.txt", "b.txt"]);
    const result = await gitCommit(dir, "dua berkas");
    expect(result.subject).toBe("dua berkas");
    expect((await porcelain(dir)).trim()).toBe("");
  });
});
