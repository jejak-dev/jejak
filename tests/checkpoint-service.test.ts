import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckpointError,
  CheckpointService,
  listSessionDirs,
} from "../src/server/checkpoints/checkpoint-service";

const SESSION = "s_abcdef12";

let root: string;
let work: string;
let outside: string;
let service: CheckpointService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-checkpoint-root-"));
  work = await mkdtemp(join(tmpdir(), "jejak-checkpoint-work-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-checkpoint-outside-"));
  service = new CheckpointService({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const path = join(work, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

async function read(rel: string): Promise<string> {
  return readFile(join(work, rel), "utf8");
}

function make(path = work): CheckpointService {
  return new CheckpointService({ root, maxFileBytes: 1024, maxFiles: 100, maxTotalBytes: 1024 * 1024 });
}

async function createTurn(turn = 1) {
  const result = await make().create(SESSION, work, { kind: "turn", turn });
  if (!result.enabled) throw new Error(result.reason);
  return result.item;
}

test("titik turn dan manual tercatat, terbaru dulu", async () => {
  await write("a.txt", "satu\n");
  const turn = await createTurn(1);
  await write("a.txt", "dua\n");
  const manual = await make().create(SESSION, work, { kind: "manual", label: "Sebelum ubah" });

  expect(turn.kind).toBe("turn");
  expect(turn.turn).toBe(1);
  expect(turn.files).toBeGreaterThanOrEqual(1);
  if (!manual.enabled) throw new Error("manual harus aktif");
  expect(manual.item.kind).toBe("manual");
  expect(manual.item.label).toBe("Sebelum ubah");

  const listed = await service.list(SESSION, work);
  expect(listed.enabled).toBe(true);
  expect(listed.items.map((item) => item.id)).toEqual([manual.item.id, turn.id]);
});

test("label manual divalidasi 1..80 dan tanpa karakter kontrol", async () => {
  await write("a.txt", "a\n");
  await expect(
    make().create(SESSION, work, { kind: "manual", label: "x".repeat(81) }),
  ).rejects.toBeInstanceOf(CheckpointError);
  await expect(
    make().create(SESSION, work, { kind: "manual", label: "baris\nbaru" }),
  ).rejects.toBeInstanceOf(CheckpointError);
  const ok = await make().create(SESSION, work, { kind: "manual", label: "x".repeat(80) });
  expect(ok.enabled).toBe(true);
});

test("maksimal 50 entri tersimpan, entri lama dibuang", async () => {
  const svc = make();
  await write("a.txt", "awal\n");
  for (let i = 1; i <= 55; i += 1) {
    await write("a.txt", `isi ${i}\n`);
    const result = await svc.create(SESSION, work, { kind: "turn", turn: i });
    if (!result.enabled) throw new Error(result.reason);
  }
  const listed = await svc.list(SESSION, work);
  expect(listed.items).toHaveLength(50);
  expect(listed.items[0]?.turn).toBe(55);
  expect(listed.items[49]?.turn).toBe(6);
}, 60_000);

test("folder bukan repo dan repo git pengguna sama-sama jalan; repo pengguna tidak berubah", async () => {
  await write("a.txt", "a\n");
  const plain = await createTurn(1);
  expect(plain.files).toBe(1);

  const repo = join(work, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "b.txt"), "b\n");
  const userGit = async (args: string[], cwd = repo): Promise<string> => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} gagal`);
    return out;
  };
  await userGit(["init", "-q"]);
  await userGit(["-c", "user.name=u", "-c", "user.email=u@u", "add", "-A"]);
  await userGit(["-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "awal"]);
  const headBefore = await userGit(["rev-parse", "HEAD"]);
  const indexBefore = await readFile(join(repo, ".git", "index"));
  const refsBefore = await readFile(join(repo, ".git", "HEAD"), "utf8");

  const hookMarker = join(outside, "hook-jalan.txt");
  const hookDir = join(repo, ".git", "hooks");
  await mkdir(hookDir, { recursive: true });
  for (const hook of ["post-commit", "pre-commit", "post-checkout"]) {
    await writeFile(join(hookDir, hook), `#!/bin/sh\necho jalan > "${hookMarker}"\n`, { mode: 0o755 });
  }

  await writeFile(join(repo, "b.txt"), "b diubah\n");
  const item = await make().create(SESSION, repo, { kind: "manual", label: "repo pengguna" });
  expect(item.enabled).toBe(true);

  const headAfter = await userGit(["rev-parse", "HEAD"]);
  const indexAfter = await readFile(join(repo, ".git", "index"));
  const refsAfter = await readFile(join(repo, ".git", "HEAD"), "utf8");
  expect(headAfter).toBe(headBefore);
  expect(indexAfter.equals(indexBefore)).toBe(true);
  expect(refsAfter).toBe(refsBefore);
  expect(existsSync(hookMarker)).toBe(false);
  expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b diubah\n");
});

test("rewind memulihkan, membuat ulang, dan menghapus berkas", async () => {
  await write("ubah.txt", "versi awal\n");
  await write("hapus.txt", "akan dihapus\n");
  await write("lama.txt", "tetap\n");
  const point = await createTurn(1);

  await write("ubah.txt", "versi baru yang lebih panjang\n");
  await rm(join(work, "hapus.txt"));
  await write("baru.txt", "baru\n");

  const preview = await service.preview(SESSION, work, point.id);
  const byPath = new Map(preview.changes.map((change) => [change.path, change.action]));
  expect(byPath.get("ubah.txt")).toBe("restore");
  expect(byPath.get("hapus.txt")).toBe("recreate");
  expect(byPath.get("baru.txt")).toBe("remove");
  expect(preview.truncated).toBe(false);

  const result = await service.rewind(SESSION, work, point.id);
  expect(result.restored).toBe(1);
  expect(result.recreated).toBe(1);
  expect(result.removed).toBe(1);
  expect(await read("ubah.txt")).toBe("versi awal\n");
  expect(await read("hapus.txt")).toBe("akan dihapus\n");
  expect(existsSync(join(work, "baru.txt"))).toBe(false);
  expect(await read("lama.txt")).toBe("tetap\n");
});

test("berkas dihapus di subfolder dibuat ulang termasuk foldernya", async () => {
  await write("sub/dalam/berkas.txt", "isi\n");
  const point = await createTurn(1);
  await rm(join(work, "sub"), { recursive: true, force: true });

  const result = await service.rewind(SESSION, work, point.id);
  expect(result.recreated).toBe(1);
  expect(await read("sub/dalam/berkas.txt")).toBe("isi\n");
});

test("daftar abaikan tidak disentuh saat rewind", async () => {
  const svc = make();
  await write("kode.txt", "awal\n");
  await mkdir(join(work, "node_modules", "paket"), { recursive: true });
  await writeFile(join(work, "node_modules", "paket", "index.js"), "lama\n", { mode: 0o644 });
  await writeFile(join(work, ".gitignore"), "rahasia.log\n");
  await writeFile(join(work, "rahasia.log"), "lama\n");
  await writeFile(join(work, "besar.bin"), "x".repeat(2048));

  const created = await svc.create(SESSION, work, { kind: "turn", turn: 1 });
  if (!created.enabled) throw new Error(created.reason);
  const point = created.item;
  await write("node_modules/paket/index.js", "baru\n");
  await write("rahasia.log", "baru\n");
  await write("besar.bin", "y".repeat(4096));
  await write("kode.txt", "berubah\n");

  const preview = await svc.preview(SESSION, work, point.id);
  expect(preview.changes.map((change) => change.path)).toEqual(["kode.txt"]);

  await svc.rewind(SESSION, work, point.id);
  expect(await read("node_modules/paket/index.js")).toBe("baru\n");
  expect(await read("rahasia.log")).toBe("baru\n");
  expect(await read("besar.bin")).toBe("y".repeat(4096));
  expect(await read("kode.txt")).toBe("awal\n");
});

test("nama berkas aneh (spasi, unicode, awalan -, # * [) tetap dipulihkan dan dihapus", async () => {
  const names = ["dengan spasi.txt", "üñï.txt", "-awalan.txt", "tanda#.txt", "bintang*.txt", "kurung[1].txt"];
  for (const name of names) await write(name, `isi ${name}\n`);
  const point = await createTurn(1);
  for (const name of names) await write(name, `baru ${name}\n`);
  await write("baru aneh #*.txt", "baru\n");

  await service.rewind(SESSION, work, point.id);
  for (const name of names) {
    expect(await read(name)).toBe(`isi ${name}\n`);
  }
  expect(existsSync(join(work, "baru aneh #*.txt"))).toBe(false);
});

test("mode eksekusi dipertahankan", async () => {
  await write("skrip.sh", "#!/bin/sh\necho hi\n");
  await chmod(join(work, "skrip.sh"), 0o755);
  const point = await createTurn(1);
  await chmod(join(work, "skrip.sh"), 0o644);
  await write("skrip.sh", "#!/bin/sh\necho berubah\n");

  await service.rewind(SESSION, work, point.id);
  expect((await stat(join(work, "skrip.sh"))).mode & 0o111).not.toBe(0);
});

test("titik pre-rewind memungkinkan round-trip dan rewind kedua idempoten", async () => {
  await write("a.txt", "awal\n");
  const point = await createTurn(1);
  await write("a.txt", "sebelum rewind\n");
  await write("baru.txt", "baru\n");

  const first = await service.rewind(SESSION, work, point.id);
  expect(await read("a.txt")).toBe("awal\n");
  expect(existsSync(join(work, "baru.txt"))).toBe(false);

  const items = await service.list(SESSION, work);
  const safety = items.items.find((item) => item.id === first.safetyId);
  expect(safety?.kind).toBe("pre-rewind");
  expect(safety?.label).toContain("Sebelum rewind");

  const back = await service.rewind(SESSION, work, first.safetyId);
  expect(back.safetyId).toHaveLength(40);
  expect(await read("a.txt")).toBe("sebelum rewind\n");
  expect(await read("baru.txt")).toBe("baru\n");

  const second = await service.rewind(SESSION, work, point.id);
  expect(second.restored).toBe(1);
  expect(second.removed).toBe(1);
  await service.rewind(SESSION, work, point.id);
  expect(await read("a.txt")).toBe("awal\n");
  expect(existsSync(join(work, "baru.txt"))).toBe(false);
});

test("preview tidak mengubah berkas dan truncated pada > 500 perubahan", async () => {
  await write("awal.txt", "x\n");
  const point = await createTurn(1);
  for (let i = 0; i < 501; i += 1) {
    await writeFile(join(work, `berkas-${String(i).padStart(3, "0")}.txt`), "baru\n");
  }
  const preview = await service.preview(SESSION, work, point.id);
  expect(preview.truncated).toBe(true);
  expect(preview.changes).toHaveLength(500);
  expect(existsSync(join(work, "berkas-000.txt"))).toBe(true);
  expect(await read("awal.txt")).toBe("x\n");
});

test("symlink keluar folder kerja tidak diikuti saat rewind", async () => {
  await write("milik.txt", "punya pengguna\n");
  const point = await createTurn(1);
  await writeFile(join(outside, "penting.txt"), "jangan diubah\n");

  await symlink(outside, join(work, "keluar"));
  await service.rewind(SESSION, work, point.id);

  expect(existsSync(join(work, "keluar"))).toBe(false);
  expect(await readFile(join(outside, "penting.txt"), "utf8")).toBe("jangan diubah\n");
});

test("cid palsu, traversal, dan bukan heks ditolak tanpa efek", async () => {
  await write("a.txt", "awal\n");
  await createTurn(1);
  await write("a.txt", "berubah\n");

  for (const cid of ["../../etc/passwd", "zz".repeat(20), "abc", "0".repeat(40)]) {
    await expect(service.preview(SESSION, work, cid)).rejects.toMatchObject({
      status: cid === "0".repeat(40) ? 404 : 400,
    });
  }
  await expect(service.rewind(SESSION, work, "0".repeat(40))).rejects.toMatchObject({ status: 404 });
  expect(await read("a.txt")).toBe("berubah\n");
});

test("id sesi tidak valid tidak dapat membuat path di luar root", async () => {
  for (const id of ["../luar", "s_ABCDEF12", "s_123", "../../tmp", "s_abcdef12/../../x"]) {
    await expect(service.list(id, work)).rejects.toBeInstanceOf(CheckpointError);
    await expect(service.remove(id)).rejects.toBeInstanceOf(CheckpointError);
  }
  expect(await listSessionDirs(root)).toEqual([]);
});

test("batas berkas dan ukuran mematikan checkpoint dengan alasan", async () => {
  const limited = new CheckpointService({ root, maxFiles: 3, maxTotalBytes: 1024 * 1024 });
  for (let i = 0; i < 5; i += 1) await write(`f${i}.txt`, "x\n");

  const result = await limited.create(SESSION, work, { kind: "turn", turn: 1 });
  expect(result.enabled).toBe(false);
  if (result.enabled) throw new Error("harus dimatikan");
  expect(result.reason).toContain("5 berkas");
  expect(result.reason).not.toContain(work);

  const listed = await limited.list(SESSION, work);
  expect(listed.enabled).toBe(false);
  expect(listed.reason).toBe(result.reason);
  expect(listed.items).toEqual([]);
});

test("batas ukuran total juga mematikan checkpoint", async () => {
  const limited = new CheckpointService({ root, maxFiles: 100, maxTotalBytes: 10 });
  await write("a.txt", "12345678901");
  const result = await limited.create(SESSION, work, { kind: "turn", turn: 1 });
  expect(result.enabled).toBe(false);
});

test("konfigurasi git berbahaya di repo pengguna tidak mengeksekusi apa pun", async () => {
  const repo = join(work, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "a.txt"), "a\n");
  const marker = join(outside, "dieksekusi.txt");
  const script = join(outside, "script.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

  const git = async (args: string[]): Promise<void> => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  };
  await git(["init", "-q"]);
  await git(["config", "core.fsmonitor", script]);
  await git(["config", "diff.external", script]);
  await git(["config", "core.hooksPath", join(repo, "hooks")]);
  await mkdir(join(repo, "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "post-commit", "post-checkout"]) {
    await writeFile(join(repo, "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  }
  await writeFile(join(repo, ".gitattributes"), "* filter=jahat\n");
  await git(["config", "filter.jahat.clean", script]);

  const result = await make().create(SESSION, repo, { kind: "turn", turn: 1 });
  expect(result.enabled).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

test("mutex mencegah operasi bersamaan pada satu sesi", async () => {
  await write("a.txt", "awal\n");
  await createTurn(1);
  const results = await Promise.all([
    service.preview(SESSION, work, (await service.list(SESSION, work)).items[0]!.id),
    service.list(SESSION, work),
    service.create(SESSION, work, { kind: "manual", label: "bersamaan" }),
  ]);
  expect(results).toHaveLength(3);
  const items = await service.list(SESSION, work);
  expect(items.items.some((item) => item.label === "bersamaan")).toBe(true);
});

test("remove menghapus seluruh folder sesi", async () => {
  await write("a.txt", "a\n");
  await createTurn(1);
  expect(await listSessionDirs(root)).toEqual([SESSION]);
  await service.remove(SESSION);
  expect(await listSessionDirs(root)).toEqual([]);
  const listed = await service.list(SESSION, work);
  expect(listed.items).toEqual([]);
});

test("folder checkpoint dan berkas memakai izin 0700/0600", async () => {
  await write("a.txt", "a\n");
  await createTurn(1);
  expect((await stat(join(root, SESSION))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, SESSION, "index.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, SESSION, "git"))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(root, SESSION, "git", "info", "exclude"))).mode & 0o777).toBe(0o600);
});

test("rewind tidak menghapus berkas di luar workTree lewat induk symlink dan menolak dengan jelas", async () => {
  await mkdir(join(work, "link"), { recursive: true });
  await writeFile(join(work, "link", "x"), "dalam\n");
  const point = await createTurn(1);

  await rm(join(work, "link"), { recursive: true, force: true });
  await writeFile(join(outside, "x"), "luar\n");
  await symlink(outside, join(work, "link"));

  let message = "";
  let safetyId: string | undefined;
  try {
    await service.rewind(SESSION, work, point.id);
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointError);
    message = (error as Error).message;
    safetyId = /titik ([0-9a-f]{40})/.exec(message)?.[1];
  }
  expect(message).toContain("Rewind gagal");
  expect(safetyId).toBeDefined();
  expect(message.includes(work)).toBe(false);
  expect(message.includes(outside)).toBe(false);
  expect(await readFile(join(outside, "x"), "utf8")).toBe("luar\n");
});

test("filter git di repo pengguna tidak dijalankan saat create, preview, dan rewind", async () => {
  const repo = join(work, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "a.txt"), "a\n");

  const marker = join(outside, "filter-penanda.txt");
  const script = join(outside, "filter.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });

  const git = async (args: string[]): Promise<void> => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  };
  await git(["init", "-q"]);
  await writeFile(join(repo, ".gitattributes"), "* filter=x\n");
  await git(["config", "filter.x.clean", script]);
  await git(["config", "filter.x.smudge", script]);

  const created = await make().create(SESSION, repo, { kind: "turn", turn: 1 });
  expect(created.enabled).toBe(true);
  if (!created.enabled) throw new Error("checkpoint harus aktif");
  expect(existsSync(marker)).toBe(false);

  await writeFile(join(repo, "a.txt"), "berubah\n");
  const preview = await make().preview(SESSION, repo, created.item.id);
  expect(preview.changes.map((change) => change.path)).toEqual(["a.txt"]);
  expect(existsSync(marker)).toBe(false);

  await make().rewind(SESSION, repo, created.item.id);
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a\n");
  expect(existsSync(marker)).toBe(false);
});

test("rewind gagal di tengah menyebut safetyId dan titik itu bisa memulihkan", async () => {
  await writeFile(join(work, "tetap.txt"), "awal\n");
  const point = await createTurn(1);

  await writeFile(join(work, "tetap.txt"), "berubah\n");
  await mkdir(join(work, "kunci"));
  await writeFile(join(work, "kunci", "baru.txt"), "baru\n");
  await chmod(join(work, "kunci", "baru.txt"), 0o400);
  await chmod(join(work, "kunci"), 0o500);

  let message = "";
  let safetyId: string | undefined;
  try {
    await service.rewind(SESSION, work, point.id);
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointError);
    message = (error as Error).message;
    safetyId = /titik ([0-9a-f]{40})/.exec(message)?.[1];
  } finally {
    await chmod(join(work, "kunci"), 0o700);
  }
  expect(message).toContain("Rewind gagal");
  expect(message).toMatch(/[0-9a-f]{40}/);
  expect(message.includes(work)).toBe(false);
  expect(safetyId).toBeDefined();
  if (safetyId === undefined) throw new Error("safetyId tidak ada di pesan");
  expect(await read("tetap.txt")).toBe("awal\n");

  const back = await service.rewind(SESSION, work, safetyId);
  expect(back.safetyId).toHaveLength(40);
  expect(await read("tetap.txt")).toBe("berubah\n");
  expect(existsSync(join(work, "kunci", "baru.txt"))).toBe(true);
});
