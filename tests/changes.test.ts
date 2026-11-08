import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChanges, parseUnifiedDiff, type ChangedFile } from "../src/server/files/changes";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-changes-"));
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

async function initRepo(): Promise<void> {
  await git(dir, ["init", "-q", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "awal"]);
}

async function commitAll(message = "ubah"): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

function byPath(files: ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((file) => file.path === path);
}

describe("getChanges", () => {
  test("bukan repo git mengembalikan isRepo false", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    expect(await getChanges(dir)).toEqual({ isRepo: false, files: [], truncated: false });
  });

  test("repo tanpa commit membandingkan dengan tree kosong", async () => {
    await git(dir, ["init", "-q", "."]);
    await writeFile(join(dir, "a.txt"), "satu\n");
    await git(dir, ["add", "a.txt"]);

    const changes = await getChanges(dir);
    expect(changes.isRepo).toBe(true);
    const file = byPath(changes.files, "a.txt");
    expect(file?.status).toBe("A");
    expect(file?.additions).toBe(1);
    expect(file?.hunks[0]?.header).toBe("@@ -0,0 +1 @@");
    expect(file?.hunks[0]?.lines).toEqual([{ t: "add", text: "satu" }]);
  });

  test("modifikasi, tambah staged, hapus, dan rename terdeteksi", async () => {
    await initRepo();
    await writeFile(join(dir, "ubah.txt"), "satu\ndua\n");
    await writeFile(join(dir, "hapus.txt"), "hilang\n");
    await writeFile(join(dir, "pindah.txt"), "isi yang sama persis\n");
    await commitAll("isi");

    await writeFile(join(dir, "ubah.txt"), "satu\ndua\ntiga\n");
    await writeFile(join(dir, "baru.txt"), "isi baru\n");
    await git(dir, ["add", "baru.txt"]);
    await git(dir, ["rm", "-q", "hapus.txt"]);
    await git(dir, ["mv", "pindah.txt", "tujuan.txt"]);

    const changes = await getChanges(dir);
    expect(changes.isRepo).toBe(true);
    expect(changes.truncated).toBe(false);

    const modified = byPath(changes.files, "ubah.txt");
    expect(modified?.status).toBe("M");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(0);

    const added = byPath(changes.files, "baru.txt");
    expect(added?.status).toBe("A");
    expect(added?.additions).toBe(1);

    const deleted = byPath(changes.files, "hapus.txt");
    expect(deleted?.status).toBe("D");
    expect(deleted?.deletions).toBe(1);

    const renamed = byPath(changes.files, "tujuan.txt");
    expect(renamed?.status).toBe("R");
    expect(renamed?.oldPath).toBe("pindah.txt");
  });

  test("untracked teks jadi hunk add, untracked biner tanpa hunk", async () => {
    await initRepo();
    await writeFile(join(dir, "teks.txt"), "baris satu\nbaris dua\n");
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x00, 0x01, 0x02]));

    const changes = await getChanges(dir);
    const text = byPath(changes.files, "teks.txt");
    expect(text?.status).toBe("U");
    expect(text?.additions).toBe(2);
    expect(text?.binary).toBe(false);
    expect(text?.hunks).toHaveLength(1);
    expect(text?.hunks[0]?.lines.map((line) => line.text)).toEqual(["baris satu", "baris dua"]);

    const binary = byPath(changes.files, "biner.bin");
    expect(binary?.status).toBe("U");
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);
  });

  test("untracked > 256 KiB dan UTF-8 tidak valid dianggap biner", async () => {
    await initRepo();
    await writeFile(join(dir, "besar.txt"), "a".repeat(256 * 1024 + 10));
    await writeFile(join(dir, "rusak.bin"), Buffer.from([0x61, 0xff, 0x62]));

    const changes = await getChanges(dir);
    const besar = byPath(changes.files, "besar.txt");
    expect(besar?.status).toBe("U");
    expect(besar?.binary).toBe(true);
    expect(besar?.hunks).toEqual([]);

    const rusak = byPath(changes.files, "rusak.bin");
    expect(rusak?.binary).toBe(true);
    expect(rusak?.hunks).toEqual([]);
  });

  test("untracked raksasa dipotong 2000 baris", async () => {
    await initRepo();
    const lines = Array.from({ length: 2100 }, (_, index) => `baris ${index}`);
    await writeFile(join(dir, "panjang.txt"), `${lines.join("\n")}\n`);

    const changes = await getChanges(dir);
    expect(changes.truncated).toBe(true);
    const file = byPath(changes.files, "panjang.txt");
    expect(file?.hunks[0]?.lines).toHaveLength(2000);
    expect(file?.hunks[0]?.lines[1999]?.text).toBe("baris 1999");
  });

  test("beberapa hunk punya nomor baris yang benar", async () => {
    await initRepo();
    const lines = Array.from({ length: 30 }, (_, index) => `baris ${index + 1}`);
    await writeFile(join(dir, "multi.txt"), `${lines.join("\n")}\n`);
    await commitAll("isi");

    const changed = [...lines];
    changed[1] = "baris 2 diubah";
    changed[27] = "baris 28 diubah";
    await writeFile(join(dir, "multi.txt"), `${changed.join("\n")}\n`);

    const changes = await getChanges(dir);
    const file = byPath(changes.files, "multi.txt");
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5 });
    expect(file?.hunks[1]).toMatchObject({ oldStart: 25, oldLines: 6, newStart: 25, newLines: 6 });
    expect(file?.hunks[0]?.lines.filter((line) => line.t === "add")).toEqual([
      { t: "add", text: "baris 2 diubah" },
    ]);
    expect(file?.hunks[0]?.lines[1]).toEqual({ t: "del", text: "baris 2" });
  });

  test("berkas tanpa newline akhir tidak menyertakan penanda khusus", async () => {
    await initRepo();
    await writeFile(join(dir, "nonl.txt"), "a\nb");
    await commitAll("isi");
    await writeFile(join(dir, "nonl.txt"), "a\nc");

    const changes = await getChanges(dir);
    const file = byPath(changes.files, "nonl.txt");
    expect(file?.hunks[0]?.lines.map((line) => line.text)).toEqual(["a", "b", "c"]);
    expect(file?.hunks[0]?.lines.some((line) => line.text.includes("No newline"))).toBe(false);
  });

  test("id hunk mencakup penanda No newline pada blok mentah", () => {
    const base = [
      "diff --git a/nonl.txt b/nonl.txt",
      "index 1..2 100644",
      "--- a/nonl.txt",
      "+++ b/nonl.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+c",
    ];
    const withMarker = [...base, "\\ No newline at end of file", ""].join("\n");
    const withoutMarker = [...base, ""].join("\n");

    const marked = parseUnifiedDiff(withMarker).files[0]!;
    const plain = parseUnifiedDiff(withoutMarker).files[0]!;
    expect(marked.hunks[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(marked.hunks[0]?.id).not.toBe(plain.hunks[0]?.id);
  });

  test("nama berkas berspasi dan non-ASCII", async () => {
    await initRepo();
    await writeFile(join(dir, "spasi nama.txt"), "a\n");
    await writeFile(join(dir, "nonascii-ñ.txt"), "a\n");
    await commitAll("isi");

    await writeFile(join(dir, "spasi nama.txt"), "a\nb\n");
    await writeFile(join(dir, "nonascii-ñ.txt"), "a\nc\n");

    const changes = await getChanges(dir);
    expect(byPath(changes.files, "spasi nama.txt")?.status).toBe("M");
    expect(byPath(changes.files, "nonascii-ñ.txt")?.status).toBe("M");
  });

  test("batas 200 berkas", async () => {
    await initRepo();
    const names = Array.from({ length: 205 }, (_, index) => `f${String(index).padStart(3, "0")}.txt`);
    await Promise.all(names.map((name) => writeFile(join(dir, name), "awal\n")));
    await commitAll("isi");
    await Promise.all(names.map((name) => writeFile(join(dir, name), "awal\nubah\n")));

    const changes = await getChanges(dir);
    expect(changes.truncated).toBe(true);
    expect(changes.files).toHaveLength(200);
  });

  test("konfigurasi git berbahaya tidak dieksekusi", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "dua\n");

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

    const changes = await getChanges(dir);
    expect(changes.files.some((file) => file.path === "a.txt" && file.status === "M")).toBe(true);
    for (const marker of [...Object.values(markers), ...hookMarkers]) {
      expect(existsSync(marker)).toBe(false);
    }
  });

  test("timeout membunuh proses git", async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), "jejak-changes-fake-"));
    const fakeGit = join(fakeDir, "git");
    await writeFile(
      fakeGit,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"rev-parse --is-inside-work-tree"*) echo true; exit 0 ;;',
        '  *"rev-parse --verify HEAD"*) echo abc123; exit 0 ;;',
        "  *) /bin/sleep 30; exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(fakeGit, 0o755);

    const started = performance.now();
    const changes = await getChanges(dir, {
      // Skrip shell di folder temp baru bisa lambat saat pertama kali dijalankan
      // (evaluasi macOS), jadi beri ruang sebelum timeout benar-benar memicu bunuh.
      timeoutMs: 2000,
      env: { PATH: `${fakeDir}:${process.env.PATH ?? ""}` },
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(8000);
    expect(changes.isRepo).toBe(true);
    expect(changes.truncated).toBe(true);
    await rm(fakeDir, { recursive: true, force: true });
  }, 15_000);

  test("git tidak ada menghasilkan isRepo false", async () => {
    const empty = await mkdtemp(join(tmpdir(), "jejak-changes-nogit-"));
    const changes = await getChanges(dir, { env: { PATH: empty } });
    expect(changes).toEqual({ isRepo: false, files: [], truncated: false });
    await rm(empty, { recursive: true, force: true });
  });
});

describe("parseUnifiedDiff", () => {
  test("mendekode path ber-quote oktal dan menghitung baris", () => {
    const output = [
      'diff --git "a/nama\\303\\261.txt" "b/nama\\303\\261.txt"',
      "index 1..2 100644",
      '--- "a/nama\\303\\261.txt"',
      '+++ "b/nama\\303\\261.txt"',
      "@@ -1 +1,2 @@",
      " satu",
      "+dua",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(output);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe("namañ.txt");
    expect(parsed.files[0]?.status).toBe("M");
    expect(parsed.files[0]?.additions).toBe(1);
    expect(parsed.files[0]?.hunks[0]?.lines).toEqual([
      { t: "ctx", text: "satu" },
      { t: "add", text: "dua" },
    ]);
  });

  test("menandai biner", () => {
    const output = [
      "diff --git a/gambar.png b/gambar.png",
      "index 1..2 100644",
      "Binary files a/gambar.png and b/gambar.png differ",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(output);
    expect(parsed.files[0]?.binary).toBe(true);
    expect(parsed.files[0]?.hunks).toEqual([]);
  });

  test("diffId dan id hunk adalah sha256 hex 64 karakter yang stabil", () => {
    const output = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      " satu",
      "+dua",
      "",
    ].join("\n");

    const first = parseUnifiedDiff(output);
    const second = parseUnifiedDiff(output);
    const file = first.files[0]!;
    expect(file.diffId).toMatch(/^[0-9a-f]{64}$/);
    expect(file.hunks[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(second.files[0]?.diffId).toBe(file.diffId);
    expect(second.files[0]?.hunks[0]?.id).toBe(file.hunks[0]?.id);

    const changed = parseUnifiedDiff(
      output.replace("+dua", "+dua diubah"),
    );
    expect(changed.files[0]?.diffId).not.toBe(file.diffId);
    expect(changed.files[0]?.hunks[0]?.id).not.toBe(file.hunks[0]?.id);
  });
});

describe("berkas tak terlacak dengan karakter khusus", () => {
  test("nama berspasi dan non-ASCII lewat ls-files -z", async () => {
    await initRepo();
    await writeFile(join(dir, "baru nama.txt"), "isi\n");
    await writeFile(join(dir, "baru-ñ.txt"), "isi\n");

    const changes = await getChanges(dir);
    expect(byPath(changes.files, "baru nama.txt")?.status).toBe("U");
    expect(byPath(changes.files, "baru-ñ.txt")?.status).toBe("U");
  });

  test("isi berkas tak terlacak tersedia utuh", async () => {
    await initRepo();
    await writeFile(join(dir, "isi.txt"), "satu\ndua\n");
    const changes = await getChanges(dir);
    const file = byPath(changes.files, "isi.txt");
    expect(file?.hunks[0]?.newStart).toBe(1);
    expect(file?.hunks[0]?.newLines).toBe(2);
    expect(await readFile(join(dir, "isi.txt"), "utf8")).toBe("satu\ndua\n");
  });
});
