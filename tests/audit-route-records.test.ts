import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { createMockRunner } from "../src/server/agent";
import { CheckpointService } from "../src/server/checkpoints/checkpoint-service";
import { WorktreeService } from "../src/server/git/worktree-service";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { McpServerService } from "../src/server/mcp/mcp-service";
import { resolveProvider as resolveRegistryProvider } from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";
import { SessionManager } from "../src/server/sessions/session-manager";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

const ENV_SENTINEL = "rahasia-env-jangan-bocor";
const HEADER_SENTINEL = "rahasia-header-jangan-bocor";
const KEY_SENTINEL = "sk-test-sintetis-jangan-bocor";
const COMMIT_SENTINEL = "pesan-commit-sintetis-jangan-bocor";
const TITLE_SENTINEL = "judul-sesi-sintetis-jangan-bocor";

let root: string;
let home: string;
let dir: string;
let providersFile: string;
let auditStores: AuditStore[] = [];
let closers: Array<{ close(): void }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-audit-rute-"));
  home = join(root, "home");
  dir = join(root, "kerja");
  await mkdir(dir, { recursive: true });
  providersFile = join(root, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
});

afterEach(async () => {
  for (const store of auditStores) store.close();
  auditStores = [];
  for (const closer of closers) closer.close();
  closers = [];
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  auditStores.push(store);
  return store;
}

function manager(): SessionManager {
  return new SessionManager({
    runner: createMockRunner(),
    resolveProvider: async (selection) =>
      resolveRegistryProvider(await loadRegistry(providersFile, { MOCK: "true" }), selection),
    worktrees: new WorktreeService({ root: join(home, "worktrees") }),
  });
}

function makeApp(mgr: SessionManager, extra: Partial<CreateAppOptions> = {}): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    sessions: mgr,
    undoDir: join(home, "undo"),
    worktrees: new WorktreeService({ root: join(home, "worktrees") }),
    ...extra,
  });
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function idleSession(mgr: SessionManager, cwd: string): Promise<string> {
  const info = await mgr.create({ prompt: "Halo", cwd });
  await mgr.done(info.id);
  return info.id;
}

function entries(store: AuditStore): AuditEntry[] {
  return store.list({ limit: 200 });
}

function only(store: AuditStore, kind: AuditEntry["kind"], summary: string): AuditEntry {
  const found = entries(store).filter((entry) => entry.kind === kind && entry.summary === summary);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal`);
  return out;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main", "."]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "user.email", "t@t"]);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "--allow-empty", "-m", "awal"]);
}

describe("audit rute berkas", () => {
  test("simpan lewat editor mencatat path relatif", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    const res = await req(app, "PUT", `/api/sessions/${id}/file`, {
      path: "a.txt",
      content: "baru\n",
      baseVersion: sha256("lama\n"),
    });
    expect(res.status).toBe(200);
    const entry = only(store, "berkas", "Berkas disimpan lewat editor");
    expect(entry.sessionId).toBe(id);
    expect(entry.meta).toEqual({ path: "a.txt", aksi: "simpan" });
  });

  test("simpan gagal 404 tidak mencatat", async () => {
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    const res = await req(app, "PUT", `/api/sessions/${id}/file`, {
      path: "tidak-ada.txt",
      content: "baru\n",
      baseVersion: "0".repeat(64),
    });
    expect(res.status).toBe(404);
    expect(entries(store)).toHaveLength(0);
  });

  test("tolak dan urungkan perubahan mencatat path dan scope", async () => {
    await writeFile(join(dir, "a.txt"), "awal\n");
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "berubah\n");
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    const changes = (await (await req(app, "GET", `/api/sessions/${id}/changes`)).json()) as {
      files: Array<{ path: string; diffId: string }>;
    };
    const diff = changes.files.find((file) => file.path === "a.txt")!;
    const rejected = await req(app, "POST", `/api/sessions/${id}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId: diff.diffId,
    });
    expect(rejected.status).toBe(200);
    const { undoId } = (await rejected.json()) as { undoId: string };

    const undone = await req(app, "POST", `/api/sessions/${id}/changes/undo`, { undoId });
    expect(undone.status).toBe(200);

    const tolak = only(store, "berkas", "Perubahan ditolak");
    expect(tolak.sessionId).toBe(id);
    expect(tolak.meta).toEqual({ path: "a.txt", scope: "file", aksi: "tolak" });
    const urungkan = only(store, "berkas", "Penolakan diurungkan");
    expect(urungkan.sessionId).toBe(id);
    expect(urungkan.meta).toEqual({ path: "a.txt", aksi: "urungkan" });
  });

  test("checkpoint manual dan rewind dicatat", async () => {
    const store = auditStore();
    const mgr = manager();
    const checkpoints = new CheckpointService({ root: join(home, "checkpoints") });
    const app = makeApp(mgr, { audit: store, checkpoints });
    const id = await idleSession(mgr, dir);
    await writeFile(join(dir, "a.txt"), "awal\n");

    const created = await req(app, "POST", `/api/sessions/${id}/checkpoints`, { label: "tes" });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    await writeFile(join(dir, "a.txt"), "baru\n");
    const rewound = await req(
      app,
      "POST",
      `/api/sessions/${id}/checkpoints/${item.id}/rewind`,
      { confirm: true },
    );
    expect(rewound.status).toBe(200);

    const manual = only(store, "berkas", "Checkpoint manual dibuat");
    expect(manual.sessionId).toBe(id);
    expect(manual.meta).toEqual({ aksi: "checkpoint" });
    const rewind = only(store, "berkas", "Rewind ke checkpoint");
    expect(rewind.sessionId).toBe(id);
    expect(rewind.meta).toEqual({ checkpoint: item.id.slice(0, 12), aksi: "rewind" });
  });
});

describe("audit rute git", () => {
  test("stage, unstage, dan commit tanpa pesan commit", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "satu\n");
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    expect((await req(app, "POST", `/api/sessions/${id}/git/stage`, { paths: ["a.txt"] })).status).toBe(200);
    expect((await req(app, "POST", `/api/sessions/${id}/git/unstage`, { paths: ["a.txt"] })).status).toBe(200);
    expect((await req(app, "POST", `/api/sessions/${id}/git/stage`, { all: true })).status).toBe(200);
    const committed = await req(app, "POST", `/api/sessions/${id}/git/commit`, {
      message: COMMIT_SENTINEL,
    });
    expect(committed.status).toBe(200);
    const { short } = (await committed.json()) as { short: string };

    const stage = entries(store).filter((entry) => entry.kind === "git" && entry.summary === "Stage");
    expect(stage).toHaveLength(2);
    expect(stage.map((entry) => entry.meta)).toEqual(
      expect.arrayContaining([
        { aksi: "stage", jumlah: 1 },
        { aksi: "stage", jumlah: "semua" },
      ]),
    );
    const unstage = only(store, "git", "Unstage");
    expect(unstage.meta).toEqual({ aksi: "unstage", jumlah: 1 });
    const commit = only(store, "git", "Commit dibuat");
    expect(commit.meta).toEqual({ aksi: "commit", hash: short });
    expect(JSON.stringify(entries(store))).not.toContain(COMMIT_SENTINEL);
  });

  test("stage gagal 400 tidak mencatat", async () => {
    await initRepo(dir);
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    const res = await req(app, "POST", `/api/sessions/${id}/git/stage`, { paths: [] });
    expect(res.status).toBe(400);
    expect(entries(store)).toHaveLength(0);
  });

  test("worktree dibuat, dihapus, dan dipulihkan", async () => {
    await initRepo(dir);
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });

    const created = await req(app, "POST", "/api/sessions", {
      prompt: "Halo",
      cwd: dir,
      worktree: true,
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    await mgr.done(session.id);

    const removed = await req(app, "DELETE", `/api/sessions/${session.id}/worktree`, {});
    expect(removed.status).toBe(200);
    const restored = await req(app, "POST", `/api/sessions/${session.id}/worktree/restore`, {});
    expect(restored.status).toBe(200);

    const make = only(store, "git", "Worktree dibuat");
    expect(make.sessionId).toBe(session.id);
    expect(make.meta).toEqual({ aksi: "worktree-buat" });
    const remove = only(store, "git", "Worktree dihapus");
    expect(remove.sessionId).toBe(session.id);
    expect(remove.meta).toEqual({ aksi: "worktree-hapus", paksa: false });
    const restore = only(store, "git", "Worktree dipulihkan");
    expect(restore.sessionId).toBe(session.id);
    expect(restore.meta).toEqual({ aksi: "worktree-pulihkan" });
  });
});

describe("audit rute mcp", () => {
  test("tambah, ubah, dan hapus tanpa env/header", async () => {
    const store = auditStore();
    const service = new McpServerService({ path: join(home, "mcp-servers.json") });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      mcpServers: service,
      audit: store,
    });

    const created = await req(app, "POST", "/api/mcp-servers", {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: ENV_SENTINEL },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string; name: string } };

    expect(
      (await req(app, "PATCH", `/api/mcp-servers/${item.id}`, { name: "github-2" })).status,
    ).toBe(200);
    expect((await req(app, "DELETE", `/api/mcp-servers/${item.id}`, {})).status).toBe(200);

    const add = only(store, "mcp", "Server MCP ditambah");
    expect(add.meta).toEqual({ aksi: "tambah", id: item.id, nama: "github" });
    const edit = only(store, "mcp", "Server MCP diubah");
    expect(edit.meta).toEqual({ aksi: "ubah", id: item.id, nama: "github-2" });
    const remove = only(store, "mcp", "Server MCP dihapus");
    expect(remove.meta).toEqual({ aksi: "hapus", id: item.id });
    expect(JSON.stringify(entries(store))).not.toContain(ENV_SENTINEL);
    expect(JSON.stringify(entries(store))).not.toContain(HEADER_SENTINEL);
  });
});

describe("audit rute pengaturan", () => {
  test("provider diperbarui dan aktif diganti tanpa kunci", async () => {
    const store = auditStore();
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      audit: store,
    });

    const registry = {
      profiles: [
        { id: "alpha", name: "Alpha", baseUrl: "https://alpha.test", apiKey: KEY_SENTINEL, models: [{ id: "m1" }] },
        { id: "beta", name: "Beta", baseUrl: "https://beta.test", apiKey: KEY_SENTINEL, models: [{ id: "m2" }] },
      ],
      activeProfileId: "alpha",
    };
    expect((await req(app, "PUT", "/api/providers", registry)).status).toBe(200);
    expect(
      (await req(app, "POST", "/api/providers/active", { profileId: "beta" })).status,
    ).toBe(200);

    const put = only(store, "pengaturan", "Provider diperbarui");
    expect(put.meta).toEqual({ aksi: "perbarui" });
    const active = only(store, "pengaturan", "Provider aktif diganti");
    expect(active.meta).toEqual({ aksi: "aktif" });
    expect(JSON.stringify(entries(store))).not.toContain(KEY_SENTINEL);
  });

  test("workspace ditambah dan dihapus", async () => {
    const store = auditStore();
    const service = new WorkspaceService({ dir: join(home, "workspaces") });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      workspaces: service,
      audit: store,
    });

    const created = await req(app, "POST", "/api/workspaces", { name: "Kantor" });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    expect((await req(app, "DELETE", `/api/workspaces/${item.id}`, {})).status).toBe(200);

    const add = only(store, "pengaturan", "Workspace ditambah");
    expect(add.meta).toEqual({ aksi: "tambah", id: item.id });
    const remove = only(store, "pengaturan", "Workspace dihapus");
    expect(remove.meta).toEqual({ aksi: "hapus", id: item.id });
  });

  test("workspace diubah dan kartu service diubah", async () => {
    await mkdir(join(root, "repo"), { recursive: true });
    const store = auditStore();
    const service = new WorkspaceService({ dir: join(home, "workspaces") });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      workspaces: service,
      audit: store,
    });

    const created = await req(app, "POST", "/api/workspaces", {
      name: "Kantor",
      repos: [{ name: "api", path: join(root, "repo") }],
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    expect(
      (await req(app, "PATCH", `/api/workspaces/${item.id}`, { name: "Kantor Baru" })).status,
    ).toBe(200);
    expect(
      (
        await req(app, "PUT", `/api/workspaces/${item.id}/repos/api/card`, {
          description: "API kantor",
        })
      ).status,
    ).toBe(200);

    const edit = entries(store).find(
      (entry) => entry.summary === "Workspace diubah",
    );
    expect(edit?.meta).toEqual({ aksi: "ubah", id: item.id });
    const card = entries(store).find(
      (entry) => entry.summary === "Kartu service diubah",
    );
    expect(card?.meta).toEqual({ aksi: "kartu", id: item.id });
  });

  test("sesi ganti nama dan hapus tanpa judul", async () => {
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    expect(
      (await req(app, "PATCH", `/api/sessions/${id}`, { title: TITLE_SENTINEL })).status,
    ).toBe(200);
    expect((await req(app, "DELETE", `/api/sessions/${id}`, {})).status).toBe(200);

    const rename = only(store, "pengaturan", "Sesi diganti nama");
    expect(rename.sessionId).toBe(id);
    expect(rename.meta).toEqual({ aksi: "ganti-nama" });
    const remove = only(store, "pengaturan", "Sesi dihapus");
    expect(remove.sessionId).toBe(id);
    expect(remove.meta).toEqual({ aksi: "hapus" });
    expect(JSON.stringify(entries(store))).not.toContain(TITLE_SENTINEL);
  });

  test("mode izin sesi diganti lewat PATCH, dicatat, dan bypass ditolak", async () => {
    const store = auditStore();
    const mgr = manager();
    const app = makeApp(mgr, { audit: store });
    const id = await idleSession(mgr, dir);

    const ok = await req(app, "PATCH", `/api/sessions/${id}`, { permissionMode: "plan" });
    expect(ok.status).toBe(200);
    expect(mgr.get(id)?.permissionMode).toBe("plan");
    const entry = only(store, "pengaturan", "Mode izin sesi diganti");
    expect(entry.meta).toEqual({ aksi: "ganti-mode", mode: "plan" });

    expect(
      (await req(app, "PATCH", `/api/sessions/${id}`, { permissionMode: "bypassPermissions" })).status,
    ).toBe(400);
    expect((await req(app, "PATCH", `/api/sessions/${id}`, { permissionMode: 5 })).status).toBe(400);
    expect(mgr.get(id)?.permissionMode).toBe("plan");
  });

  test("memory ditambah, diubah, dan dihapus tanpa isi", async () => {
    const store = auditStore();
    const memoryStore = new FileMemoryStore({ dir: join(home, "memory") });
    closers.push(memoryStore);
    const memory = new MemoryService({ store: memoryStore, cwd: dir });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      memory,
      audit: store,
    });

    const created = await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "Judul rahasia sintetis",
      body: "Isi rahasia sintetis",
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    expect((await req(app, "PATCH", `/api/memory/${item.id}`, { title: "Baru" })).status).toBe(200);
    expect((await req(app, "DELETE", `/api/memory/${item.id}`, {})).status).toBe(200);

    const add = only(store, "pengaturan", "Memory ditambah");
    expect(add.meta).toEqual({ aksi: "ditambah", id: item.id });
    const edit = only(store, "pengaturan", "Memory diubah");
    expect(edit.meta).toEqual({ aksi: "diubah", id: item.id });
    const remove = only(store, "pengaturan", "Memory dihapus");
    expect(remove.meta).toEqual({ aksi: "dihapus", id: item.id });
    expect(JSON.stringify(entries(store))).not.toContain("Isi rahasia sintetis");
    expect(JSON.stringify(entries(store))).not.toContain("Judul rahasia sintetis");
  });
});

describe("tanpa audit", () => {
  test("rute berperilaku seperti dulu", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const mgr = manager();
    const app = makeApp(mgr);
    const id = await idleSession(mgr, dir);

    const res = await req(app, "PUT", `/api/sessions/${id}/file`, {
      path: "a.txt",
      content: "baru\n",
      baseVersion: sha256("lama\n"),
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { ok: boolean; version: string; size: number },
    ).toEqual({
      ok: true,
      version: sha256("baru\n"),
      size: Buffer.byteLength("baru\n"),
    });
  });
});
