import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import type { BrowseResult } from "../src/server/files/browse";

let root: string;
let providersFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-fs-api-"));
  providersFile = join(root, "providers.json");
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
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(options: Partial<CreateAppOptions> = {}): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: root },
    runner: createMockRunner(),
    ...options,
  });
}

function req(server: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "GET",
      headers: { host: "127.0.0.1:3000", ...headers },
    }),
  );
}

describe("GET /api/fs/dirs", () => {
  test("tanpa path memakai folder awal yang dikonfigurasi", async () => {
    await mkdir(join(root, "proyek"));
    await mkdir(join(root, ".tersembunyi"));
    await writeFile(join(root, "berkas.txt"), "isi");
    const server = makeApp({ fsHome: root });
    const expectedHome = await realpath(root);

    const res = await req(server, "/api/fs/dirs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseResult;
    expect(body.home).toBe(root);
    expect(body.path).toBe(expectedHome);
    expect(body.entries.map((entry) => entry.name)).toEqual(["proyek"]);
    expect(body.entries[0]?.git).toBe(false);
    expect(body.truncated).toBe(false);
  });

  test("path valid: hanya folder, urut, git terdeteksi, berkas tidak muncul", async () => {
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, "Repo"));
    await mkdir(join(root, "Repo", ".git"));
    await mkdir(join(root, "alfa"));
    await writeFile(join(root, "catatan.txt"), "isi");
    await writeFile(join(root, "pakai.json"), "{}");
    const server = makeApp();

    const res = await req(server, `/api/fs/dirs?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("catatan.txt");
    expect(raw).not.toContain("pakai.json");
    const body = JSON.parse(raw) as BrowseResult;
    expect(body.entries.map((entry) => entry.name)).toEqual(["alfa", "Repo", "zeta"]);
    const repo = body.entries.find((entry) => entry.name === "Repo");
    expect(repo?.git).toBe(true);
    expect(repo?.path).toBe(join(await realpath(root), "Repo"));
    const alfa = body.entries.find((entry) => entry.name === "alfa");
    expect(alfa?.git).toBe(false);
  });

  test("path relatif, NUL, dan array 400", async () => {
    const server = makeApp();
    for (const query of ["relatif", "a%00b", "a&path=b"]) {
      const res = await req(server, `/api/fs/dirs?path=${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Path tidak valid." });
    }
  });

  test("folder tidak ada 404, berkas 400", async () => {
    await writeFile(join(root, "berkas.txt"), "x");
    const server = makeApp();

    const missing = await req(server, `/api/fs/dirs?path=${encodeURIComponent(join(root, "hilang"))}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Folder tidak ditemukan." });

    const file = await req(server, `/api/fs/dirs?path=${encodeURIComponent(join(root, "berkas.txt"))}`);
    expect(file.status).toBe(400);
    expect(await file.json()).toEqual({ error: "Bukan folder." });
  });

  test("JEJAK_FS_BROWSE=0 menjawab 503", async () => {
    const server = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: root, JEJAK_FS_BROWSE: "0" },
      runner: createMockRunner(),
    });
    const res = await req(server, "/api/fs/dirs");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Penelusur folder dimatikan." });
  });

  test("host dan origin asing ditolak guard", async () => {
    const server = makeApp();
    const host = await req(server, "/api/fs/dirs", { host: "evil.test" });
    expect(host.status).toBe(403);
    expect(await host.json()).toEqual({ error: "host tidak diizinkan" });

    const origin = await req(server, "/api/fs/dirs", { origin: "http://evil.test" });
    expect(origin.status).toBe(403);
    expect(await origin.json()).toEqual({ error: "origin tidak diizinkan" });
  });
});

// Memastikan `readdir` dipakai hanya untuk struktur, bukan isi berkas.
test("entri tidak memuat isi berkas", async () => {
  await writeFile(join(root, "rahasia.txt"), "ISI-RAHASIA");
  await mkdir(join(root, "folder"));
  const server = makeApp();
  const res = await req(server, `/api/fs/dirs?path=${encodeURIComponent(root)}`);
  const body = (await res.json()) as BrowseResult;
  expect(JSON.stringify(body)).not.toContain("ISI-RAHASIA");
  expect(body.entries).toEqual([{ name: "folder", path: join(await realpath(root), "folder"), git: false }]);
  expect((await readdir(root)).sort()).toEqual(["folder", "providers.json", "rahasia.txt"]);
});