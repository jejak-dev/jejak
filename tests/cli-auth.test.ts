import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLiteralIpHost, parseArgs } from "../src/cli/args";

const CLI = join(process.cwd(), "src/cli/index.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jejak-cli-auth-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  options: { env?: Record<string, string>; ready?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JEJAK_HOME: home,
      JEJAK_PERSIST: "0",
      MOCK: "true",
      ...options.env,
    },
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
      // Stream ditutup saat proses dibunuh.
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

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (options.ready !== undefined && (stdout + stderr).includes(options.ready)) break;
    if (code !== null) break;
    await Bun.sleep(50);
  }

  if (code === null) {
    proc.kill();
  }
  await proc.exited;

  return { code, stdout, stderr };
}

describe("parseArgs untuk autentikasi", () => {
  test("--password auto diterima", () => {
    expect(parseArgs(["serve", "--password", "auto"])).toEqual({
      command: "serve",
      password: "auto",
    });
    expect(parseArgs(["serve", "--password=auto"])).toEqual({
      command: "serve",
      password: "auto",
    });
  });

  test("--password dengan nilai literal ditolak", () => {
    const parsed = parseArgs(["serve", "--password", "rahasia-saya"]);
    expect(parsed.command).toBe("serve");
    expect(parsed.error).toContain("JEJAK_PASSWORD");
    expect(parsed.error).toContain("--password-file");
    expect(parsed.password).toBeUndefined();
  });

  test("--password tanpa nilai ditolak", () => {
    const parsed = parseArgs(["serve", "--password"]);
    expect(parsed.error).toBeDefined();
  });

  test("--password-file membaca jalur", () => {
    expect(parseArgs(["serve", "--password-file", "/tmp/sandi"])).toEqual({
      command: "serve",
      passwordFile: "/tmp/sandi",
    });
  });

  test("--allow-host boleh diulang", () => {
    expect(parseArgs(["serve", "--allow-host", "jejak.lan", "--allow-host", "192.168.1.5"])).toEqual({
      command: "serve",
      allowHosts: ["jejak.lan", "192.168.1.5"],
    });
  });

  test("--insecure-no-auth dicatat", () => {
    expect(parseArgs(["serve", "--insecure-no-auth"])).toEqual({
      command: "serve",
      insecureNoAuth: true,
    });
  });

  test("--tls-cert dan --tls-key harus berpasangan", () => {
    const parsed = parseArgs(["serve", "--tls-cert", "/tmp/cert.pem"]);
    expect(parsed.error).toContain("--tls-key");
    const lengkap = parseArgs(["serve", "--tls-cert", "/tmp/cert.pem", "--tls-key", "/tmp/key.pem"]);
    expect(lengkap.error).toBeUndefined();
    expect(lengkap.tlsCert).toBe("/tmp/cert.pem");
    expect(lengkap.tlsKey).toBe("/tmp/key.pem");
  });

  test("isLiteralIpHost membedakan IP, wildcard, dan nama host", () => {
    expect(isLiteralIpHost("192.168.1.5")).toBe(true);
    expect(isLiteralIpHost("127.0.0.1")).toBe(true);
    expect(isLiteralIpHost("::1")).toBe(true);
    expect(isLiteralIpHost("0.0.0.0")).toBe(false);
    expect(isLiteralIpHost("::")).toBe(false);
    expect(isLiteralIpHost("jejak.lan")).toBe(false);
  });
});

describe("perilaku CLI", () => {
  test("host non-loopback tanpa sandi keluar dengan kode 1", async () => {
    const hasil = await runCli(["serve", "--host", "0.0.0.0", "--port", "39871"], {
      env: { JEJAK_PASSWORD: "" },
    });
    expect(hasil.code).toBe(1);
    expect(hasil.stderr).toContain("--password auto");
    expect(hasil.stderr).toContain("JEJAK_PASSWORD");
  });

  test("host non-loopback tanpa sandi dan tanpa --insecure-no-auth ditolak walau sandi di env kosong", async () => {
    const hasil = await runCli(["serve", "--host", "192.168.1.5", "--port", "39872"]);
    expect(hasil.code).toBe(1);
    expect(hasil.stderr).toContain("--insecure-no-auth");
  });

  test("--insecure-no-auth memberi peringatan keras dan server tetap jalan", async () => {
    const hasil = await runCli(
      ["serve", "--host", "0.0.0.0", "--port", "39873", "--insecure-no-auth"],
      { ready: "PERINGATAN KERAS" },
    );
    expect(hasil.stderr).toContain("PERINGATAN KERAS");
    expect(hasil.stderr).toContain("TANPA autentikasi");
  });

  test("sandi di env tanpa --allow-host pada host non-loopback keluar dengan kode 1", async () => {
    const hasil = await runCli(["serve", "--host", "0.0.0.0", "--port", "39874"], {
      env: { JEJAK_PASSWORD: "sandi-uji-123" },
    });
    expect(hasil.code).toBe(1);
    expect(hasil.stderr).toContain("--allow-host");
  });

  test("sandi di env dengan --allow-host berjalan", async () => {
    const hasil = await runCli(
      ["serve", "--host", "0.0.0.0", "--port", "39875", "--allow-host", "jejak.lan"],
      { env: { JEJAK_PASSWORD: "sandi-uji-123" }, ready: "siap di" },
    );
    expect(hasil.stdout).toContain("siap di");
    expect(hasil.stderr).not.toContain("--allow-host");
  });

  test("sandi acak --password auto dicetak sekali", async () => {
    const hasil = await runCli(
      ["serve", "--host", "127.0.0.1", "--port", "39876", "--password", "auto"],
      { ready: "siap di" },
    );
    expect(hasil.stdout).toContain("Kata sandi Jejak");
    const baris = hasil.stdout
      .split("\n")
      .filter((line) => line.includes("Kata sandi Jejak"));
    expect(baris).toHaveLength(1);
  });

  test("--password dengan nilai literal ditolak CLI", async () => {
    const hasil = await runCli(["serve", "--password", "rahasia-saya"]);
    expect(hasil.code).toBe(1);
    expect(hasil.stderr).toContain("JEJAK_PASSWORD");
  });
});
