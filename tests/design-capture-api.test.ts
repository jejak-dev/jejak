import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureBroker } from "../src/server/design/capture-broker";
import { designRoutes } from "../src/server/routes/design";
import type { SessionManager } from "../src/server/sessions/session-manager";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-capture-api-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", "home.html"), "<html><body></body></html>", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** PNG minimal valid (tanda tangan + IHDR) untuk unggahan. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf.write("IEND", 37, "latin1");
  return buf;
}

function dataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

const SESSION = { id: "s_capture", cwd: "", status: "selesai" };

function makeApp(captures?: CaptureBroker) {
  const manager = {
    get: (id: string) => (id === SESSION.id ? { ...SESSION, cwd: dir } : undefined),
  } as unknown as SessionManager;
  return new Elysia().use(
    designRoutes({ manager, captures, editEnabled: false } as never),
  );
}

function post(app: Elysia, path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function get(app: Elysia, path: string): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "GET",
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

const STAMP = `/api/sessions/${SESSION.id}/design/stamp`;

describe("stamp dan tangkapan", () => {
  test("stamp tanpa broker tetap {stamp}", async () => {
    const app = makeApp();
    const res = await get(app, STAMP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["stamp"]);
  });

  test("stamp dengan broker men-touch dan memuat captures", async () => {
    const broker = new CaptureBroker();
    const app = makeApp(broker);
    broker.touch("s_capture");
    const janji = broker.request("s_capture", "home", 1);
    const res = await get(app, STAMP);
    const body = (await res.json()) as { stamp: unknown; captures: { id: string }[] };
    expect(body.stamp).toBeDefined();
    expect(body.captures).toHaveLength(1);
    expect(broker.pending("s_capture")[0]?.id).toBe(body.captures[0]?.id);
    broker.fail("s_capture", body.captures[0]!.id, "failed");
    await janji.catch(() => undefined);
  });

  test("unggah dataUrl valid menyelesaikan permintaan tertunda", async () => {
    const broker = new CaptureBroker({ timeoutMs: 500 });
    const app = makeApp(broker);
    broker.touch("s_capture");
    const janji = broker.request("s_capture", "home", 1);
    const id = broker.pending("s_capture")[0]!.id;
    const res = await post(
      app,
      `/api/sessions/${SESSION.id}/design/capture/${id}`,
      { dataUrl: dataUrl(png(12, 34)) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const hasil = await janji;
    expect(hasil.width).toBe(12);
    expect(hasil.height).toBe(34);
  });

  test("unggah {error} menolak permintaan", async () => {
    const broker = new CaptureBroker({ timeoutMs: 500 });
    const app = makeApp(broker);
    broker.touch("s_capture");
    const janji = broker.request("s_capture", "home", 1);
    const id = broker.pending("s_capture")[0]!.id;
    const res = await post(app, `/api/sessions/${SESSION.id}/design/capture/${id}`, {
      error: "tainted",
    });
    expect(res.status).toBe(200);
    await expect(janji).rejects.toThrow("Browser ini tidak mengizinkan tangkapan layar");
  });

  test("id tak dikenal 404", async () => {
    const broker = new CaptureBroker();
    const app = makeApp(broker);
    const res = await post(
      app,
      `/api/sessions/${SESSION.id}/design/capture/k_tidakada`,
      { dataUrl: dataUrl(png(3, 3)) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Permintaan tidak ditemukan." });
    const gagal = await post(
      app,
      `/api/sessions/${SESSION.id}/design/capture/k_tidakada`,
      { error: "failed" },
    );
    expect(gagal.status).toBe(404);
  });

  test("dataUrl bukan PNG / bukan base64 / body bukan JSON -> 400", async () => {
    const broker = new CaptureBroker({ timeoutMs: 500 });
    const app = makeApp(broker);
    const kasus: unknown[] = [
      { dataUrl: "data:image/jpeg;base64,AAAA" },
      { dataUrl: "data:image/png;base64,bukan base64!" },
      "{bukan json",
      { lain: 1 },
    ];
    for (const body of kasus) {
      broker.touch("s_capture");
      const janji = broker.request("s_capture", "home", 1).catch(() => undefined);
      const id = broker.pending("s_capture")[0]!.id;
      const res = await post(app, `/api/sessions/${SESSION.id}/design/capture/${id}`, body);
      expect(res.status).toBe(400);
      await janji;
    }
  });

  test("unggah PNG rusak -> 400 dan permintaan ditolak", async () => {
    const broker = new CaptureBroker({ timeoutMs: 500 });
    const app = makeApp(broker);
    broker.touch("s_capture");
    const janji = broker.request("s_capture", "home", 1);
    const id = broker.pending("s_capture")[0]!.id;
    const res = await post(app, `/api/sessions/${SESSION.id}/design/capture/${id}`, {
      dataUrl: dataUrl(Buffer.from("bukan png sama sekali")),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Gambar tangkapan tidak valid." });
    await expect(janji).rejects.toThrow("Gambar tangkapan tidak valid.");
  });

  test("unggah melebihi batas body -> 400", async () => {
    const broker = new CaptureBroker();
    const app = makeApp(broker);
    const res = await post(app, `/api/sessions/${SESSION.id}/design/capture/k_x`, {
      dataUrl: `data:image/png;base64,${"A".repeat(6_100_000)}`,
    });
    expect(res.status).toBe(400);
  });

  test("sesi tak ada -> 404; tanpa broker -> 404", async () => {
    const broker = new CaptureBroker();
    const app = makeApp(broker);
    const tanpaSesi = await post(app, "/api/sessions/s_lain/design/capture/k_x", {
      dataUrl: dataUrl(png(1, 1)),
    });
    expect(tanpaSesi.status).toBe(404);

    const tanpaBroker = makeApp();
    const res = await post(
      tanpaBroker,
      `/api/sessions/${SESSION.id}/design/capture/k_x`,
      { dataUrl: dataUrl(png(1, 1)) },
    );
    expect(res.status).toBe(404);
  });
});
