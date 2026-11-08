import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChanges, type ChangedFile } from "../src/server/files/changes";
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOTS,
  RevertError,
  rejectChange,
  removeSessionUndo,
  undoChange,
} from "../src/server/files/revert";

let dir: string;
let undoDir: string;
let outside: string;
const SESSION = "s_test";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-revert-"));
  undoDir = await mkdtemp(join(tmpdir(), "jejak-undo-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-revert-outside-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(undoDir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
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

async function initRepo(): Promise<void> {
  await git(dir, ["init", "-q", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "awal"]);
}

async function commitAll(message = "ubah"): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

async function fileAt(path: string): Promise<ChangedFile | undefined> {
  const changes = await getChanges(dir);
  return changes.files.find((file) => file.path === path);
}

function options() {
  return { undoDir };
}

async function expectRevertError(promise: Promise<unknown>, status: number, message?: string) {
  try {
    await promise;
    throw new Error("seharusnya gagal");
  } catch (error) {
    expect(error).toBeInstanceOf(RevertError);
    const revert = error as RevertError;
    expect(revert.status).toBe(status);
    if (message !== undefined) expect(revert.message).toBe(message);
    expect(revert.message).not.toContain(dir);
  }
}

async function snapshotDirs(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(join(undoDir, SESSION));
  } catch {
    return [];
  }
}

describe("tolak hunk", () => {
  test("hunk tengah dibalik, dua lainnya utuh, index tidak berubah", async () => {
    await initRepo();
    const lines = Array.from({ length: 60 }, (_, index) => `baris ${index + 1}`);
    await writeFile(join(dir, "multi.txt"), `${lines.join("\n")}\n`);
    await commitAll("isi");

    const changed = [...lines];
    changed[5] = "baris 6 diubah";
    changed[25] = "baris 26 diubah";
    changed[45] = "baris 46 diubah";
    await writeFile(join(dir, "multi.txt"), `${changed.join("\n")}\n`);

    const before = await fileAt("multi.txt");
    expect(before?.status).toBe("M");
    expect(before?.hunks).toHaveLength(3);

    const middle = before!.hunks[1]!;
    const result = await rejectChange(
      SESSION,
      dir,
      { path: "multi.txt", scope: "hunk", hunkId: middle.id, diffId: before!.diffId },
      options(),
    );
    expect(result.path).toBe("multi.txt");
    expect(result.scope).toBe("hunk");
    expect(result.undoId).toMatch(/^[0-9a-f-]{36}$/);

    const restored = [...changed];
    restored[25] = "baris 26";
    expect(await readFile(join(dir, "multi.txt"), "utf8")).toBe(`${restored.join("\n")}\n`);

    const after = await fileAt("multi.txt");
    expect(after?.hunks).toHaveLength(2);
    expect(await git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await git(dir, ["diff", "--cached"])).toBe("");
  });

  test("hunk di akhir berkas tanpa newline akhir dipulihkan byte demi byte", async () => {
    await initRepo();
    await writeFile(join(dir, "nonl.txt"), "satu\ndua");
    await commitAll("isi");
    await writeFile(join(dir, "nonl.txt"), "satu\ndua\ntiga\n");

    const before = await fileAt("nonl.txt");
    expect(before?.status).toBe("M");
    expect(before?.hunks).toHaveLength(1);
    const hunk = before!.hunks[0]!;

    await rejectChange(
      SESSION,
      dir,
      { path: "nonl.txt", scope: "hunk", hunkId: hunk.id, diffId: before!.diffId },
      options(),
    );

    expect(await readFile(join(dir, "nonl.txt"), "utf8")).toBe("satu\ndua");
  });
});

describe("tolak berkas", () => {
  test("berkas M kembali sama dengan HEAD", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const before = await fileAt("a.txt");
    expect(before?.status).toBe("M");
    const result = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    expect(result.scope).toBe("file");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("awal\n");
    expect(await fileAt("a.txt")).toBeUndefined();
  });

  test("berkas D kembali dengan isi HEAD", async () => {
    await initRepo();
    await writeFile(join(dir, "hapus.txt"), "isi asli\n");
    await commitAll("isi");
    await rm(join(dir, "hapus.txt"));

    const before = await fileAt("hapus.txt");
    expect(before?.status).toBe("D");
    await rejectChange(
      SESSION,
      dir,
      { path: "hapus.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    expect(await readFile(join(dir, "hapus.txt"), "utf8")).toBe("isi asli\n");
  });
});

describe("diff basi dan jenis tidak didukung", () => {
  test("diffId basi menolak dengan 409 tanpa menulis", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "dua\n");

    const before = await fileAt("a.txt");
    await writeFile(join(dir, "a.txt"), "tiga\n");
    const bytes = await readFile(join(dir, "a.txt"));

    await expectRevertError(
      rejectChange(SESSION, dir, { path: "a.txt", scope: "file", diffId: before!.diffId }, options()),
      409,
      "Berkas berubah sejak diff ditampilkan. Muat ulang perubahan.",
    );
    expect(await readFile(join(dir, "a.txt"))).toEqual(bytes);
  });

  test("hunkId basi menolak dengan 409", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\ndua\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "satu\ndua2\n");

    const before = await fileAt("a.txt");
    await writeFile(join(dir, "a.txt"), "satu\ndua3\n");
    const bytes = await readFile(join(dir, "a.txt"));

    await expectRevertError(
      rejectChange(
        SESSION,
        dir,
        { path: "a.txt", scope: "hunk", hunkId: before!.hunks[0]!.id, diffId: before!.diffId },
        options(),
      ),
      409,
    );
    expect(await readFile(join(dir, "a.txt"))).toEqual(bytes);
  });

  test("status A, R, dan biner ditolak 400 tanpa perubahan", async () => {
    await initRepo();
    await writeFile(join(dir, "pindah.txt"), "isi\n");
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62, 0x63]));
    await commitAll("isi");

    await writeFile(join(dir, "baru.txt"), "baru\n");
    await git(dir, ["add", "baru.txt"]);
    await git(dir, ["mv", "pindah.txt", "tujuan.txt"]);
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62, 0x64, 0x65]));

    const added = await fileAt("baru.txt");
    expect(added?.status).toBe("A");
    await expectRevertError(
      rejectChange(SESSION, dir, { path: "baru.txt", scope: "file", diffId: added!.diffId }, options()),
      400,
      "Jenis perubahan ini belum bisa ditolak lewat Jejak.",
    );

    const renamed = await fileAt("tujuan.txt");
    expect(renamed?.status).toBe("R");
    await expectRevertError(
      rejectChange(SESSION, dir, { path: "tujuan.txt", scope: "file", diffId: renamed!.diffId }, options()),
      400,
    );

    const binary = await fileAt("biner.bin");
    expect(binary?.status).toBe("M");
    expect(binary?.binary).toBe(true);
    const bytes = await readFile(join(dir, "biner.bin"));
    await expectRevertError(
      rejectChange(SESSION, dir, { path: "biner.bin", scope: "file", diffId: binary!.diffId }, options()),
      400,
    );
    expect(existsSync(join(dir, "baru.txt"))).toBe(true);
    expect(existsSync(join(dir, "tujuan.txt"))).toBe(true);
    expect(await readFile(join(dir, "biner.bin"))).toEqual(bytes);
  });

  test("berkas tak terlacak (U) ditolak 400", async () => {
    await initRepo();
    await writeFile(join(dir, "baru.txt"), "isi baru\n");
    const untracked = await fileAt("baru.txt");
    expect(untracked?.status).toBe("U");
    await expectRevertError(
      rejectChange(SESSION, dir, { path: "baru.txt", scope: "file", diffId: untracked!.diffId }, options()),
      400,
    );
    expect(existsSync(join(dir, "baru.txt"))).toBe(true);
  });
});

describe("keamanan path", () => {
  test("path keluar cwd, absolut, NUL, .git, dan symlink ditolak 400", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");
    await writeFile(join(outside, "rahasia.txt"), "rahasia\n");
    await symlink(join(outside, "rahasia.txt"), join(dir, "keluar-link"));
    await symlink(join(dir, "a.txt"), join(dir, "dalam-link"));
    await mkdir(join(outside, "folder"));
    await symlink(join(outside, "folder"), join(dir, "keluar-dir"));

    const diff = await fileAt("a.txt");
    const diffs = diff!.diffId;
    const bads: Array<[string, string]> = [
      ["text", "../x"],
      ["text", "/etc/passwd"],
      ["text", "a\0b"],
      ["text", ".git/config"],
      ["text", ".."],
      ["text", "keluar-link"],
      ["text", "dalam-link"],
      ["text", "keluar-dir/baru.txt"],
    ];

    for (const [scope, path] of bads) {
      const input =
        scope === "file"
          ? { path, scope: "file" as const, diffId: diffs }
          : { path, scope: "hunk" as const, hunkId: diff!.hunks[0]!.id, diffId: diffs };
      await expectRevertError(rejectChange(SESSION, dir, input, options()), 400);
    }
    // Pesan galat tidak memuat path absolut.
    try {
      await rejectChange(SESSION, dir, { path: "../x", scope: "file", diffId: diffs }, options());
    } catch (error) {
      expect((error as RevertError).message).not.toContain("/tmp");
    }
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("berubah\n");
    expect(await readFile(join(outside, "rahasia.txt"), "utf8")).toBe("rahasia\n");
    expect(existsSync(join(outside, "folder", "baru.txt"))).toBe(false);
  });
});

describe("undo", () => {
  test("reject lalu undo memulihkan byte yang sama, undo kedua 404", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");
    const original = await readFile(join(dir, "a.txt"));

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("awal\n");

    const undo = await undoChange(SESSION, dir, reject.undoId, options());
    expect(undo.path).toBe("a.txt");
    expect(await readFile(join(dir, "a.txt"))).toEqual(original);

    await expectRevertError(undoChange(SESSION, dir, reject.undoId, options()), 404);
  });

  test("undo hunk memulihkan berkas dan menghapus snapshot", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\ndua\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "satu\ndua2\n");
    const original = await readFile(join(dir, "a.txt"));

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "hunk", hunkId: before!.hunks[0]!.id, diffId: before!.diffId },
      options(),
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("satu\ndua\n");

    await undoChange(SESSION, dir, reject.undoId, options());
    expect(await readFile(join(dir, "a.txt"))).toEqual(original);
    expect(existsSync(join(undoDir, SESSION, reject.undoId))).toBe(false);
  });

  test("undo setelah berkas diubah lagi ditolak 409 tanpa menimpa", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    await writeFile(join(dir, "a.txt"), "diubah lagi\n");
    const bytes = await readFile(join(dir, "a.txt"));

    await expectRevertError(
      undoChange(SESSION, dir, reject.undoId, options()),
      409,
      "Berkas berubah setelah ditolak; tidak bisa diurungkan otomatis.",
    );
    expect(await readFile(join(dir, "a.txt"))).toEqual(bytes);
  });

  test("undoId bukan UUID atau traversal ditolak 400", async () => {
    await initRepo();
    for (const undoId of ["../../x", "bukan-uuid", "", "00000000-0000-0000-0000-000000000000"]) {
      await expectRevertError(undoChange(SESSION, dir, undoId, options()), 400);
    }
  });

  test("undo milik sesi lain 404", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      "s_lain",
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    await expectRevertError(undoChange(SESSION, dir, reject.undoId, options()), 404);
  });

  test("mode berkas dipertahankan saat undo", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    await chmod(join(dir, "a.txt"), 0o755);

    await undoChange(SESSION, dir, reject.undoId, options());
    const mode = (await stat(join(dir, "a.txt"))).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

describe("snapshot", () => {
  test("izin direktori 0700 dan berkas 0600", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );

    const dirMode = (await stat(join(undoDir, SESSION))).mode & 0o777;
    const snapMode = (await stat(join(undoDir, SESSION, reject.undoId))).mode & 0o777;
    const metaMode = (await stat(join(undoDir, SESSION, reject.undoId, "meta.json"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(snapMode).toBe(0o700);
    expect(metaMode).toBe(0o600);
  });

  test("maksimal 20 snapshot per sesi, yang tertua dihapus", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");

    const ids: string[] = [];
    for (let index = 0; index < MAX_SNAPSHOTS + 3; index += 1) {
      await writeFile(join(dir, "a.txt"), `versi ${index}\n`);
      const before = await fileAt("a.txt");
      const reject = await rejectChange(
        SESSION,
        dir,
        { path: "a.txt", scope: "file", diffId: before!.diffId },
        options(),
      );
      ids.push(reject.undoId);
    }

    const remaining = await snapshotDirs();
    expect(remaining).toHaveLength(MAX_SNAPSHOTS);
    expect(remaining).not.toContain(ids[0]!);
    expect(remaining).toContain(ids[ids.length - 1]!);
  });

  test("berkas lebih dari 5 MiB ditolak 400", async () => {
    await initRepo();
    const line = `${"a".repeat(63)}\n`;
    const count = Math.ceil((MAX_SNAPSHOT_BYTES + 4096) / line.length);
    const lines = Array.from({ length: count }, (_, index) => (index === 10 ? "b".repeat(63) : "a".repeat(63)));
    await writeFile(join(dir, "besar.txt"), `${lines.join("\n")}\n`);
    await commitAll("isi");
    lines[40000] = "c".repeat(63);
    await writeFile(join(dir, "besar.txt"), `${lines.join("\n")}\n`);

    const before = await fileAt("besar.txt");
    expect(before?.status).toBe("M");
    await expectRevertError(
      rejectChange(SESSION, dir, { path: "besar.txt", scope: "file", diffId: before!.diffId }, options()),
      400,
      "Berkas terlalu besar untuk ditolak dengan aman.",
    );
  });

  test("konfigurasi git berbahaya tidak dieksekusi saat reject dan undo", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const repo = join(dir, ".git");
    const markers = {
      fsmonitor: join(dir, "marker-fsmonitor"),
      external: join(dir, "marker-external"),
      pager: join(dir, "marker-pager"),
    };
    const scripts = {
      fsmonitor: join(dir, "fsmon.sh"),
      external: join(dir, "extdiff.sh"),
      pager: join(dir, "pager.sh"),
    };
    await writeFile(scripts.fsmonitor, `#!/bin/sh\ntouch ${markers.fsmonitor}\necho 1\n`);
    await writeFile(scripts.external, `#!/bin/sh\ntouch ${markers.external}\nexit 0\n`);
    await writeFile(scripts.pager, `#!/bin/sh\ntouch ${markers.pager}\ncat\n`);
    for (const script of Object.values(scripts)) await chmod(script, 0o755);

    await git(dir, ["config", "core.fsmonitor", scripts.fsmonitor]);
    await git(dir, ["config", "diff.external", scripts.external]);
    await git(dir, ["config", "core.pager", scripts.pager]);

    const hookMarkers: string[] = [];
    for (const hook of ["post-index-change", "pre-commit", "post-commit", "reference-transaction"]) {
      const marker = join(dir, `marker-hook-${hook}`);
      hookMarkers.push(marker);
      const path = join(repo, "hooks", hook);
      await writeFile(path, `#!/bin/sh\ntouch ${marker}\n`);
      await chmod(path, 0o755);
    }

    const before = await fileAt("a.txt");
    const reject = await rejectChange(
      SESSION,
      dir,
      { path: "a.txt", scope: "file", diffId: before!.diffId },
      options(),
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("awal\n");
    await undoChange(SESSION, dir, reject.undoId, options());

    for (const marker of [...Object.values(markers), ...hookMarkers]) {
      expect(existsSync(marker)).toBe(false);
    }
  });
});

describe("diffId dan id hunk stabil", () => {
  test("dua panggilan berturut-turut identik, berubah bila konten hunk berubah", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\ndua\ntiga\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "satu\nDUA\ntiga\n");

    const first = await fileAt("a.txt");
    const second = await fileAt("a.txt");
    expect(second?.diffId).toBe(first!.diffId);
    expect(second?.hunks[0]?.id).toBe(first!.hunks[0]?.id);

    await writeFile(join(dir, "a.txt"), "satu\nDUA2\ntiga\n");
    const third = await fileAt("a.txt");
    expect(third?.diffId).not.toBe(first!.diffId);
    expect(third?.hunks[0]?.id).not.toBe(first!.hunks[0]?.id);
  });
});

describe("removeSessionUndo", () => {
  test("menghapus hanya <undoDir>/<id> termasuk repo-* dan tidak menyentuh sesi lain", async () => {
    const target = join(undoDir, SESSION);
    await mkdir(join(target, "repo-api"), { recursive: true });
    await mkdir(join(target, "repo-web"), { recursive: true });
    await writeFile(join(target, "meta.json"), "{}\n");
    await writeFile(join(target, "repo-api", "meta.json"), "{}\n");
    const other = join(undoDir, "s_lain");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "meta.json"), "{}\n");

    await removeSessionUndo(undoDir, SESSION);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(other, "meta.json"))).toBe(true);
    expect(existsSync(undoDir)).toBe(true);
  });

  test("menolak id berpola salah tanpa menyentuh isi undoDir", async () => {
    await mkdir(join(undoDir, SESSION), { recursive: true });
    await writeFile(join(undoDir, SESSION, "meta.json"), "{}\n");

    for (const id of ["..", "../..", "a/b", "a b", "", "s_1/../../x"]) {
      await expect(removeSessionUndo(undoDir, id)).rejects.toBeInstanceOf(RevertError);
    }
    expect(existsSync(join(undoDir, SESSION, "meta.json"))).toBe(true);
  });

  test("tidak gagal bila direktori sesi tidak ada", async () => {
    await expect(removeSessionUndo(undoDir, "s_tidakada")).resolves.toBeUndefined();
    expect(existsSync(undoDir)).toBe(true);
  });
});
