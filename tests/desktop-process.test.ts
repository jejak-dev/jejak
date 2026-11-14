import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_ENTER_PATH, DESKTOP_READY_PREFIX } from "../src/server/desktop";

const CLI = join(process.cwd(), "src/cli/index.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jejak-desktop-proses-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function tokenAcak(): string {
  return randomBytes(24).toString("base64url");
}

interface Hasil {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function jalankanDesktop(
  env: Record<string, string>,
  options: { siap?: (baris: string) => boolean; ms?: number } = {},
): Promise<Hasil & { proc: Bun.Subprocess }> {
  const proc = Bun.spawn(["bun", "run", CLI, "serve", "--desktop", "--mock"], {
    cwd: process.cwd(),
    env: { ...process.env, JEJAK_HOME: home, JEJAK_PERSIST: "0", MOCK: "true", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sink(decoder.decode(value));
      }
    } catch {
      // Stream ditutup saat proses berhenti.
    }
  };
  void pump(proc.stdout, (text) => {
    stdout += text;
  });
  void pump(proc.stderr, (text) => {
    stderr += text;
  });

  let code: number | null = null;
  void proc.exited.then((value) => {
    code = value;
  });

  const deadline = Date.now() + (options.ms ?? 20_000);
  while (Date.now() < deadline) {
    if (options.siap !== undefined && options.siap(stdout + stderr)) break;
    if (code !== null) break;
    await Bun.sleep(50);
  }

  return { proc, code, stdout, stderr };
}

function barisReady(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(DESKTOP_READY_PREFIX));
}

describe("proses nyata mode desktop", () => {
  test("mengumumkan siap, menerima masuk, lalu mati saat stdin ditutup", async () => {
    const token = tokenAcak();
    const hasil = await jalankanDesktop(
      { JEJAK_DESKTOP_TOKEN: token },
      { siap: (teks) => teks.includes(DESKTOP_READY_PREFIX) },
    );
    const { proc } = hasil;

    const ready = barisReady(hasil.stdout);
    expect(ready).toBeDefined();
    const payload = JSON.parse((ready ?? "").slice(DESKTOP_READY_PREFIX.length).trim()) as {
      port: number;
      host: string;
      version: string;
    };
    expect(payload.port).toBeGreaterThan(0);
    expect(payload.host).toBe("127.0.0.1");
    expect(payload.version.length).toBeGreaterThan(0);

    // Hanya satu baris pengumuman siap.
    const barisReadySemua = hasil.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith(DESKTOP_READY_PREFIX));
    expect(barisReadySemua).toHaveLength(1);

    // Token tak boleh bocor ke stdout/stderr.
    expect(hasil.stdout).not.toContain(token);
    expect(hasil.stderr).not.toContain(token);

    const masuk = await fetch(
      `http://127.0.0.1:${payload.port}${DESKTOP_ENTER_PATH}?t=${token}`,
      { redirect: "manual" },
    );
    expect(masuk.status).toBe(302);
    expect(masuk.headers.get("location")).toBe("/");
    const cookie = (masuk.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const terproteksi = await fetch(`http://127.0.0.1:${payload.port}/api/sessions`, {
      headers: { cookie },
    });
    expect(terproteksi.status).toBe(200);

    const tanpaCookie = await fetch(`http://127.0.0.1:${payload.port}/api/sessions`);
    expect(tanpaCookie.status).toBe(401);

    // Tutup stdin: proses harus keluar sendiri dengan kode 0.
    (proc.stdin as unknown as { end(): void }).end();
    const keluar = await Promise.race([
      proc.exited,
      Bun.sleep(3_000).then(() => "timeout" as const),
    ]);
    expect(keluar).toBe(0);
    expect(await proc.exited).toBe(0);
  }, 30_000);

  test("SIGTERM membuat proses keluar dengan kode 0", async () => {
    const hasil = await jalankanDesktop(
      { JEJAK_DESKTOP_TOKEN: tokenAcak() },
      { siap: (teks) => teks.includes(DESKTOP_READY_PREFIX) },
    );
    const { proc } = hasil;
    expect(barisReady(hasil.stdout)).toBeDefined();
    // Proses tetap hidup selama stdin terbuka.
    expect(await Promise.race([proc.exited, Bun.sleep(300).then(() => "hidup" as const)])).toBe(
      "hidup",
    );
    proc.kill("SIGTERM");
    const keluar = await Promise.race([
      proc.exited,
      Bun.sleep(3_000).then(() => "timeout" as const),
    ]);
    expect(keluar).toBe(0);
  }, 30_000);

  test("tanpa JEJAK_DESKTOP_TOKEN keluar dengan kode 1", async () => {
    const hasil = await jalankanDesktop({ JEJAK_DESKTOP_TOKEN: "" }, { ms: 10_000 });
    expect(await hasil.proc.exited).toBe(1);
    expect(hasil.stderr).toContain("JEJAK_DESKTOP_TOKEN");
    expect(barisReady(hasil.stdout)).toBeUndefined();
  }, 20_000);

  test("token terlalu pendek ditolak", async () => {
    const hasil = await jalankanDesktop({ JEJAK_DESKTOP_TOKEN: "pendek" }, { ms: 10_000 });
    expect(await hasil.proc.exited).toBe(1);
    expect(hasil.stderr).toContain("JEJAK_DESKTOP_TOKEN");
  }, 20_000);

  test("host non-loopback ditolak pada mode desktop", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "serve", "--desktop", "--host", "0.0.0.0", "--mock"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JEJAK_HOME: home,
          JEJAK_PERSIST: "0",
          MOCK: "true",
          JEJAK_DESKTOP_TOKEN: tokenAcak(),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(1);
    expect(stderr).toContain("loopback");
  }, 20_000);
});
