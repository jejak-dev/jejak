import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { FileFeatureStore } from "../src/server/features/feature-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-features-api-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(env: Record<string, string | undefined> = {}) {
  const audit = new SqliteAuditStore(":memory:");
  const app = createApp({
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), ...env },
    audit,
    features: new FileFeatureStore(":memory:"),
  });
  const req = (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { req, audit };
}

describe("rute fitur", () => {
  test("GET mengembalikan status fitur (default mati dan tidak terkunci)", async () => {
    const { req, audit } = setup();
    const jawaban = await req("GET", "/api/features");
    expect(jawaban.status).toBe(200);
    expect(await jawaban.json()).toEqual({
      terminal: { enabled: false, locked: false },
      browser: { enabled: false, locked: false },
    });
    audit.close();
  });

  test("PUT menyalakan fitur dan mencatat audit", async () => {
    const { req, audit } = setup();
    const jawaban = await req("PUT", "/api/features", { terminal: true });
    expect(jawaban.status).toBe(200);
    expect(await jawaban.json()).toEqual({
      terminal: { enabled: true, locked: false },
      browser: { enabled: false, locked: false },
    });
    const isi = audit.list({ kind: "pengaturan", limit: 20 });
    const entri = isi.find((e) => e.summary.includes("terminal"));
    expect(entri).toBeDefined();
    expect(entri?.meta.fitur).toBe("terminal");
    expect(entri?.meta.nilai).toBe(true);
    audit.close();
  });

  test("nilai bukan boolean dan kunci asing ditolak 400", async () => {
    const { req, audit } = setup();
    const salah = await req("PUT", "/api/features", { terminal: "ya" });
    expect(salah.status).toBe(400);
    expect(((await salah.json()) as { error: string }).error).toContain("boolean");
    const asing = await req("PUT", "/api/features", { vault: true });
    expect(asing.status).toBe(400);
    expect(((await asing.json()) as { error: string }).error).toContain("tidak dikenal");
    audit.close();
  });

  test("fitur yang dikunci env ditolak 409 dan menyebut nama env", async () => {
    const { req, audit } = setup({ JEJAK_TERMINAL: "1" });
    const status = await req("GET", "/api/features");
    expect(await status.json()).toEqual({
      terminal: { enabled: true, locked: true },
      browser: { enabled: false, locked: false },
    });
    const tolak = await req("PUT", "/api/features", { terminal: false });
    expect(tolak.status).toBe(409);
    expect(((await tolak.json()) as { error: string }).error).toContain("JEJAK_TERMINAL");
    // Nilai lama tak berubah.
    const setelah = await req("GET", "/api/features");
    expect((await setelah.json()).terminal.enabled).toBe(true);
    audit.close();
  });

  test("terminal berlaku seketika: 503 lalu aktif setelah dinyalakan", async () => {
    const { req, audit } = setup();
    expect((await req("GET", "/api/terminal")).status).toBe(503);
    await req("PUT", "/api/features", { terminal: true });
    expect((await req("GET", "/api/terminal")).status).toBe(200);
    await req("PUT", "/api/features", { terminal: false });
    expect((await req("GET", "/api/terminal")).status).toBe(503);
    audit.close();
  });

  test("browser berlaku seketika: 503 lalu aktif setelah dinyalakan", async () => {
    const { req, audit } = setup();
    expect((await req("GET", "/api/browser")).status).toBe(503);
    await req("PUT", "/api/features", { browser: true });
    expect((await req("GET", "/api/browser")).status).toBe(200);
    await req("PUT", "/api/features", { browser: false });
    expect((await req("GET", "/api/browser")).status).toBe(503);
    audit.close();
  });

  test("terminal yang dibuat dinyalakan kembali setelah dimatikan", async () => {
    const { req, audit } = setup();
    await req("PUT", "/api/features", { terminal: true });
    const hidup = await req("GET", "/api/terminal");
    expect(hidup.status).toBe(200);
    expect(((await hidup.json()) as { terminals: unknown[] }).terminals).toEqual([]);
    await req("PUT", "/api/features", { terminal: false });
    await req("PUT", "/api/features", { terminal: true });
    const hidup2 = await req("GET", "/api/terminal");
    expect(hidup2.status).toBe(200);
    audit.close();
  });

  test("env 0 mematikan terminal walau saklar lain menyala", async () => {
    const { req, audit } = setup({ JEJAK_TERMINAL: "0" });
    const status = await req("GET", "/api/features");
    expect(await status.json()).toEqual({
      terminal: { enabled: false, locked: true },
      browser: { enabled: false, locked: false },
    });
    expect((await req("GET", "/api/terminal")).status).toBe(503);
    audit.close();
  });
});
