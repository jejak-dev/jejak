import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";

let dir: string;
let providersFile: string;
let store: AuditStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-audit-api-"));
  providersFile = join(dir, "providers.json");
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
  store?.close();
  store = undefined;
  await rm(dir, { recursive: true, force: true });
});

function makeApp(options: Partial<CreateAppOptions> = {}) {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner: createMockRunner(),
    ...options,
  });
}

function makeAuditApp(retentionDays?: number): ReturnType<typeof createApp> {
  store = new SqliteAuditStore(":memory:", {
    ...(retentionDays === undefined ? {} : { retentionDays }),
  });
  return makeApp({ audit: store });
}

type App = ReturnType<typeof createApp>;

function req(
  app: App,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    host: "127.0.0.1:3000",
    "content-type": "application/json",
  };
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

interface AuditEntryBody {
  id: number;
  ts: string;
  sessionId: string | null;
  kind: string;
  summary: string;
  meta: Record<string, unknown>;
}

interface ListBody {
  entries: AuditEntryBody[];
  next: number | null;
}

describe("rute audit aktif", () => {
  test("GET /api/audit mengembalikan entri terbaru dan next", async () => {
    const app = makeAuditApp();
    for (let index = 1; index <= 3; index += 1) {
      store!.append({ kind: "tool", sessionId: "s1", summary: `entri-${index}` });
    }

    const res = await req(app, "GET", "/api/audit?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.entries.map((entry) => entry.summary)).toEqual(["entri-3", "entri-2"]);
    expect(body.next).toBe(body.entries[1]!.id);

    const next = await req(app, "GET", `/api/audit?limit=2&before=${body.next}`);
    const nextBody = (await next.json()) as ListBody;
    expect(nextBody.entries.map((entry) => entry.summary)).toEqual(["entri-1"]);
    expect(nextBody.next).toBeNull();
  });

  test("filter session dan kind", async () => {
    const app = makeAuditApp();
    store!.append({ kind: "tool", sessionId: "s1", summary: "a" });
    store!.append({ kind: "git", sessionId: "s1", summary: "b" });
    store!.append({ kind: "tool", sessionId: "s2", summary: "c" });

    const res = await req(app, "GET", "/api/audit?session=s1&kind=tool");
    const body = (await res.json()) as ListBody;
    expect(body.entries.map((entry) => entry.summary)).toEqual(["a"]);
  });

  test("validasi 400 untuk kind dan angka buruk", async () => {
    const app = makeAuditApp();
    const unknownKind = await req(app, "GET", "/api/audit?kind=ngawur");
    expect(unknownKind.status).toBe(400);
    expect(((await unknownKind.json()) as { error: string }).error).toBe(
      "Jenis audit tidak dikenal.",
    );

    for (const query of ["before=abc", "before=0", "before=-1", "limit=abc", "limit=0"]) {
      const res = await req(app, "GET", `/api/audit?${query}`);
      expect(res.status).toBe(400);
    }
  });

  test("GET /api/audit/summary", async () => {
    const app = makeAuditApp();
    store!.append({ kind: "tool", sessionId: "s1", summary: "a" });
    store!.append({ kind: "rahasia-disamarkan", sessionId: "s1", summary: "b" });

    const res = await req(app, "GET", "/api/audit/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      total: number;
      byKind: Record<string, number>;
      redactedSessions: number;
    };
    expect(body.days).toBe(7);
    expect(body.total).toBe(2);
    expect(body.byKind).toEqual({ tool: 1, "rahasia-disamarkan": 1 });
    expect(body.redactedSessions).toBe(1);
  });
});

describe("rute audit tanpa store", () => {
  test("GET /api/audit dan summary menjawab 503", async () => {
    const app = makeApp();
    for (const path of ["/api/audit", "/api/audit/summary"]) {
      const res = await req(app, "GET", path);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe(
        "Log audit dimatikan.",
      );
    }
  });
});

describe("rute audit tanpa mutasi", () => {
  test("POST/PUT/PATCH/DELETE bukan 2xx", async () => {
    const app = makeAuditApp();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await req(app, method, "/api/audit", {});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(200);
    }
  });
});
