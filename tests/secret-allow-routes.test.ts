import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import type { ResolvedProvider } from "../src/server/provider";
import { FileSecretAllowStore } from "../src/server/security/secret-allow-store";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let root: string;
let project: string;
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-secret-allow-rute-")));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".env"), "TOKEN=sintetis\n");
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

async function setup(options: { store?: FileSecretAllowStore | false; audit?: AuditStore } = {}) {
  const allow = options.store === false ? undefined : options.store ?? new FileSecretAllowStore(":memory:");
  const manager = new SessionManager({
    runner: runner(),
    resolveProvider: async () => PROVIDER,
  });
  const app = createApp({
    sessions: manager,
    runner: runner(),
    env: { MOCK: "true", JEJAK_HOME: join(root, "home") },
    ...(allow === undefined ? {} : { secretAllow: allow }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  const info = await manager.create({ prompt: "Halo", cwd: project });
  await manager.done(info.id);
  return { app, manager, allow, id: info.id };
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

describe("rute daftar izin rahasia", () => {
  test("GET kosong, POST lalu GET, DELETE", async () => {
    const { app, id } = await setup();

    const empty = await req(app, "GET", `/api/sessions/${id}/secret-allow`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ root: project, allowed: [] });

    const added = await req(app, "POST", `/api/sessions/${id}/secret-allow`, { path: ".env" });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ path: ".env", rule: ".env", allowed: [".env"] });

    const listed = await req(app, "GET", `/api/sessions/${id}/secret-allow`);
    expect(await listed.json()).toEqual({ root: project, allowed: [".env"] });

    const removed = await req(app, "DELETE", `/api/sessions/${id}/secret-allow`, { path: ".env" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, allowed: [] });
  });

  test("validasi 400", async () => {
    const { app, id } = await setup();
    await writeFile(join(project, "README.md"), "baca\n", "utf8");
    const url = `/api/sessions/${id}/secret-allow`;

    for (const body of [
      { path: "../.env" },
      { path: join(root, ".env") },
      { path: "README.md" },
      { path: ".env", lain: true },
      "bukan json",
      "[1]",
      {},
    ]) {
      const res = await req(app, "POST", url, body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(typeof payload.error).toBe("string");
    }

    const onDelete = await req(app, "DELETE", url, { path: 42 });
    expect(onDelete.status).toBe(400);
    const unknown = await req(app, "DELETE", url, { path: ".env", lain: true });
    expect(unknown.status).toBe(400);
  });

  test("404 sesi tak ada", async () => {
    const { app } = await setup();
    expect((await req(app, "GET", "/api/sessions/tidak-ada/secret-allow")).status).toBe(404);
    const post = await req(app, "POST", "/api/sessions/tidak-ada/secret-allow", { path: ".env" });
    expect(post.status).toBe(404);
  });

  test("503 tanpa store", async () => {
    const { app, id } = await setup({ store: false });
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await req(app, method, `/api/sessions/${id}/secret-allow`, method === "GET" ? undefined : { path: ".env" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Daftar izin rahasia dimatikan." });
    }
  });

  test("audit tepat satu per aksi dengan meta benar", async () => {
    const audit = auditStore();
    const { app, id } = await setup({ audit });

    await req(app, "POST", `/api/sessions/${id}/secret-allow`, { path: ".env" });
    expect(entries(audit, "pengaturan")).toHaveLength(1);

    await req(app, "DELETE", `/api/sessions/${id}/secret-allow`, { path: ".env" });

    const all = entries(audit, "pengaturan");
    expect(all).toHaveLength(2);
    expect(all.find((entry) => entry.summary === "Izin berkas rahasia ditambah")).toMatchObject({
      sessionId: id,
      meta: { aksi: "izinkan-rahasia", path: ".env", aturan: ".env" },
    });
    expect(all.find((entry) => entry.summary === "Izin berkas rahasia dihapus")).toMatchObject({
      sessionId: id,
      meta: { aksi: "cabut-izin-rahasia", path: ".env", aturan: ".env" },
    });
  });
});
