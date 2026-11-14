import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectChecks,
  formatCheck,
  runDoctor,
  type Check,
  type DoctorContext,
} from "../src/cli/doctor";
import { parseRegistry } from "../src/server/provider";
import { saveRegistry } from "../src/server/provider-store";
import { installFromTarball } from "../src/server/sdk/sdk-store";
import { computeIntegrity } from "../src/server/sdk/tarball";
import { VERSION } from "../src/shared/version";
import { buildTar, gzipOf, packageEntries } from "./helpers/tar-builder";

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

/** CLI `claude` selalu dianggap tidak ada; membuat tes lama deterministik. */
const CLI_TIDAK_ADA = {
  which: () => null,
  exists: async () => false,
  runVersion: async () => null,
};

/**
 * Konteks dasar tes: akar SDK terisolasi di tmp dan CLI `claude` absen.
 *
 * Tanpa ini, `collectChecks` memakai `~/.jejak/sdk` dan PATH mesin, sehingga
 * hasil tes bergantung pada apa yang terpasang di komputer.
 */
function baseCtx(ctx: DoctorContext = {}): DoctorContext {
  return {
    sdkRoot: join(root, "sdk"),
    locate: CLI_TIDAK_ADA,
    ...ctx,
  };
}

async function collect(ctx: DoctorContext = {}): Promise<Check[]> {
  return collectChecks(baseCtx(ctx));
}

async function doctor(ctx: DoctorContext = {}): Promise<number> {
  return runDoctor(baseCtx(ctx));
}

/** Pasang SDK terkelola palsu di `dir`. */
async function pasangSdk(dir: string, versi: string): Promise<void> {
  const gz = gzipOf(buildTar(packageEntries("@anthropic-ai/claude-agent-sdk", versi)));
  await installFromTarball(dir, {
    gz,
    integrity: computeIntegrity(gz),
    expected: { name: "@anthropic-ai/claude-agent-sdk", version: versi },
    now: "2026-11-14T00:00:00.000Z",
  });
}

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
  const checks = await collect({
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
  const checks = await collect({
    env: { HOST: "0.0.0.0", PORT: "4321" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  expect(find(checks, "Binding server").detail).toBe("0.0.0.0:4321");
});

test("tanpa providers.json registry memakai env dan profil aktif peringatan", async () => {
  const checks = await collect({
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
  const checks = await collect({
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

  const checks = await collect({
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

  const checks = await collect({
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

  const checks = await collect({
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

  const checks = await collect({
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

  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  expect(find(checks, "Registry provider").status).toBe("gagal");

  const logged: string[] = [];
  const code = await doctor({
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
  const code = await doctor({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });

  expect(code).toBe(0);
  expect(logged[0]).toBe(`Jejak ${VERSION}\n`);
  expect(logged.some((line) => line.includes("PERINGATAN  Profil aktif"))).toBe(true);
});

test("resolveSdk string berstatus ok dan null berstatus peringatan", async () => {
  const found = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => "/opt/sdk/index.js",
  });
  const sdk = find(found, "Claude Agent SDK");
  expect(sdk.status).toBe("ok");
  expect(sdk.detail).toBe("/opt/sdk/index.js");

  const missing = await collect({
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

  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const serialized = JSON.stringify(checks);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("pass");
  expect(find(checks, "Registry provider").detail).not.toContain(secret);

  const logged: string[] = [];
  await doctor({
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
  const checks = await collect({
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

  const checks = await collect({
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

  const checks = await collect({
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
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_PERSIST: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const storage = find(checks, "Penyimpanan sesi");
  expect(storage.status).toBe("peringatan");
  expect(storage.detail).toContain("dimatikan");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir, JEJAK_PERSIST: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("Penyimpanan sesi"))).toBe(true);
});

test("memory: folder belum ada", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const memory = find(checks, "Memory");
  expect(memory.status).toBe("ok");
  expect(memory.detail).toContain(join(homeDir, "memory"));
  expect(memory.detail).toContain("belum ada");
});

test("memory: ada berkas, indeks, dan jumlah aktif/usulan", async () => {
  const { FileMemoryStore } = await import("../src/server/memory/memory-store");
  const store = new FileMemoryStore({ dir: join(homeDir, "memory") });
  await store.create({
    id: crypto.randomUUID(),
    layer: "profile",
    projectKey: null,
    title: "Perintah tes",
    body: "bun test",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at: "2026-11-08T10:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
  });
  await store.create({
    id: crypto.randomUUID(),
    layer: "profile",
    projectKey: null,
    title: "Usulan",
    body: "isi",
    status: "proposed",
    confidence: "inferred",
    origin: { kind: "session", at: "2026-11-08T10:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
  });
  store.close();

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const memory = find(checks, "Memory");
  expect(memory.status).toBe("ok");
  expect(memory.detail).toContain("2 berkas");
  expect(memory.detail).toContain("1 aktif/1 usulan");
  expect(memory.detail).toContain("indeks ada");
});

test("memory: berkas rusak dihitung sebagai problems", async () => {
  await mkdir(join(homeDir, "memory", "profile"), { recursive: true, mode: 0o700 });
  await writeFile(join(homeDir, "memory", "profile", "rusak.md"), "bukan frontmatter", {
    mode: 0o600,
  });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const memory = find(checks, "Memory");
  expect(memory.detail).toContain("1 problems");
  expect(memory.detail).toContain("indeks belum ada");
});

test("memory: izin folder longgar memberi peringatan", async () => {
  await mkdir(join(homeDir, "memory"), { recursive: true, mode: 0o755 });
  await chmod(join(homeDir, "memory"), 0o755);

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const memory = find(checks, "Memory");
  expect(memory.status).toBe("peringatan");
  expect(memory.detail).toContain("chmod 700");
});

test("memory: dimatikan lewat JEJAK_MEMORY=0 dan tetap exit 0", async () => {
  const logged: string[] = [];
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_MEMORY: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const memory = find(checks, "Memory");
  expect(memory.status).toBe("peringatan");
  expect(memory.detail).toContain("dimatikan");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir, JEJAK_MEMORY: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("PERINGATAN  Memory"))).toBe(true);
});

test("workspace: folder belum ada", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const workspace = find(checks, "Workspace");
  expect(workspace.status).toBe("ok");
  expect(workspace.detail).toContain(join(homeDir, "workspaces"));
  expect(workspace.detail).toContain("belum ada");
});

test("workspace: ada berkas dan berkas rusak dihitung problems", async () => {
  const { WorkspaceService } = await import("../src/server/workspaces/workspace-service");
  const service = new WorkspaceService({ dir: join(homeDir, "workspaces") });
  await service.create({ name: "Kantor" });
  await writeFile(join(homeDir, "workspaces", `${crypto.randomUUID()}.json`), "rusak", {
    mode: 0o600,
  });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const workspace = find(checks, "Workspace");
  expect(workspace.status).toBe("ok");
  expect(workspace.detail).toContain("1 workspace");
  expect(workspace.detail).toContain("1 problems");
  expect(workspace.detail).toContain("izin 700");
});

test("workspace: izin folder longgar memberi peringatan", async () => {
  await mkdir(join(homeDir, "workspaces"), { recursive: true, mode: 0o755 });
  await chmod(join(homeDir, "workspaces"), 0o755);

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const workspace = find(checks, "Workspace");
  expect(workspace.status).toBe("peringatan");
  expect(workspace.detail).toContain("chmod 700");
});

test("workspace: dimatikan lewat JEJAK_WORKSPACES=0 dan tetap exit 0", async () => {
  const logged: string[] = [];
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_WORKSPACES: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const workspace = find(checks, "Workspace");
  expect(workspace.status).toBe("peringatan");
  expect(workspace.detail).toContain("dimatikan");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir, JEJAK_WORKSPACES: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("PERINGATAN  Workspace"))).toBe(true);
});

test("checkpoint: folder ada berisi sesi", async () => {
  await mkdir(join(homeDir, "checkpoints", "s_abcdef12"), { recursive: true, mode: 0o700 });
  await writeFile(join(homeDir, "checkpoints", "s_abcdef12", "index.json"), "[]\n", {
    mode: 0o600,
  });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const checkpoint = find(checks, "Checkpoint");
  expect(checkpoint.status).toBe("ok");
  expect(checkpoint.detail).toContain(join(homeDir, "checkpoints"));
  expect(checkpoint.detail).toContain("1 sesi");
  expect(checkpoint.detail).toMatch(/\d+ KB/);
});

test("checkpoint: folder belum ada", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const checkpoint = find(checks, "Checkpoint");
  expect(checkpoint.status).toBe("ok");
  expect(checkpoint.detail).toContain(join(homeDir, "checkpoints"));
  expect(checkpoint.detail).toContain("0 sesi");
});

test("checkpoint: dimatikan lewat JEJAK_CHECKPOINTS=0 dan tetap exit 0", async () => {
  const logged: string[] = [];
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_CHECKPOINTS: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const checkpoint = find(checks, "Checkpoint");
  expect(checkpoint.status).toBe("peringatan");
  expect(checkpoint.detail).toContain("dimatikan");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir, JEJAK_CHECKPOINTS: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("PERINGATAN  Checkpoint"))).toBe(true);
});

test("server MCP: berkas belum ada", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const mcp = find(checks, "Server MCP");
  expect(mcp.status).toBe("ok");
  expect(mcp.detail).toContain(join(homeDir, "mcp-servers.json"));
  expect(mcp.detail).toContain("belum ada");
});

test("server MCP: jumlah server, aktif, dan izin 600", async () => {
  const { McpServerService } = await import("../src/server/mcp/mcp-service");
  const service = new McpServerService({ path: join(homeDir, "mcp-servers.json") });
  await service.create({ name: "github", transport: "stdio", command: "npx" });
  await service.create({
    name: "remote",
    transport: "http",
    url: "https://mcp.test/sse",
    headers: { Authorization: "Bearer rahasia-header-jangan-bocor" },
  });
  await service.update(
    (await service.list()).items.find((item) => item.name === "remote")!.id,
    { enabled: false },
  );

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const mcp = find(checks, "Server MCP");
  expect(mcp.status).toBe("ok");
  expect(mcp.detail).toContain("2 server");
  expect(mcp.detail).toContain("1 aktif");
  expect(mcp.detail).toContain("izin 600");
  expect(JSON.stringify(checks)).not.toContain("rahasia-header-jangan-bocor");
});

test("server MCP: izin longgar dan berkas rusak memberi peringatan", async () => {
  const { McpServerService } = await import("../src/server/mcp/mcp-service");
  const file = join(homeDir, "mcp-servers.json");
  const service = new McpServerService({ path: file });
  await service.create({ name: "github", transport: "stdio", command: "npx" });
  await chmod(file, 0o644);

  const loose = find(
    await collect({
      env: { JEJAK_HOME: homeDir },
      providersPath: providersFile,
      resolveSdk: () => null,
    }),
    "Server MCP",
  );
  expect(loose.status).toBe("peringatan");
  expect(loose.detail).toContain("chmod 600");

  await writeFile(file, "{ rusak", { mode: 0o600 });
  const broken = find(
    await collect({
      env: { JEJAK_HOME: homeDir },
      providersPath: providersFile,
      resolveSdk: () => null,
    }),
    "Server MCP",
  );
  expect(broken.status).toBe("peringatan");
  expect(broken.detail).toContain("rusak");
});

test("server MCP: dimatikan lewat JEJAK_MCP_SERVERS=0 dan tetap exit 0", async () => {
  const logged: string[] = [];
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_MCP_SERVERS: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const mcp = find(checks, "Server MCP");
  expect(mcp.status).toBe("peringatan");
  expect(mcp.detail).toContain("dimatikan");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir, JEJAK_MCP_SERVERS: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("PERINGATAN  Server MCP"))).toBe(true);
});

test("pemasangan: root paket dengan bin ditemukan berstatus ok", async () => {
  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => "/opt/sdk/index.js",
  });
  const install = find(checks, "Pemasangan");
  expect(install.status).toBe("ok");
  expect(install.detail).toContain("src/cli/index.ts");
  expect(install.detail).toContain(`Bun ${Bun.version}`);
  expect(install.detail).toContain("SDK terpasang");
});

test("pemasangan: package.json tidak terbaca memberi peringatan", async () => {
  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    packageRoot: join(root, "tidak-ada"),
  });
  const install = find(checks, "Pemasangan");
  expect(install.status).toBe("peringatan");
  expect(install.detail).toContain("tidak terbaca");
});

test("sandbox: tersedia berstatus ok", async () => {
  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    sandbox: () => ({ ok: true, detail: "sandbox-exec tersedia" }),
  });
  const sandbox = find(checks, "Sandbox");
  expect(sandbox.status).toBe("ok");
  expect(sandbox.detail).toBe("sandbox-exec tersedia");
});

test("sandbox: tidak tersedia berstatus peringatan", async () => {
  const checks = await collect({
    env: {},
    providersPath: providersFile,
    resolveSdk: () => null,
    sandbox: () => ({ ok: false, detail: "bwrap tidak ditemukan" }),
  });
  const sandbox = find(checks, "Sandbox");
  expect(sandbox.status).toBe("peringatan");
  expect(sandbox.detail).toContain("bwrap");
});

test("sandbox: JEJAK_SANDBOX=0 berstatus ok dimatikan", async () => {
  const checks = await collect({
    env: { JEJAK_SANDBOX: "0" },
    providersPath: providersFile,
    resolveSdk: () => null,
    sandbox: () => ({ ok: false, detail: "tidak dipanggil" }),
  });
  const sandbox = find(checks, "Sandbox");
  expect(sandbox.status).toBe("ok");
  expect(sandbox.detail).toContain("dimatikan");
  expect(sandbox.detail).not.toContain("tidak dipanggil");
});

test("mode binary: pemasangan memakai execPath dan runtime Bun tertanam", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    isCompiled: () => true,
    execPath: "/x/jejak",
  });

  const install = find(checks, "Pemasangan");
  expect(install.status).toBe("ok");
  expect(install.detail).toContain("/x/jejak");
  expect(install.detail).toContain(`Jejak ${VERSION}`);
  expect(install.detail).toContain(`tertanam ${Bun.version}`);
  expect(install.detail).toContain(homeDir);
  expect(install.detail).not.toContain("package.json tidak terbaca");

  const runtime = find(checks, "Runtime Bun");
  expect(runtime.status).toBe("ok");
  expect(runtime.detail).toBe(`tertanam ${Bun.version}`);
  expect(labels(checks).includes("Bun >= 1.4")).toBe(false);
});

test("mode binary: package.json rusak tidak mengubah cek pemasangan", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    isCompiled: () => true,
    execPath: "/x/jejak",
    packageRoot: join(root, "tidak-ada"),
  });
  const install = find(checks, "Pemasangan");
  expect(install.status).toBe("ok");
  expect(install.detail).not.toContain("tidak terbaca");
});

test("sdk terkelola terpasang berstatus ok dengan versi dan sebelumnya", async () => {
  const sdkDir = join(root, "sdk-terkelola");
  await pasangSdk(sdkDir, "1.0.0");
  await pasangSdk(sdkDir, "1.2.3");

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    isCompiled: () => true,
    sdkRoot: sdkDir,
  });

  const sdk = find(checks, "Claude Agent SDK");
  expect(sdk.status).toBe("ok");
  expect(sdk.detail).toContain("terkelola versi 1.2.3");
  expect(sdk.detail).toContain(sdkDir);
  expect(sdk.detail).toContain("(sebelumnya 1.0.0)");
});

test("sdk terkelola rusak memberi peringatan pasang ulang", async () => {
  const sdkDir = join(root, "sdk-rusak");
  await pasangSdk(sdkDir, "1.0.0");
  await rm(join(sdkDir, "1.0.0"), { recursive: true, force: true });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    isCompiled: () => true,
    sdkRoot: sdkDir,
  });

  const sdk = find(checks, "Claude Agent SDK");
  expect(sdk.status).toBe("peringatan");
  expect(sdk.detail).toContain("rusak");
  expect(sdk.detail).toContain("Pengaturan");
});

test("binary tanpa sdk terkelola memberi peringatan arahkan ke Pengaturan", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    isCompiled: () => true,
    sdkRoot: join(root, "sdk-kosong"),
  });

  const sdk = find(checks, "Claude Agent SDK");
  expect(sdk.status).toBe("peringatan");
  expect(sdk.detail).toContain("belum terpasang");
  expect(sdk.detail).toContain("Pasang");
});

test("mode dev tanpa sdk terkelola memakai resolveSdk lama", async () => {
  const found = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => "/opt/sdk/index.js",
    sdkRoot: join(root, "sdk-kosong"),
  });
  expect(find(found, "Claude Agent SDK").detail).toBe("/opt/sdk/index.js");

  const missing = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    sdkRoot: join(root, "sdk-kosong"),
  });
  const sdk = find(missing, "Claude Agent SDK");
  expect(sdk.status).toBe("peringatan");
  expect(sdk.detail).toContain("belum terpasang");
});

test("claude cli ditemukan dari env berstatus ok dengan label sumber", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir, JEJAK_CLAUDE_PATH: "/x/claude" },
    providersPath: providersFile,
    resolveSdk: () => null,
    locate: {
      which: () => null,
      exists: async () => true,
      runVersion: async () => "1.2.3",
    },
  });

  const cli = find(checks, "Claude CLI");
  expect(cli.status).toBe("ok");
  expect(cli.detail).toContain("/x/claude");
  expect(cli.detail).toContain("1.2.3");
  expect(cli.detail).toContain("sumber JEJAK_CLAUDE_PATH");
});

test("claude cli ditemukan dari PATH berstatus ok dengan label sumber", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    locate: {
      which: () => "/usr/local/bin/claude",
      exists: async () => true,
      runVersion: async () => "2.0.0",
    },
  });

  const cli = find(checks, "Claude CLI");
  expect(cli.status).toBe("ok");
  expect(cli.detail).toContain("/usr/local/bin/claude");
  expect(cli.detail).toContain("sumber PATH");
});

test("claude cli tidak ditemukan memberi peringatan dan exit code tetap 0", async () => {
  const logged: string[] = [];
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const cli = find(checks, "Claude CLI");
  expect(cli.status).toBe("peringatan");
  expect(cli.detail).toContain("tidak ditemukan");
  expect(cli.detail).toContain("JEJAK_CLAUDE_PATH");

  const code = await doctor({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(0);
  expect(logged.some((line) => line.includes("PERINGATAN  Claude CLI"))).toBe(true);
});

test("claude cli dari CLI bawaan SDK menampilkan label sumber terkelola", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    locate: {
      which: () => null,
      exists: async () => true,
      runVersion: async () => "2.1.0",
      managed: async () => ({ path: "/sdk/cli/claude", version: "2.1.0" }),
    },
  });

  const cli = find(checks, "Claude CLI");
  expect(cli.status).toBe("ok");
  expect(cli.detail).toContain("/sdk/cli/claude");
  expect(cli.detail).toContain("CLI bawaan SDK (terkelola)");
});

test("claude cli tidak ditemukan menawarkan CLI bawaan SDK di Pengaturan", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const cli = find(checks, "Claude CLI");
  expect(cli.detail).toContain("pasang CLI bawaan SDK di Pengaturan");
});

test("versi data: belum ada data berstatus ok", async () => {
  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("ok");
  expect(versi.detail).toContain(homeDir);
});

test("versi data: versi sama dengan aplikasi berstatus ok", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(homeDir, "data-version.json"),
    `${JSON.stringify({ appVersion: VERSION, updatedAt: "2026-11-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("ok");
  expect(versi.detail).toContain(VERSION);
});

test("versi data: data lebih lama memberi peringatan dan tak mengubah data", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const file = join(homeDir, "data-version.json");
  await writeFile(
    file,
    `${JSON.stringify({ appVersion: "0.0.0", updatedAt: "2026-11-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );
  const sebelum = await readFile(file, "utf8");

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("peringatan");
  expect(versi.detail).toContain("lebih lama");
  expect(await readFile(file, "utf8")).toBe(sebelum);
});

test("versi data: data lebih baru memberi gagal dan exit 1", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(homeDir, "data-version.json"),
    `${JSON.stringify({ appVersion: "99.0.0", updatedAt: "2026-11-01T00:00:00.000Z" })}\n`,
    { mode: 0o600 },
  );

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });
  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("gagal");
  expect(versi.detail).toContain("lebih baru");

  const logged: string[] = [];
  const code = await doctor({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
    log: (line) => logged.push(line),
  });
  expect(code).toBe(1);
  expect(logged.some((line) => line.includes("GAGAL  Versi data"))).toBe(true);
});

test("versi data: berkas rusak memberi peringatan", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(homeDir, "data-version.json"), "{ rusak", { mode: 0o600 });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("peringatan");
  expect(versi.detail).toContain("rusak");
});

test("versi data: berkas versi belum ada tapi data ada memberi peringatan", async () => {
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(homeDir, "sessions.db"), "bukan db", { mode: 0o600 });

  const checks = await collect({
    env: { JEJAK_HOME: homeDir },
    providersPath: providersFile,
    resolveSdk: () => null,
  });

  const versi = find(checks, "Versi data");
  expect(versi.status).toBe("peringatan");
  expect(versi.detail).toContain("belum ada");
});
