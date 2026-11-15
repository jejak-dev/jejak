import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { claudeMemoryDir } from "../src/server/memory/claude-memory";

let dir: string;
let claudeRoot: string;
let jejakHome: string;
let projectPath: string;
let projectKey: string;
let store: FileMemoryStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sync-app-"));
  claudeRoot = join(dir, "claude");
  jejakHome = join(dir, "jejak");
  projectPath = join(dir, "proyek");
  await mkdir(projectPath, { recursive: true });
  await mkdir(jejakHome, { recursive: true });
  projectKey = await realpath(projectPath);
});

afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(dir, { recursive: true, force: true });
});

function makeApp(options: Partial<CreateAppOptions> = {}) {
  store = new FileMemoryStore({ dir: join(jejakHome, "memory") });
  const service = new MemoryService({ store, cwd: projectPath });
  return createApp({
    runner: createMockRunner(),
    env: {
      MOCK: "true",
      CLAUDE_CONFIG_DIR: claudeRoot,
      JEJAK_HOME: jejakHome,
    },
    cwd: projectPath,
    memory: service,
    ...options,
  });
}

type App = ReturnType<typeof createApp>;

function call(
  app: App,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const json = method === "GET" || method === "HEAD";
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: {
        host: "127.0.0.1:3000",
        ...(json ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("saklar sinkron di aplikasi", () => {
  test("saklar mati secara bawaan dan tak ada berkas yang ditulis", async () => {
    const app = makeApp();
    const status = await call(app, "GET", "/api/memory/claude/sync");
    expect(await status.json()).toEqual({ enabled: false, locked: false });

    const created = await call(app, "POST", "/api/memory", {
      layer: "project",
      projectKey,
      title: "Gaya kode",
      body: "Gunakan dua spasi.",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { item: { id: string } };
    const memoryDir = claudeMemoryDir(claudeRoot, projectKey);
    expect(await readFile(join(memoryDir, `jejak_${body.item.id}.md`), "utf8").catch(() => null)).toBeNull();
  });

  test("setelah saklar dinyalakan, memory aktif langsung ditulis ke folder Claude", async () => {
    const app = makeApp();
    const put = await call(app, "PUT", "/api/memory/claude/sync", { enabled: true });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ enabled: true, locked: false });

    const created = await call(app, "POST", "/api/memory", {
      layer: "project",
      projectKey,
      title: "Gaya kode",
      body: "Gunakan dua spasi.",
    });
    const body = (await created.json()) as { item: { id: string } };
    const memoryDir = claudeMemoryDir(claudeRoot, projectKey);
    const content = await readFile(join(memoryDir, `jejak_${body.item.id}.md`), "utf8");
    expect(content).toContain(`  jejak_id: ${body.item.id}`);
    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    expect(index).toContain(`(jejak_${body.item.id}.md)`);
  });

  test("sinkron penuh menulis memory aktif yang belum tersinkron", async () => {
    const app = makeApp();
    const created = await call(app, "POST", "/api/memory", {
      layer: "project",
      projectKey,
      title: "Gaya kode",
      body: "Gunakan dua spasi.",
    });
    const body = (await created.json()) as { item: { id: string } };
    await call(app, "PUT", "/api/memory/claude/sync", { enabled: true });
    const run = await call(app, "POST", "/api/memory/claude/sync/run");
    expect(run.status).toBe(200);
    const summary = (await run.json()) as { ditulis: number };
    expect(summary.ditulis).toBe(1);
    const memoryDir = claudeMemoryDir(claudeRoot, projectKey);
    expect(await readFile(join(memoryDir, `jejak_${body.item.id}.md`), "utf8")).toContain(
      `  jejak_id: ${body.item.id}`,
    );
  });
});
