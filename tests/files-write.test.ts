import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { saveTextFile, WriteError } from "../src/server/files/write";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let dir: string;
let outside: string;
let home: string;
let providersFile: string;
let repoB: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-write-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-write-outside-"));
  home = await mkdtemp(join(tmpdir(), "jejak-write-home-"));
  providersFile = join(home, "providers.json");
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
  repoB = join(home, "repo-b");
  await mkdir(repoB, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

/** Runner yang langsung selesai agar sesi tidak berstatus berjalan. */
function completedRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

function makeApp(extra: Record<string, string> = {}): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home, ...extra },
    runner: completedRunner(),
  });
}

function req(app: App, method: string, path: string, body?: unknown, raw?: string): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (raw !== undefined) {
    headers["content-type"] = "application/json";
    init.body = raw;
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function createSession(app: App, cwd = dir, workspaceId?: string): Promise<string> {
  const body: Record<string, unknown> = { prompt: "Halo", cwd };
  if (workspaceId !== undefined) body.workspaceId = workspaceId;
  const created = await req(app, "POST", "/api/sessions", body);
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { session: { id: string } }).session.id;
  // Tunggu runner selesai agar sesi tidak berstatus "berjalan".
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(app, "GET", `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

async function save(
  app: App,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return req(app, "PUT", `/api/sessions/${id}/file`, body);
}

async function currentVersion(app: App, id: string, rel: string): Promise<string> {
  const res = await req(app, "GET", `/api/sessions/${id}/file?path=${encodeURIComponent(rel)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { version?: string };
  expect(body.version).toBeDefined();
  return body.version!;
}

async function noTempFiles(folder: string): Promise<void> {
  const names = await readdir(folder);
  expect(names.filter((name) => name.startsWith(".jejak-save-"))).toEqual([]);
}

describe("saveTextFile", () => {
  test("sukses, version = sha256 isi baru, mode dipertahankan", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "lama\n");
    await chmod(file, 0o600);

    const result = await saveTextFile(dir, {
      path: "a.txt",
      content: "baru\r\ntanpa normalisasi\n",
      baseVersion: sha256("lama\n"),
    });
    expect(result.version).toBe(sha256("baru\r\ntanpa normalisasi\n"));
    expect(result.size).toBe(Buffer.byteLength("baru\r\ntanpa normalisasi\n"));
    expect(await readFile(file, "utf8")).toBe("baru\r\ntanpa normalisasi\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await noTempFiles(dir);
  });

  test("baseVersion salah -> 409 tanpa mengubah isi; tanpa baseVersion 400", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "asli\n");
    const stale = await saveTextFile(dir, {
      path: "a.txt",
      content: "ganti",
      baseVersion: "0".repeat(64),
    }).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(WriteError);
    expect((stale as WriteError).status).toBe(409);
    expect(await readFile(file, "utf8")).toBe("asli\n");

    const missing = await saveTextFile(dir, { path: "a.txt", content: "x" }).catch(
      (error: unknown) => error,
    );
    expect((missing as WriteError).status).toBe(400);
    await noTempFiles(dir);
  });

  test("berkas tidak ada 404 dan tidak membuat berkas; folder 400; biner 400", async () => {
    const notFound = await saveTextFile(dir, {
      path: "baru.txt",
      content: "x",
      baseVersion: "0".repeat(64),
    }).catch((error: unknown) => error);
    expect((notFound as WriteError).status).toBe(404);
    expect(await readdir(dir)).toEqual([]);

    await mkdir(join(dir, "folder"));
    const folder = await saveTextFile(dir, {
      path: "folder",
      content: "x",
      baseVersion: "0".repeat(64),
    }).catch((error: unknown) => error);
    expect((folder as WriteError).status).toBe(400);

    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const binary = await saveTextFile(dir, {
      path: "biner.bin",
      content: "x",
      baseVersion: sha256(Buffer.from([0x61, 0x00, 0x62])),
    }).catch((error: unknown) => error);
    expect((binary as WriteError).status).toBe(400);
  });

  test("path .. / absolut / symlink keluar ditolak", async () => {
    const luar = join(outside, "luar.txt");
    await writeFile(luar, "luar\n");
    await symlink(luar, join(dir, "tautan.txt"));
    for (const input of ["../luar.txt", luar, "tautan.txt"]) {
      const result = await saveTextFile(dir, {
        path: input,
        content: "x",
        baseVersion: sha256("luar\n"),
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(WriteError);
    }
    expect(await readFile(luar, "utf8")).toBe("luar\n");
  });

  test("content terlalu besar 413 dan content NUL 400", async () => {
    await writeFile(join(dir, "a.txt"), "asli");
    const base = sha256("asli");
    const tooLarge = await saveTextFile(dir, {
      path: "a.txt",
      content: "x".repeat(256 * 1024 + 1),
      baseVersion: base,
    }).catch((error: unknown) => error);
    expect((tooLarge as WriteError).status).toBe(413);

    const nul = await saveTextFile(dir, {
      path: "a.txt",
      content: "a\0b",
      baseVersion: base,
    }).catch((error: unknown) => error);
    expect((nul as WriteError).status).toBe(400);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("asli");
  });
});

describe("PUT /api/sessions/:id/file", () => {
  test("sukses dan GET version cocok dengan sha256", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const app = makeApp();
    const id = await createSession(app);

    const before = await currentVersion(app, id, "a.txt");
    expect(before).toBe(sha256("lama\n"));

    const res = await save(app, id, { path: "a.txt", content: "baru\n", baseVersion: before });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: sha256("baru\n"), size: 5 });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("baru\n");
    expect(await currentVersion(app, id, "a.txt")).toBe(sha256("baru\n"));
    await noTempFiles(dir);
  });

  test("baseVersion salah 409, isi tetap; tanpa baseVersion 400", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const app = makeApp();
    const id = await createSession(app);

    const stale = await save(app, id, {
      path: "a.txt",
      content: "baru",
      baseVersion: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe(
      "Berkas berubah di disk. Muat ulang sebelum menyimpan.",
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("lama\n");

    const noBase = await save(app, id, { path: "a.txt", content: "baru" });
    expect(noBase.status).toBe(400);
    await noTempFiles(dir);
  });

  test("JSON rusak/bukan objek 400, sesi tak ada 404, berkas tak ada 404", async () => {
    const app = makeApp();
    const id = await createSession(app);
    expect((await req(app, "PUT", `/api/sessions/${id}/file`, undefined, "{rusak")).status).toBe(400);
    expect((await req(app, "PUT", `/api/sessions/${id}/file`, ["a"])).status).toBe(400);
    expect(
      (await req(app, "PUT", "/api/sessions/tidak-ada/file", { path: "a", content: "b" })).status,
    ).toBe(404);
    const missing = await save(app, id, {
      path: "tidak-ada.txt",
      content: "b",
      baseVersion: "0".repeat(64),
    });
    expect(missing.status).toBe(404);
  });

  test("JEJAK_FILE_EDIT=0 -> 403 dan berkas tak berubah", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const app = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(app);

    const res = await save(app, id, {
      path: "a.txt",
      content: "baru",
      baseVersion: sha256("lama\n"),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Penyuntingan berkas dimatikan." });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("lama\n");

    const read = await req(app, "GET", `/api/sessions/${id}/file?path=a.txt`);
    expect(read.status).toBe(200);
    const search = await req(app, "GET", `/api/sessions/${id}/search?q=lama`);
    expect(search.status).toBe(200);
  });

  test("sesi berjalan -> 409", async () => {
    await writeFile(join(dir, "a.txt"), "lama\n");
    const hanging: AgentRunner = {
      async *run() {
        await new Promise<void>(() => {});
      },
    };
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: hanging,
      undoDir: join(home, "undo"),
    });
    const id = await createSession(app);

    const res = await save(app, id, {
      path: "a.txt",
      content: "baru",
      baseVersion: sha256("lama\n"),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.",
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("lama\n");
    await req(app, "POST", `/api/sessions/${id}/interrupt`, {});
  });

  test("repo workspace lewat repo", async () => {
    await writeFile(join(repoB, "web.txt"), "lama\n");
    const service = new WorkspaceService({ dir: join(home, "workspaces") });
    const workspace = await service.create({
      name: "Kantor",
      repos: [{ name: "web", path: repoB }],
    });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: completedRunner(),
      workspaces: service,
      undoDir: join(home, "undo"),
    });
    const id = await createSession(app, repoB, workspace.id);

    const res = await save(app, id, {
      path: "web.txt",
      content: "baru\n",
      baseVersion: sha256("lama\n"),
      repo: "web",
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(repoB, "web.txt"), "utf8")).toBe("baru\n");
    await noTempFiles(repoB);
  });

  test("GET berkas terpotong/biner tidak punya version", async () => {
    await writeFile(join(dir, "besar.txt"), "x".repeat(256 * 1024 + 10));
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const app = makeApp();
    const id = await createSession(app);

    const large = await req(app, "GET", `/api/sessions/${id}/file?path=besar.txt`);
    const largeBody = (await large.json()) as { truncated: boolean; version?: string };
    expect(largeBody.truncated).toBe(true);
    expect(largeBody.version).toBeUndefined();

    const binary = await req(app, "GET", `/api/sessions/${id}/file?path=biner.bin`);
    const binaryBody = (await binary.json()) as { binary: boolean; version?: string };
    expect(binaryBody.binary).toBe(true);
    expect(binaryBody.version).toBeUndefined();
  });
});
