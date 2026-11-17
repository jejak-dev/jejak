import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import type { ResolvedProvider } from "../src/server/provider";
import { FileCommandEnvStore } from "../src/server/security/command-env-store";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let root: string;
let project: string;
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "jejak-command-env-rute-")));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".env"), "DB_HOST=localhost\nDB_PASSWORD=rahasia-panjang\n");
});

afterEach(async () => {
  for (const store of audits) store.close();
  audits = [];
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function runner(): AgentRunner {
  return {
    async *run() {
      yield { type: "result", ok: true } as AgentEvent;
    },
  };
}

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

async function setup(options: { store?: FileCommandEnvStore | false; audit?: AuditStore } = {}) {
  const store =
    options.store === false ? undefined : options.store ?? new FileCommandEnvStore(":memory:");
  const manager = new SessionManager({
    runner: runner(),
    resolveProvider: async () => PROVIDER,
  });
  const app = createApp({
    sessions: manager,
    runner: runner(),
    env: { MOCK: "true", JEJAK_HOME: join(root, "home") },
    ...(store === undefined ? {} : { commandEnv: store }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  const info = await manager.create({ prompt: "Halo", cwd: project });
  await manager.done(info.id);
  return { app, manager, store, id: info.id };
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

function entries(store: AuditStore, kind: AuditEntry["kind"]): AuditEntry[] {
  return store.list({ kind, limit: 200 });
}

describe("rute env perintah", () => {
  test("GET kosong, PUT lalu GET, DELETE", async () => {
    const { app, id } = await setup();
    const url = `/api/sessions/${id}/command-env`;

    const empty = await req(app, "GET", url);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ keys: [] });

    const file = join(project, ".env");
    const put = await req(app, "PUT", url, { path: file });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ path: file, keys: ["DB_HOST", "DB_PASSWORD"] });

    const listed = await req(app, "GET", url);
    const payload = (await listed.json()) as { path: string; keys: string[] };
    expect(payload.path).toBe(file);
    expect(payload.keys).toEqual(["DB_HOST", "DB_PASSWORD"]);
    // Nilai tak pernah keluar.
    expect(JSON.stringify(payload)).not.toContain("rahasia-panjang");

    const removed = await req(app, "DELETE", url, {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(await (await req(app, "GET", url)).json()).toEqual({ keys: [] });
  });

  test("validasi 400", async () => {
    const { app, id } = await setup();
    const url = `/api/sessions/${id}/command-env`;
    for (const body of [
      { path: ".env" },
      { path: join(root, "tidak-ada.env") },
      { path: project },
      { path: join(project, ".env"), lain: true },
      "bukan json",
      "[1]",
      {},
    ]) {
      const res = await req(app, "PUT", url, body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(typeof payload.error).toBe("string");
    }
  });

  test("404 sesi tak ada", async () => {
    const { app } = await setup();
    expect((await req(app, "GET", "/api/sessions/tidak-ada/command-env")).status).toBe(404);
    const put = await req(app, "PUT", "/api/sessions/tidak-ada/command-env", {
      path: join(project, ".env"),
    });
    expect(put.status).toBe(404);
  });

  test("503 tanpa store", async () => {
    const { app, id } = await setup({ store: false });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await req(
        app,
        method,
        `/api/sessions/${id}/command-env`,
        method === "GET" ? undefined : { path: join(project, ".env") },
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Env perintah dimatikan." });
    }
  });

  test("audit tanpa nilai", async () => {
    const audit = auditStore();
    const { app, id } = await setup({ audit });
    const url = `/api/sessions/${id}/command-env`;
    await req(app, "PUT", url, { path: join(project, ".env") });
    await req(app, "DELETE", url, {});

    const list = entries(audit, "pengaturan");
    const aksi = list.map((item) => item.meta?.aksi);
    expect(aksi).toContain("env-perintah-diatur");
    expect(aksi).toContain("env-perintah-dihapus");
    expect(JSON.stringify(list)).not.toContain("rahasia-panjang");
  });
});
