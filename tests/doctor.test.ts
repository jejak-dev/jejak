import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks, formatCheck, runDoctor, type Check } from "../src/cli/doctor";
import { parseRegistry } from "../src/server/provider";
import { saveRegistry } from "../src/server/provider-store";

let root: string;
let providersFile: string;
let homeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-doctor-"));
  homeDir = join(root, "home");
  providersFile = join(homeDir, "providers.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function labels(checks: Check[]): string[] {
  return checks.map((check) => check.name);
}

function find(checks: Check[], name: string): Check {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) {
    throw new Error(`cek "${name}" tidak ditemukan`);
  }
  return check;
}

async function writeRegistryFile(): Promise<void> {
  const registry = parseRegistry({
    activeProfileId: "deepseek",
    profiles: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.test/v1",
        apiKey: "sk-rahasia-123",
        models: [{ id: "deepseek-chat" }],
        defaultModel: "deepseek-chat",
      },
      { id: "anthropic", name: "Anthropic", models: [] },
    ],
  });
  await saveRegistry(registry, providersFile);
  await chmod(homeDir, 0o700);
}

test("kunci cek lama dan urutannya dipertahankan", async () => {
  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  expect(labels(checks).slice(0, 3)).toEqual([
    "Bun >= 1.4",
    "Git tersedia",
    "Binding server",
  ]);
  expect(find(checks, "Bun >= 1.4").detail).toBe(`terdeteksi ${Bun.version}`);
  expect(find(checks, "Binding server").detail).toBe("127.0.0.1:3000");
});

test("Binding server memakai env HOST dan PORT", async () => {
  const checks = await collectChecks({
    env: { HOST: "0.0.0.0", PORT: "4321" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  expect(find(checks, "Binding server").detail).toBe("0.0.0.0:4321");
});

test("tanpa providers.json registry memakai env dan profil aktif peringatan", async () => {
  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const registry = find(checks, "Registry provider");
  expect(registry.status).toBe("ok");
  expect(registry.detail).toBe("belum ada providers.json; memakai konfigurasi dari env");

  const active = find(checks, "Profil aktif");
  expect(active.status).toBe("peringatan");
  expect(active.detail).toContain("key belum diset");
  expect(active.detail).toContain("model belum diatur");
  expect(labels(checks).includes("Izin providers.json")).toBe(false);
});

test("profil aktif dari env lengkap berstatus ok", async () => {
  const checks = await collectChecks({
    env: {
      ANTHROPIC_API_KEY: "sk-env",
      ANTHROPIC_MODEL: "claude-sonnet-5-5",
    },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const active = find(checks, "Profil aktif");
  expect(active.status).toBe("ok");
  expect(active.detail).toContain("claude-sonnet-5-5");
  expect(active.detail).toContain("key terisi");
});

test("berkas valid dua profil menampilkan jumlah dan profil aktif", async () => {
  await writeRegistryFile();

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  expect(find(checks, "Registry provider").detail).toBe("2 profil, aktif: deepseek");
  expect(find(checks, "Profil aktif").detail).toContain("https://api.deepseek.test/v1");
  expect(find(checks, "Profil aktif").detail).toContain("deepseek-chat");
});

test("izin 600 dan 700 berstatus ok", async () => {
  await writeRegistryFile();

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const permissions = find(checks, "Izin providers.json");
  expect(permissions.status).toBe("ok");
  expect(permissions.detail).toBe("izin 600/700");
});

test("izin berkas longgar menghasilkan peringatan chmod 600", async () => {
  await writeRegistryFile();
  await chmod(providersFile, 0o644);

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const permissions = find(checks, "Izin providers.json");
  expect(permissions.status).toBe("peringatan");
  expect(permissions.detail).toContain("chmod 600");
});

test("izin direktori longgar menghasilkan peringatan chmod 700", async () => {
  await writeRegistryFile();
  await chmod(homeDir, 0o755);

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const permissions = find(checks, "Izin providers.json");
  expect(permissions.status).toBe("peringatan");
  expect(permissions.detail).toContain("chmod 700");
});

test("JSON rusak membuat registry gagal dan runDoctor mengembalikan 1", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(providersFile, "{ bukan json", { mode: 0o600 });

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  expect(find(checks, "Registry provider").status).toBe("gagal");

  const logged: string[] = [];
  const code = await runDoctor({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(1);
  expect(logged.some((line) => line.includes("GAGAL  Registry provider"))).toBe(true);
});

test("hanya peringatan membuat runDoctor mengembalikan 0", async () => {
  const logged: string[] = [];
  const code = await runDoctor({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });

  expect(code).toBe(0);
  expect(logged[0]).toBe(`Jejak 0.0.1\n`);
  expect(logged.some((line) => line.includes("PERINGATAN  Profil aktif"))).toBe(true);
});

test("resolveSdk string berstatus ok dan null berstatus peringatan", async () => {
  const found = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => "/opt/sdk/index.js",
  });
  const sdk = find(found, "Claude Agent SDK");
  expect(sdk.status).toBe("ok");
  expect(sdk.detail).toBe("/opt/sdk/index.js");

  const missing = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const missingSdk = find(missing, "Claude Agent SDK");
  expect(missingSdk.status).toBe("peringatan");
  expect(missingSdk.detail).toContain("belum terpasang");
});

test("nilai rahasia tidak bocor ke check maupun log", async () => {
  const secret = "sk-rahasia-123";
  const registry = parseRegistry({
    activeProfileId: "proxy",
    profiles: [
      {
        id: "proxy",
        name: "Proxy",
        baseUrl: "https://user:pass@x.test",
        apiKey: secret,
        models: [],
        defaultModel: "model-rahasia",
      },
    ],
  });
  await saveRegistry(registry, providersFile);

  const checks = await collectChecks({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const serialized = JSON.stringify(checks);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("pass");
  expect(find(checks, "Registry provider").detail).not.toContain(secret);

  const logged: string[] = [];
  await runDoctor({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  const allLines = logged.join("\n");
  expect(allLines).not.toContain(secret);
  expect(allLines).not.toContain("pass");
  expect(allLines).not.toContain("user@");
});

test("formatCheck memakai label untuk tiap status", () => {
  expect(formatCheck({ name: "A", status: "ok", detail: "d" })).toBe("OK   A  (d)");
  expect(formatCheck({ name: "B", status: "peringatan", detail: "d" })).toBe(
    "PERINGATAN  B  (d)",
  );
  expect(formatCheck({ name: "C", status: "gagal", detail: "d" })).toBe("GAGAL  C  (d)");
});

test("penyimpanan sesi: berkas belum ada", async () => {
  const checks = await collectChecks({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const storage = find(checks, "Penyimpanan sesi");
  expect(storage.status).toBe("ok");
  expect(storage.detail).toContain(join(homeDir, "sessions.db"));
  expect(storage.detail).toContain("belum ada");
});

test("penyimpanan sesi: berkas ada dengan izin dan versi skema", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const { SqliteSessionStore } = await import("../src/server/sessions/session-store");
  const store = new SqliteSessionStore(join(homeDir, "sessions.db"));
  store.close();

  const checks = await collectChecks({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const storage = find(checks, "Penyimpanan sesi");
  expect(storage.status).toBe("ok");
  expect(storage.detail).toContain("skema v1");
  expect(storage.detail).toContain("KB");
});

test("penyimpanan sesi: izin longgar memberi peringatan", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const { SqliteSessionStore } = await import("../src/server/sessions/session-store");
  const store = new SqliteSessionStore(join(homeDir, "sessions.db"));
  store.close();
  await chmod(join(homeDir, "sessions.db"), 0o644);

  const checks = await collectChecks({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const storage = find(checks, "Penyimpanan sesi");
  expect(storage.status).toBe("peringatan");
  expect(storage.detail).toContain("chmod 600");
});

test("penyimpanan sesi: dimatikan lewat JEJAK_PERSIST=0 dan tetap exit 0", async () => {
  const logged: string[] = [];
  const checks = await collectChecks({
    env: { JEJAK_HOME: homeDir, JEJAK_PERSIST: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const storage = find(checks, "Penyimpanan sesi");
  expect(storage.status).toBe("peringatan");
  expect(storage.detail).toContain("dimatikan");

  const code = await runDoctor({
    env: { JEJAK_HOME: homeDir, JEJAK_PERSIST: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("Penyimpanan sesi"))).toBe(true);
});
