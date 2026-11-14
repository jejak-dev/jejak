import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DATA_VERSION_FILE } from "../src/server/data-version";
import { VERSION } from "../src/shared/version";

const CLI = join(process.cwd(), "src/cli/index.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jejak-data-versi-proses-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Versi yang pasti lebih tua dari versi aplikasi berjalan. */
const VERSI_LAMA = `${VERSION}-0`;
/** Versi yang pasti lebih baru dari versi aplikasi berjalan. */
const VERSI_BARU = "99.0.0";

/** Ambil porta bebas dari OS lalu lepaskan. */
async function portBebas(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

async function tulisVersi(appVersion: string): Promise<void> {
  await writeFile(
    join(home, DATA_VERSION_FILE),
    `${JSON.stringify({ appVersion, updatedAt: "2026-11-01T00:00:00.000Z" }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test("data lebih baru dari aplikasi: keluar 1 dengan pesan jelas", async () => {
  await tulisVersi(VERSI_BARU);

  const proc = Bun.spawn(["bun", "run", CLI, "serve", "--mock", "--port", String(await portBebas())], {
    cwd: process.cwd(),
    env: { ...process.env, JEJAK_HOME: home, MOCK: "true" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  expect(code).toBe(1);
  expect(stderr).toContain("lebih baru");
  expect(stderr).toContain(VERSI_BARU);
  expect(stderr).toContain("JEJAK_HOME");
  // Data tak boleh berubah dan tak ada cadangan yang dibuat.
  expect(await readdir(join(home, "backup")).catch(() => [])).toEqual([]);
  const isi = JSON.parse(
    await Bun.file(join(home, DATA_VERSION_FILE)).text(),
  ) as { appVersion: string };
  expect(isi.appVersion).toBe(VERSI_BARU);
}, 30_000);

test("data lebih lama: server jalan dan cadangan dibuat", async () => {
  await tulisVersi(VERSI_LAMA);
  const db = new Database(join(home, "sessions.db"));
  db.run("CREATE TABLE t (a TEXT)");
  db.run("INSERT INTO t VALUES ('halo')");
  db.close();

  const proc = Bun.spawn(["bun", "run", CLI, "serve", "--mock", "--port", String(await portBebas())], {
    cwd: process.cwd(),
    env: { ...process.env, JEJAK_HOME: home, MOCK: "true" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  const decoder = new TextDecoder();
  void (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
    } catch {
      // Stream ditutup saat proses berhenti.
    }
  })();

  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !stdout.includes("Data: ") && !exited) {
    await Bun.sleep(50);
  }
  proc.kill("SIGTERM");

  expect(stdout).toContain("Data dicadangkan ke");
  expect(stdout).toContain(VERSI_LAMA);
  const backupDir = join(home, "backup", VERSI_LAMA);
  expect((await stat(backupDir)).isDirectory()).toBe(true);
  expect((await stat(join(backupDir, "sessions.db"))).isFile()).toBe(true);
  const isi = JSON.parse(await Bun.file(join(home, DATA_VERSION_FILE)).text()) as {
    appVersion: string;
  };
  expect(isi.appVersion).toBe(VERSION);
}, 30_000);
