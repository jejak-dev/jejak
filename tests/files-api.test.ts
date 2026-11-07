import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";

let dir: string;
let providersFile: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-files-api-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-files-api-outside-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-files-api-config-"));
  providersFile = join(configDir, "providers.json");
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
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(): App {
  return createApp({ providersPath: providersFile, env: { MOCK: "true" }, runner: createMockRunner() });
}

function req(server: App, method: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000", ...headers },
    }),
  );
}

async function createSession(server: App, cwd = dir): Promise<string> {
  const created = await server.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  return data.session.id;
}

function filesUrl(id: string, rel?: string): string {
  return rel === undefined
    ? `/api/sessions/${id}/files`
    : `/api/sessions/${id}/files?path=${encodeURIComponent(rel)}`;
}

function fileUrl(id: string, rel: string): string {
  return `/api/sessions/${id}/file?path=${encodeURIComponent(rel)}`;
}

interface ListingBody {
  path: string;
  entries: Array<{ name: string; type: string; size?: number }>;
  truncated: boolean;
}

interface FileBody {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content?: string;
}

interface ErrorBody {
  error: string;
}

describe("GET /api/sessions/:id/files", () => {
  test("akar cwd dan subdirektori, urutan dir dulu lalu berkas", async () => {
    await mkdir(join(dir, "folder"));
    await writeFile(join(dir, "b.txt"), "bb");
    await writeFile(join(dir, "A.txt"), "a");
    const server = makeApp();
    const id = await createSession(server);

    const root = await req(server, "GET", filesUrl(id));
    expect(root.status).toBe(200);
    const body = (await root.json()) as ListingBody;
    expect(body.path).toBe("");
    expect(body.entries.map((entry) => entry.name)).toEqual(["folder", "A.txt", "b.txt"]);
    expect(body.truncated).toBe(false);

    await writeFile(join(dir, "folder", "dalam.txt"), "isi");
    const sub = await req(server, "GET", filesUrl(id, "folder"));
    const subBody = (await sub.json()) as ListingBody;
    expect(subBody.path).toBe("folder");
    expect(subBody.entries).toEqual([{ name: "dalam.txt", type: "file", size: 3 }]);
  });

  test("path ke berkas 400, path hilang 404, path bukan sesi 404", async () => {
    await writeFile(join(dir, "berkas.txt"), "x");
    const server = makeApp();
    const id = await createSession(server);

    const toFile = await req(server, "GET", filesUrl(id, "berkas.txt"));
    expect(toFile.status).toBe(400);
    expect(await toFile.json()).toHaveProperty("error");

    const missing = await req(server, "GET", filesUrl(id, "tidak-ada"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toHaveProperty("error");

    const noSession = await req(server, "GET", "/api/sessions/s_tidakada/files");
    expect(noSession.status).toBe(404);
    expect(await noSession.json()).toHaveProperty("error");
  });
});

describe("GET /api/sessions/:id/file", () => {
  test("teks, UTF-8 multibyte, biner, direktori, dan hilang", async () => {
    await writeFile(join(dir, "teks.txt"), "halo\n");
    await writeFile(join(dir, "utf8.txt"), "héllo — 日本語");
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await mkdir(join(dir, "folder"));
    const server = makeApp();
    const id = await createSession(server);

    const text = await req(server, "GET", fileUrl(id, "teks.txt"));
    expect(text.status).toBe(200);
    expect((await text.json()) as FileBody).toEqual({
      path: "teks.txt",
      size: 5,
      binary: false,
      truncated: false,
      content: "halo\n",
    });

    const utf8 = (await (await req(server, "GET", fileUrl(id, "utf8.txt"))).json()) as FileBody;
    expect(utf8.content).toBe("héllo — 日本語");

    const binary = (await (await req(server, "GET", fileUrl(id, "biner.bin"))).json()) as FileBody;
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeUndefined();

    const directory = await req(server, "GET", fileUrl(id, "folder"));
    expect(directory.status).toBe(400);

    const missing = await req(server, "GET", fileUrl(id, "hilang.txt"));
    expect(missing.status).toBe(404);
  });

  test("path kosong ditolak sebagai direktori, sesi hilang 404", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const empty = await req(server, "GET", `/api/sessions/${id}/file`);
    expect(empty.status).toBe(400);

    const noSession = await req(server, "GET", "/api/sessions/s_tidakada/file?path=a.txt");
    expect(noSession.status).toBe(404);
  });
});

describe("keamanan path lewat API", () => {
  const escapes = ["../etc/passwd", "a/../../x", "/etc/passwd", "..", "%2e%2e", "%2e%2e/%2e%2e/etc/passwd"];

  test("path keluar cwd ditolak 400 untuk files dan file", async () => {
    const server = makeApp();
    const id = await createSession(server);

    for (const rel of escapes) {
      const list = await req(server, "GET", `/api/sessions/${id}/files?path=${rel}`);
      expect(list.status).toBe(400);
      const listBody = (await list.json()) as ErrorBody;
      expect(typeof listBody.error).toBe("string");

      const read = await req(server, "GET", `/api/sessions/${id}/file?path=${rel}`);
      expect(read.status).toBe(400);
    }
  });

  test("NUL (%00) ditolak 400", async () => {
    await writeFile(join(dir, "a.txt"), "isi");
    const server = makeApp();
    const id = await createSession(server);

    const list = await req(server, "GET", `/api/sessions/${id}/files?path=a%00b`);
    expect(list.status).toBe(400);

    const read = await req(server, "GET", `/api/sessions/${id}/file?path=a%00b`);
    expect(read.status).toBe(400);
  });

  test("symlink ke luar cwd ditolak, symlink di dalam cwd boleh", async () => {
    await writeFile(join(outside, "rahasia.txt"), "rahasia");
    await mkdir(join(outside, "folder"));
    await writeFile(join(outside, "folder", "isi.txt"), "isi");
    await writeFile(join(dir, "asli.txt"), "halo");
    await symlink(join(outside, "rahasia.txt"), join(dir, "keluar-file"));
    await symlink(join(outside, "folder"), join(dir, "keluar-dir"));
    await symlink(join(dir, "asli.txt"), join(dir, "dalam-link.txt"));

    const server = makeApp();
    const id = await createSession(server);

    for (const rel of ["keluar-file", "keluar-dir", "keluar-dir/isi.txt"]) {
      const list = await req(server, "GET", `/api/sessions/${id}/files?path=${encodeURIComponent(rel)}`);
      expect(list.status).toBe(400);
      const read = await req(server, "GET", fileUrl(id, rel));
      expect(read.status).toBe(400);
      const body = (await read.json()) as ErrorBody;
      expect(body.error).toBe("path di luar folder kerja");
      expect(body.error).not.toContain(outside);
    }

    const inside = await req(server, "GET", fileUrl(id, "dalam-link.txt"));
    expect(inside.status).toBe(200);
    expect(((await inside.json()) as FileBody).content).toBe("halo");
  });

  test("pesan galat tidak memuat path absolut", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/file?path=${encodeURIComponent("../rahasia.txt")}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).not.toContain(dir);
    expect(body.error).not.toContain("/tmp");
  });

  test("cwd sesi yang berupa symlink tetap berfungsi", async () => {
    await writeFile(join(dir, "a.txt"), "isi");
    const holder = await mkdtemp(join(tmpdir(), "jejak-files-api-link-"));
    const link = join(holder, "kerja");
    await symlink(dir, link);
    try {
      const server = makeApp();
      const id = await createSession(server, link);
      const listing = await req(server, "GET", filesUrl(id));
      expect(listing.status).toBe(200);
      const body = (await listing.json()) as ListingBody;
      expect(body.entries.map((entry) => entry.name)).toContain("a.txt");

      const read = await req(server, "GET", fileUrl(id, "a.txt"));
      expect(((await read.json()) as FileBody).content).toBe("isi");
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  });
});

describe("GET /api/sessions/:id/changes", () => {
  test("bukan repo mengembalikan isRepo false dengan 200", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/changes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isRepo: false, files: [], truncated: false });
  });

  test("sesi tidak ada 404", async () => {
    const res = await req(makeApp(), "GET", "/api/sessions/s_tidakada/changes");
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("guard pada API berkas", () => {
  test("Host evil.test ditolak 403", async () => {
    const res = await req(makeApp(), "GET", "/api/sessions/s_x/files", { host: "evil.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("Origin lain ditolak 403", async () => {
    const res = await req(makeApp(), "GET", "/api/sessions/s_x/changes", {
      origin: "http://evil.test",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin tidak diizinkan" });
  });
});
