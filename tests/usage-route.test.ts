import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteUsageLedger } from "../src/server/budget/usage-ledger";

const PASSWORD = "sandi-uji-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let ledger: SqliteUsageLedger;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-usage-route-"));
  ledger = new SqliteUsageLedger(":memory:", { retentionDays: 3650 });
});

afterEach(async () => {
  ledger.close();
  await rm(dir, { recursive: true, force: true });
});

function makeApp(options: { auth?: boolean; withLedger?: boolean } = {}): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    ...(options.withLedger === false ? {} : { usageLedger: ledger }),
    ...(options.auth === true ? { auth: { password: PASSWORD, port: 3000 } } : {}),
  });
}

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }));
}

describe("rute /api/usage", () => {
  test("mengembalikan bentuk ringkasan yang benar", async () => {
    ledger.record({
      ts: new Date().toISOString(),
      sessionId: "s_1",
      profileId: "p_1",
      model: "claude-a",
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 50,
    });
    const app = makeApp();

    const res = await get(app, "/api/usage?days=7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      summary: {
        totalCostUsd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        turns: number;
        byDay: Array<{ day: string; costUsd: number }>;
        byModel: Array<{ model: string }>;
        byProfile: Array<{ profileId: string }>;
        bySession: Array<{ sessionId: string }>;
      };
      retentionDays: number;
      sessions: Record<string, string>;
    };

    expect(body.days).toBe(7);
    expect(body.retentionDays).toBe(90);
    expect(body.summary.totalCostUsd).toBeCloseTo(0.5, 6);
    expect(body.summary.totalInputTokens).toBe(100);
    expect(body.summary.totalOutputTokens).toBe(50);
    expect(body.summary.turns).toBe(1);
    expect(body.summary.byDay).toHaveLength(7);
    expect(body.summary.byDay[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.summary.byModel[0]?.model).toBe("claude-a");
    expect(body.summary.byProfile[0]?.profileId).toBe("p_1");
    expect(body.summary.bySession[0]?.sessionId).toBe("s_1");
    expect(body.sessions).toEqual({});
  });

  test("tanpa parameter days memakai tiga puluh hari", async () => {
    const app = makeApp();

    const res = await get(app, "/api/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; summary: { byDay: unknown[] } };
    expect(body.days).toBe(30);
    expect(body.summary.byDay).toHaveLength(30);
  });

  test("hari yang tidak diizinkan ditolak", async () => {
    const app = makeApp();

    const res = await get(app, "/api/usage?days=5");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("tidak valid");
  });

  test("offset zona waktu di luar rentang dijepit", async () => {
    const app = makeApp();

    const atas = await get(app, "/api/usage?days=7&tz=9999");
    const batas = await get(app, "/api/usage?days=7&tz=840");
    expect(atas.status).toBe(200);
    const bodyAtas = (await atas.json()) as { summary: { byDay: unknown[] } };
    const bodyBatas = (await batas.json()) as { summary: { byDay: unknown[] } };
    expect(bodyAtas.summary.byDay).toEqual(bodyBatas.summary.byDay);
  });

  test("tanpa ledger menjawab 503", async () => {
    const app = makeApp({ withLedger: false });

    const res = await get(app, "/api/usage");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Pencatatan pemakaian dimatikan." });
  });

  test("respons tidak memuat isi percakapan atau folder kerja", async () => {
    ledger.record({
      ts: new Date().toISOString(),
      sessionId: "s_1",
      profileId: "p_1",
      costUsd: 0.5,
    });
    const app = makeApp();

    const res = await get(app, "/api/usage");
    const text = await res.text();
    for (const key of ["cwd", "prompt", "message", "text", "content"]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  test("dengan auth aktif tanpa cookie menjawab 401", async () => {
    const app = makeApp({ auth: true });

    const res = await get(app, "/api/usage");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "perlu login" });
  });
});
