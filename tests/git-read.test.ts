import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  GitError,
  gitLog,
  gitShow,
  gitStatus,
  parseLog,
  parseStatusV2,
} from "../src/server/git/git-read";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-git-read-"));
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
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} gagal: ${await new Response(proc.stderr).text()}`);
  }
  return out;
}

async function initRepo(cwd = dir): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main", "."]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "awal"]);
}

async function commitAll(cwd: string, message = "ubah"): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const out = await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
  return out;
}

function n(...records: string[]): string {
  return `${records.join("\0")}\0`;
}

describe("parseStatusV2", () => {
  test("mengurai branch, ahead/behind, staged, unstaged, rename, dan untracked", () => {
    const text = n(
      "# branch.oid abcdef1234567890",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 M. N... 100644 100644 100644 aaa bbb ubah.txt",
      "1 .M N... 100644 100644 100644 aaa bbb kerja.txt",
      "1 A. N... 000000 100644 100644 aaa bbb baru.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 tujuan.txt",
      "asal.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc konflik.txt",
      "? tak-terlacak.txt",
      "? folder/",
    );
    const parsed = parseStatusV2(text);
    expect(parsed.branch).toBe("main");
    expect(parsed.detached).toBe(false);
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
    expect(parsed.head).toBe("abcdef1234567890");
    expect(parsed.staged).toEqual([
      { path: "ubah.txt", status: "diubah" },
      { path: "baru.txt", status: "ditambah" },
      { path: "tujuan.txt", status: "diganti", from: "asal.txt" },
    ]);
    expect(parsed.unstaged).toEqual([
      { path: "kerja.txt", status: "diubah" },
      { path: "konflik.txt", status: "konflik" },
    ]);
    expect(parsed.untracked).toEqual(["tak-terlacak.txt", "folder/"]);
    expect(parsed.truncated).toBe(false);
  });

  test("nama dengan spasi dan unicode, cabang detached, hapus dan tipe berubah", () => {
    const text = n(
      "# branch.oid abcdef1234567890",
      "# branch.head (detached)",
      "1 D. N... 100644 000000 000000 aaa 000 hapus.txt",
      "1 .T N... 100644 100644 100644 aaa bbb tipe.txt",
      "1 M. N... 100644 100644 100644 aaa bbb nama dengan spasi.txt",
      "? ünïcode/berkas.txt",
    );
    const parsed = parseStatusV2(text);
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.staged).toEqual([
      { path: "hapus.txt", status: "dihapus" },
      { path: "nama dengan spasi.txt", status: "diubah" },
    ]);
    expect(parsed.unstaged).toEqual([{ path: "tipe.txt", status: "tipe-berubah" }]);
    expect(parsed.untracked).toEqual(["ünïcode/berkas.txt"]);
  });

  test("repo tanpa commit: oid (initial) tidak dianggap head", () => {
    const parsed = parseStatusV2(n("# branch.oid (initial)", "# branch.head main", "? a.txt"));
    expect(parsed.head).toBeUndefined();
    expect(parsed.branch).toBe("main");
    expect(parsed.untracked).toEqual(["a.txt"]);
  });

  test("melewati batas 2000 entri menandai truncated", () => {
    const records: string[] = ["# branch.head main"];
    for (let index = 0; index < 2005; index += 1) records.push(`? berkas-${index}.txt`);
    const parsed = parseStatusV2(n(...records));
    expect(parsed.untracked.length).toBe(2000);
    expect(parsed.truncated).toBe(true);
  });
});

describe("parseLog", () => {
  test("memisah rekaman RS/US dan memotong subjek", () => {
    const long = "kata ".repeat(50).trim();
    const text = `aaa\x1faaaaaaa\x1f${long}\x1fPenulis\x1f2026-01-02T03:04:05+07:00\x1e\nbbb\x1fbbbbbbb\x1fsubjek\x1fLain\x1f2025-12-31T10:00:00Z\x1e\n`;
    const commits = parseLog(text);
    expect(commits.length).toBe(2);
    expect(commits[0]?.hash).toBe("aaa");
    expect(commits[0]?.subject.length).toBe(200);
    expect(commits[1]).toEqual({
      hash: "bbb",
      short: "bbbbbbb",
      subject: "subjek",
      author: "Lain",
      date: "2025-12-31T10:00:00Z",
    });
  });

  test("subjek yang tampak rahasia diganti", () => {
    const text = "aaa\x1faaaaaaa\x1fpakai bearer abcdefghijklmnop\x1fPenulis\x1f2026-01-01T00:00:00Z\x1e";
    expect(parseLog(text)[0]?.subject).toBe("[disembunyikan]");
  });
});

describe("gitStatus", () => {
  test("folder bukan repo", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    expect(await gitStatus(dir)).toEqual({
      isRepo: false,
      detached: false,
      state: "normal",
      staged: [],
      unstaged: [],
      untracked: [],
      truncated: false,
    });
  });

  test("repo tanpa commit tidak melempar", async () => {
    await git(dir, ["init", "-q", "-b", "main", "."]);
    await writeFile(join(dir, "a.txt"), "satu\n");
    const status = await gitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.head).toBeUndefined();
    expect(status.branch).toBe("main");
    expect(status.untracked).toEqual(["a.txt"]);
  });

  test("repo bersih, staged, unstaged, dan untracked", async () => {
    await initRepo();
    let status = await gitStatus(dir);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.detached).toBe(false);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);

    await writeFile(join(dir, "staged.txt"), "baru\n");
    await git(dir, ["add", "staged.txt"]);
    await writeFile(join(dir, "kerja.txt"), "ubah\n");
    await git(dir, ["add", "kerja.txt"]);
    await writeFile(join(dir, "kerja.txt"), "ubah lagi\n");
    await writeFile(join(dir, "baru-bebas.txt"), "x\n");

    status = await gitStatus(dir);
    expect(status.staged).toEqual([
      { path: "kerja.txt", status: "ditambah" },
      { path: "staged.txt", status: "ditambah" },
    ]);
    expect(status.unstaged).toEqual([{ path: "kerja.txt", status: "diubah" }]);
    expect(status.untracked).toEqual(["baru-bebas.txt"]);
  });

  test("rename terdeteksi dengan path asal", async () => {
    await initRepo();
    await writeFile(join(dir, "asal.txt"), "isi yang cukup panjang untuk rename\n");
    await commitAll(dir, "isi");
    await git(dir, ["mv", "asal.txt", "tujuan.txt"]);

    const status = await gitStatus(dir);
    expect(status.staged).toEqual([
      { path: "tujuan.txt", status: "diganti", from: "asal.txt" },
    ]);
  });

  test("state merge, cherry-pick, revert, dan bisect dari berkas direktori git", async () => {
    await initRepo();
    const gitDir = (await git(dir, ["rev-parse", "--git-dir"])).trim();
    const base = join(dir, gitDir);

    await writeFile(join(base, "MERGE_HEAD"), "0".repeat(40) + "\n");
    expect((await gitStatus(dir)).state).toBe("merge");
    await rm(join(base, "MERGE_HEAD"));

    await writeFile(join(base, "CHERRY_PICK_HEAD"), "0".repeat(40) + "\n");
    expect((await gitStatus(dir)).state).toBe("cherry-pick");
    await rm(join(base, "CHERRY_PICK_HEAD"));

    await writeFile(join(base, "REVERT_HEAD"), "0".repeat(40) + "\n");
    expect((await gitStatus(dir)).state).toBe("revert");
    await rm(join(base, "REVERT_HEAD"));

    await writeFile(join(base, "BISECT_LOG"), "git bisect start\n");
    expect((await gitStatus(dir)).state).toBe("bisect");
    await rm(join(base, "BISECT_LOG"));

    await mkdir(join(base, "rebase-merge"));
    expect((await gitStatus(dir)).state).toBe("rebase");
    await rm(join(base, "rebase-merge"), { recursive: true });

    expect((await gitStatus(dir)).state).toBe("normal");
  });

  test("worktree mendeteksi direktori git-nya sendiri dan cabangnya", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll(dir, "isi");
    const wt = join(dir, "..", `jejak-git-wt-${process.pid}-${Date.now()}`);
    try {
      await git(dir, ["worktree", "add", "-q", "-b", "cabang-wt", wt, "HEAD"]);
      const status = await gitStatus(wt);
      expect(status.isRepo).toBe(true);
      expect(status.branch).toBe("cabang-wt");
      expect(status.state).toBe("normal");

      const gitDir = (await git(wt, ["rev-parse", "--git-dir"])).trim();
      await writeFile(
        join(isAbsolute(gitDir) ? gitDir : join(wt, gitDir), "MERGE_HEAD"),
        "0".repeat(40) + "\n",
      );
      expect((await gitStatus(wt)).state).toBe("merge");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});

describe("gitLog", () => {
  test("urutan terbaru dulu, limit dipatuhi", async () => {
    await initRepo();
    for (const name of ["satu", "dua", "tiga"]) {
      await writeFile(join(dir, `${name}.txt`), `${name}\n`);
      await commitAll(dir, name);
    }

    const log = await gitLog(dir, { limit: 2 });
    expect(log.commits.length).toBe(2);
    expect(log.commits[0]?.subject).toBe("tiga");
    expect(log.commits[1]?.subject).toBe("dua");
    expect(log.commits[0]?.short.length).toBeGreaterThan(0);
    expect(log.commits[0]?.author).toBe("t");
    expect(log.commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect((await gitLog(dir, { limit: 30 })).commits.length).toBe(4);
  });

  test("repo tanpa commit mengembalikan daftar kosong", async () => {
    await git(dir, ["init", "-q", "-b", "main", "."]);
    expect(await gitLog(dir)).toEqual({ commits: [] });
  });

  test("bukan repo mengembalikan daftar kosong", async () => {
    expect(await gitLog(dir)).toEqual({ commits: [] });
  });
});

describe("gitShow", () => {
  test("hash valid menampilkan stat, hash buruk dan tak ada melempar", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll(dir, "tambah a");
    const hash = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const shown = await gitShow(dir, hash.slice(0, 12));
    expect(shown.text).toContain("tambah a");
    expect(shown.text).toContain("a.txt");
    expect(shown.truncated).toBe(false);

    for (const bad of ["", "xyz", "../HEAD", "A".repeat(7), hash.slice(0, 5)]) {
      try {
        await gitShow(dir, bad);
        throw new Error("seharusnya gagal");
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        expect((error as GitError).code).toBe("tidak-valid");
      }
    }

    await expect(gitShow(dir, "0".repeat(40))).rejects.toMatchObject({
      code: "tidak-ditemukan",
    });
  });

  test("keluaran dipotong pada 200 baris", async () => {
    await initRepo();
    for (let index = 0; index < 230; index += 1) {
      await writeFile(join(dir, `berkas-${String(index).padStart(3, "0")}.txt`), "x\n");
    }
    await commitAll(dir, "banyak berkas");
    const hash = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const shown = await gitShow(dir, hash);
    expect(shown.truncated).toBe(true);
    expect(shown.text.split("\n").length).toBeLessThanOrEqual(200);
  });
});
