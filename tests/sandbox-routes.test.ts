import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { DEFAULT_ALLOWED_DOMAINS } from "../src/server/sandbox/build-options";
import { FileSandboxStore } from "../src/server/sandbox/sandbox-config";

let root: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-sandbox-rute-"));
});

afterEach(async () => {
  for (const store of audits.splice(0)) store.close();
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function setup(options: { store?: FileSandboxStore | false; audit?: AuditStore } = {}): App {
  const store = options.store === false ? undefined : options.store ?? new FileSandboxStore(":memory:");
  return createApp({
    env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
    ...(store === undefined ? {} : { sandbox: store }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function entries(store: AuditStore): AuditEntry[] {
  return store.list({ kind: "pengaturan", limit: 200 });
}

describe("rute sandbox", () => {
  test("GET mengembalikan config, defaults, dan ketersediaan", async () => {
    const app = setup();
    const payload = await json(await req(app, "GET", "/api/sandbox"));
    expect(payload.config).toEqual({
      mode: "standar",
      allowedDomains: [],
      extraDenyRead: [],
      extraDenyWrite: [],
      extraAllowWrite: [],
      extraAllowUnixSockets: [],
      allowLocalBinding: false,
    });
    expect(payload.defaults).toMatchObject({
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      denyRead: expect.arrayContaining([".ssh"]),
      denyWrite: expect.arrayContaining([".git/hooks"]),
    });
    expect(typeof (payload.available as { ok: unknown }).ok).toBe("boolean");
  });

  test("PUT memperbarui config dan mengembalikannya", async () => {
    const app = setup();
    const res = await req(app, "PUT", "/api/sandbox", {
      mode: "mati",
      allowedDomains: ["b.test", "a.test"],
      extraDenyRead: ["~/x"],
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      config: {
        mode: "mati",
        allowedDomains: ["a.test", "b.test"],
        extraDenyRead: ["~/x"],
        extraDenyWrite: [],
        extraAllowWrite: [],
        extraAllowUnixSockets: [],
        allowLocalBinding: false,
      },
    });
    const after = await json(await req(app, "GET", "/api/sandbox"));
    expect((after.config as { mode: string }).mode).toBe("mati");
  });

  test("PUT menyimpan pelonggaran dan audit mencatat aksi sandbox-longgar", async () => {
    const audit = auditStore();
    const app = setup({ audit });
    const res = await req(app, "PUT", "/api/sandbox", {
      extraAllowWrite: ["~/tmp"],
      extraAllowUnixSockets: ["/var/run/docker.sock"],
      allowLocalBinding: true,
    });
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect((payload.config as { extraAllowWrite: string[] }).extraAllowWrite).toEqual(["~/tmp"]);
    expect(
      (payload.config as { extraAllowUnixSockets: string[] }).extraAllowUnixSockets,
    ).toEqual(["/var/run/docker.sock"]);
    expect((payload.config as { allowLocalBinding: boolean }).allowLocalBinding).toBe(true);

    const after = await json(await req(app, "GET", "/api/sandbox"));
    expect((after.config as { extraAllowWrite: string[] }).extraAllowWrite).toEqual(["~/tmp"]);

    const entry = entries(audit).find((item) => item.meta.aksi === "sandbox-longgar");
    expect(entry?.meta).toMatchObject({
      allowWrite: 1,
      unixSockets: 1,
      localBinding: true,
      aksi: "sandbox-longgar",
    });
  });

  test("PUT menolak 400 field asing, domain buruk, jalur relatif, mode tak dikenal", async () => {
    const app = setup();
    for (const body of [
      {},
      { lain: true },
      { allowedDomains: ["https://x.test"] },
      { extraDenyRead: ["relatif"] },
      { extraDenyWrite: ["../naik"] },
      { extraAllowWrite: ["/"] },
      { extraAllowUnixSockets: ["/tmp/*.sock"] },
      { allowLocalBinding: "ya" },
      { extraAllowUnixSockets: "bukan daftar" },
      { mode: "nyala" },
      "bukan json",
      "[1]",
    ]) {
      const res = await req(app, "PUT", "/api/sandbox", body);
      expect(res.status).toBe(400);
      expect(typeof (await json(res)).error).toBe("string");
    }
  });

  test("503 tanpa store", async () => {
    const app = setup({ store: false });
    for (const method of ["GET", "PUT"]) {
      const res = await req(app, method, "/api/sandbox", method === "PUT" ? {} : undefined);
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "Sandbox dimatikan." });
    }
  });

  test("audit mencatat jumlah saja, tanpa isi jalur", async () => {
    const audit = auditStore();
    const app = setup({ audit });
    await req(app, "PUT", "/api/sandbox", {
      allowedDomains: ["a.test", "b.test"],
      extraDenyRead: ["/rahasia/sangat/panjang"],
      extraDenyWrite: ["~/kunci"],
    });
    await req(app, "PUT", "/api/sandbox", { mode: "mati" });

    const all = entries(audit);
    const summaries = all.map((entry) => entry.summary);
    expect(summaries).toEqual([
      "Pengaturan sandbox diubah",
      "Pengaturan sandbox diubah",
    ]);
    const changed = all.find((entry) => entry.meta.aksi === "sandbox-mati-global");
    expect(changed?.meta).toMatchObject({ mode: "mati" });
    const first = all.find((entry) => entry.meta.aksi === undefined);
    expect(first?.meta).toMatchObject({ mode: "standar", domain: 2, denyRead: 1, denyWrite: 1 });
    for (const entry of all) {
      const text = `${entry.summary}${JSON.stringify(entry.meta)}`;
      expect(text).not.toContain("/rahasia/sangat/panjang");
      expect(text).not.toContain("kunci");
    }
  });
});
