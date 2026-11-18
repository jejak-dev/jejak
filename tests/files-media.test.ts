import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-media-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-media-luar-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(): App {
  return createApp({ env: { MOCK: "true" }, runner: createMockRunner() });
}

function req(
  server: App,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "GET",
      headers: { host: "127.0.0.1:3000", ...headers },
    }),
  );
}

async function createSession(server: App): Promise<string> {
  const created = await server.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd: dir }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  return data.session.id;
}

function mediaUrl(id: string, rel: string): string {
  return `/api/sessions/${id}/media?path=${encodeURIComponent(rel)}`;
}

describe("GET /api/sessions/:id/media", () => {
  test("png dikirim utuh dengan content-type benar", async () => {
    await writeFile(join(dir, "gambar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, mediaUrl(id, "gambar.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  test("mp4 dengan Range bytes=0-9 menjawab 206", async () => {
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, index) => index));
    await writeFile(join(dir, "klip.mp4"), bytes);
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, mediaUrl(id, "klip.mp4"), { range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-range")).toBe("bytes 0-9/20");
    expect(res.headers.get("content-length")).toBe("10");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(10);
    expect(body).toEqual(new Uint8Array(Array.from({ length: 10 }, (_, index) => index)));
  });

  test("range di luar ukuran menjawab 416", async () => {
    await writeFile(join(dir, "klip.mp4"), Buffer.from([1, 2, 3]));
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, mediaUrl(id, "klip.mp4"), { range: "bytes=10-20" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */3");
  });

  test("svg dan txt ditolak", async () => {
    await writeFile(join(dir, "skrip.svg"), "<svg></svg>");
    await writeFile(join(dir, "catatan.txt"), "halo");
    const server = makeApp();
    const id = await createSession(server);

    for (const name of ["skrip.svg", "catatan.txt"]) {
      const res = await req(server, mediaUrl(id, name));
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
  });

  test("path keluar folder dan symlink keluar ditolak", async () => {
    await writeFile(join(outside, "rahasia.png"), Buffer.from([1]));
    await symlink(join(outside, "rahasia.png"), join(dir, "keluar.png"));
    const server = makeApp();
    const id = await createSession(server);

    const traversal = await req(server, mediaUrl(id, "../rahasia.png"));
    expect(traversal.status).toBe(400);

    const link = await req(server, mediaUrl(id, "keluar.png"));
    expect(link.status).toBe(400);
  });

  test("berkas tak ada 404 dan direktori ditolak", async () => {
    await mkdir(join(dir, "folder.png"));
    const server = makeApp();
    const id = await createSession(server);

    const missing = await req(server, mediaUrl(id, "hilang.png"));
    expect(missing.status).toBe(404);

    const directory = await req(server, mediaUrl(id, "folder.png"));
    expect(directory.status).toBe(400);
  });
});
