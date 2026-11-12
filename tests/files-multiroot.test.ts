import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { FileError } from "../src/server/files/path";
import {
  repoSnapshotName,
  resolveRepoRoot,
} from "../src/server/files/repo-root";
import type {
  WorkspaceResolver,
  WorkspaceResolverView,
} from "../src/server/sessions/session-manager";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let root: string;
let home: string;
let providersFile: string;
let repoA: string;
let repoB: string;
let outside: string;
let undoDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-multiroot-"));
  home = join(root, "home");
  providersFile = join(root, "providers.json");
  outside = await mkdtemp(join(tmpdir(), "jejak-multiroot-outside-"));
  undoDir = await mkdtemp(join(tmpdir(), "jejak-multiroot-undo-"));
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
  repoA = join(root, "api");
  repoB = join(root, "web");
  await mkdir(repoA, { recursive: true, mode: 0o700 });
  await mkdir(repoB, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(undoDir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal`);
  return out;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "."]);
  await git(cwd, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "awal",
  ]);
}

async function commitAll(cwd: string, message = "ubah"): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

function completedRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

type App = ReturnType<typeof createApp>;

interface Harness {
  app: App;
  service: WorkspaceService;
  workspaceId: string;
}

async function makeWorkflow(extra: Partial<CreateAppOptions> = {}): Promise<Harness> {
  const service = new WorkspaceService({ dir: join(home, "workspaces") });
  const workspace = await service.create({
    name: "Kantor",
    repos: [
      { name: "api", path: repoA },
      { name: "web", path: repoB },
    ],
  });
  const app = createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    runner: completedRunner(),
    workspaces: service,
    undoDir,
    ...extra,
  });
  return { app, service, workspaceId: workspace.id };
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function createSession(
  harness: Harness,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await req(harness.app, "POST", "/api/sessions", {
    prompt: "Halo",
    workspaceId: harness.workspaceId,
    ...body,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { session: { id: string } };
  return data.session.id;
}

describe("resolveRepoRoot", () => {
  function resolverOf(repos: Array<{ name: string; path: string; missing?: boolean }>) {
    const calls: string[] = [];
    const view: WorkspaceResolverView = {
      id: "ws-1",
      name: "Kantor",
      repos: repos.map((repo) => ({
        name: repo.name,
        path: repo.path,
        kind: "backend",
        missing: repo.missing === true,
      })),
    };
    const resolver: WorkspaceResolver = {
      async get(id) {
        calls.push(id);
        return id === "ws-1" ? view : undefined;
      },
    };
    return { resolver, calls };
  }

  test("tanpa repo memakai cwd apa adanya", async () => {
    const { resolver } = resolverOf([]);
    const root = await resolveRepoRoot({ cwd: "/tmp/kerja", workspaceId: "ws-1" }, undefined, resolver);
    expect(root).toBe("/tmp/kerja");
  });

  test("repo valid memakai realpath path workspace", async () => {
    await writeFile(join(repoB, "a.txt"), "isi");
    const link = join(root, "tautan-web");
    await symlink(repoB, link);
    const { resolver } = resolverOf([{ name: "web", path: link }]);
    const result = await resolveRepoRoot(
      { cwd: repoA, workspaceId: "ws-1" },
      "web",
      resolver,
    );
    expect(result).toBe(await realpath(repoB));
  });

  test("sesi tanpa workspace, resolver hilang, workspace hilang ditolak", async () => {
    const { resolver } = resolverOf([{ name: "web", path: repoB }]);
    for (const [session, res] of [
      [{ cwd: repoA }, resolver],
      [{ cwd: repoA, workspaceId: "ws-1" }, undefined],
      [{ cwd: repoA, workspaceId: "ws-lain" }, resolver],
    ] as const) {
      await expect(resolveRepoRoot(session, "web", res)).rejects.toMatchObject({
        message: "Sesi ini tidak punya workspace.",
        code: "tidak-valid",
      });
    }
  });

  test("nama tak ada, missing, tipe salah, dan path sebagai nama ditolak", async () => {
    const { resolver } = resolverOf([
      { name: "web", path: repoB },
      { name: "hilang", path: join(root, "tidak-ada"), missing: true },
    ]);
    const session = { cwd: repoA, workspaceId: "ws-1" };

    const cases: Array<[unknown, string]> = [
      ["tidak-ada", "Repo tidak ada di workspace."],
      ["hilang", "Folder repo tidak ditemukan."],
      ["../web", "Repo tidak ada di workspace."],
      ["/etc/passwd", "Repo tidak ada di workspace."],
      [[], "Parameter repo tidak valid."],
      ["", "Parameter repo tidak valid."],
      [5, "Parameter repo tidak valid."],
      [{ name: "web" }, "Parameter repo tidak valid."],
    ];
    for (const [value, message] of cases) {
      try {
        await resolveRepoRoot(session, value, resolver);
        throw new Error("seharusnya gagal");
      } catch (error) {
        expect(error).toBeInstanceOf(FileError);
        expect((error as FileError).message).toBe(message);
      }
    }
  });

  test("repoSnapshotName mengembalikan undefined untuk cwd", async () => {
    await writeFile(join(repoA, "a.txt"), "isi");
    const rootA = await realpath(repoA);
    expect(
      await repoSnapshotName({ cwd: repoA, workspaceId: "ws-1" }, "api", rootA),
    ).toBeUndefined();
    expect(
      await repoSnapshotName({ cwd: repoA, workspaceId: "ws-1" }, "web", repoB),
    ).toBe("web");
    expect(
      await repoSnapshotName({ cwd: repoA, workspaceId: "ws-1" }, undefined, repoA),
    ).toBeUndefined();
  });
});

describe("API berkas dengan repo kedua", () => {
  test("files, file, dan changes membaca repo kedua, bukan cwd", async () => {
    await writeFile(join(repoA, "hanya-api.txt"), "api");
    await writeFile(join(repoB, "hanya-web.txt"), "web\nbaris dua\n");
    await initRepo(repoB);
    await commitAll(repoB, "isi awal");
    await writeFile(join(repoB, "hanya-web.txt"), "web\nbaris dua diubah\n");

    const harness = await makeWorkflow();
    const id = await createSession(harness);

    const listing = await req(harness.app, "GET", `/api/sessions/${id}/files?repo=web`);
    expect(listing.status).toBe(200);
    const listingBody = (await listing.json()) as {
      path: string;
      entries: Array<{ name: string }>;
    };
    expect(listingBody.path).toBe("");
    expect(listingBody.entries.map((entry) => entry.name)).toEqual(["hanya-web.txt"]);

    const read = await req(harness.app, "GET", `/api/sessions/${id}/file?repo=web&path=hanya-web.txt`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { content: string }).content).toContain("diubah");

    const changes = await req(harness.app, "GET", `/api/sessions/${id}/changes?repo=web`);
    expect(changes.status).toBe(200);
    const changesBody = (await changes.json()) as {
      isRepo: boolean;
      files: Array<{ path: string }>;
    };
    expect(changesBody.isRepo).toBe(true);
    expect(changesBody.files.map((file) => file.path)).toEqual(["hanya-web.txt"]);

    const withoutRepo = await req(harness.app, "GET", `/api/sessions/${id}/files`);
    const withoutBody = (await withoutRepo.json()) as { entries: Array<{ name: string }> };
    expect(withoutBody.entries.map((entry) => entry.name)).toEqual(["hanya-api.txt"]);
  });

  test("traversal dan symlink keluar repo kedua ditolak, tanpa memuat path absolut", async () => {
    await writeFile(join(outside, "rahasia.txt"), "rahasia");
    await writeFile(join(repoB, "a.txt"), "isi");
    await symlink(join(outside, "rahasia.txt"), join(repoB, "keluar.txt"));
    await symlink(outside, join(repoB, "keluar-dir"));

    const harness = await makeWorkflow();
    const id = await createSession(harness);

    for (const rel of ["../a.txt", "/etc/passwd", "keluar.txt", "keluar-dir/rahasia.txt"]) {
      const list = await req(
        harness.app,
        "GET",
        `/api/sessions/${id}/files?repo=web&path=${encodeURIComponent(rel)}`,
      );
      expect(list.status).toBe(400);
      const body = (await list.json()) as { error: string };
      expect(body.error).not.toContain(outside);
      expect(body.error).not.toContain(root);
    }

    const repoParam = await req(harness.app, "GET", `/api/sessions/${id}/files?repo=${encodeURIComponent("../web")}`);
    expect(repoParam.status).toBe(400);
    expect(((await repoParam.json()) as { error: string }).error).toBe(
      "Repo tidak ada di workspace.",
    );
  });

  test("sesi tanpa workspace dan repo missing ditolak 400", async () => {
    const harness = await makeWorkflow();
    const sessionWith = await createSession(harness);

    const missing = await req(
      harness.app,
      "GET",
      `/api/sessions/${sessionWith}/files?repo=web`,
    );
    expect(missing.status).toBe(200);

    await rm(repoB, { recursive: true, force: true });
    const gone = await req(harness.app, "GET", `/api/sessions/${sessionWith}/files?repo=web`);
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toBe(
      "Folder repo tidak ditemukan.",
    );

    const plain = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: completedRunner(),
      undoDir,
    });
    const created = await req(plain, "POST", "/api/sessions", { prompt: "Halo", cwd: repoA });
    expect(created.status).toBe(201);
    const plainId = ((await created.json()) as { session: { id: string } }).session.id;
    const noWorkspace = await req(plain, "GET", `/api/sessions/${plainId}/files?repo=web`);
    expect(noWorkspace.status).toBe(400);
    expect(((await noWorkspace.json()) as { error: string }).error).toBe(
      "Sesi ini tidak punya workspace.",
    );
  });
});

describe("tolak dan urungkan lintas repo", () => {
  async function changeInRepo(path: string, content: string): Promise<string> {
    await writeFile(join(path, "a.txt"), "awal\n");
    await initRepo(path);
    await commitAll(path, "isi");
    await writeFile(join(path, "a.txt"), content);
    return content;
  }

  interface ChangesBody {
    files: Array<{ path: string; diffId: string }>;
  }

  async function diffIdFor(app: App, id: string, repo: string): Promise<string> {
    const res = await req(app, "GET", `/api/sessions/${id}/changes?repo=${repo}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    const file = body.files.find((item) => item.path === "a.txt");
    expect(file).toBeDefined();
    return file!.diffId;
  }

  test("reject dan undo pada repo kedua hanya menyentuh repo kedua", async () => {
    await changeInRepo(repoA, "api berubah\n");
    await changeInRepo(repoB, "web berubah\n");

    const harness = await makeWorkflow();
    const id = await createSession(harness);
    const apiDiff = await diffIdFor(harness.app, id, "api");
    const webDiff = await diffIdFor(harness.app, id, "web");

    const rejected = await req(harness.app, "POST", `/api/sessions/${id}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId: webDiff,
      repo: "web",
    });
    expect(rejected.status).toBe(200);
    const { undoId } = (await rejected.json()) as { undoId: string };
    expect(await readFile(join(repoB, "a.txt"), "utf8")).toBe("awal\n");
    expect(await readFile(join(repoA, "a.txt"), "utf8")).toBe("api berubah\n");

    // undoId repo kedua tidak bisa dipakai di repo lain atau tanpa repo.
    for (const body of [{ undoId }, { undoId, repo: "api" }]) {
      const wrong = await req(harness.app, "POST", `/api/sessions/${id}/changes/undo`, body);
      expect(wrong.status).toBe(404);
    }
    expect(await readFile(join(repoB, "a.txt"), "utf8")).toBe("awal\n");

    const undone = await req(harness.app, "POST", `/api/sessions/${id}/changes/undo`, {
      undoId,
      repo: "web",
    });
    expect(undone.status).toBe(200);
    expect((await undone.json()) as { ok: boolean; path: string }).toEqual({
      ok: true,
      path: "a.txt",
    });
    expect(await readFile(join(repoB, "a.txt"), "utf8")).toBe("web berubah\n");
    expect(await readFile(join(repoA, "a.txt"), "utf8")).toBe("api berubah\n");

    // undoId lama (cwd) tetap valid dan repo utama memakai jalur penyimpanan lama.
    const apiRejected = await req(harness.app, "POST", `/api/sessions/${id}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId: apiDiff,
      repo: "api",
    });
    expect(apiRejected.status).toBe(200);
    const apiUndoId = ((await apiRejected.json()) as { undoId: string }).undoId;
    expect(existsSync(join(undoDir, id, apiUndoId))).toBe(true);
    expect(existsSync(join(undoDir, id, `repo-api`, apiUndoId))).toBe(false);
    expect(await readFile(join(repoA, "a.txt"), "utf8")).toBe("awal\n");

    const plainUndo = await req(harness.app, "POST", `/api/sessions/${id}/changes/undo`, {
      undoId: apiUndoId,
    });
    expect(plainUndo.status).toBe(200);
    expect(await readFile(join(repoA, "a.txt"), "utf8")).toBe("api berubah\n");
  });

  test("repo salah tipe atau sesi tanpa workspace ditolak 400 untuk reject dan undo", async () => {
    await changeInRepo(repoA, "berubah\n");
    const harness = await makeWorkflow();
    const id = await createSession(harness);
    const diffId = await diffIdFor(harness.app, id, "api");

    const typed = await req(harness.app, "POST", `/api/sessions/${id}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId,
      repo: ["api"],
    });
    expect(typed.status).toBe(400);
    expect(((await typed.json()) as { error: string }).error).toBe(
      "Parameter repo tidak valid.",
    );

    const undoBadRepo = await req(harness.app, "POST", `/api/sessions/${id}/changes/undo`, {
      undoId: "00000000-0000-4000-8000-000000000000",
      repo: 5,
    });
    expect(undoBadRepo.status).toBe(400);

    const plain = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: completedRunner(),
      undoDir,
    });
    const created = await req(plain, "POST", "/api/sessions", { prompt: "Halo", cwd: repoA });
    const plainId = ((await created.json()) as { session: { id: string } }).session.id;
    for (let i = 0; i < 100; i++) {
      const view = await req(plain, "GET", `/api/sessions/${plainId}`);
      const status = ((await view.json()) as { session?: { status?: string } }).session?.status;
      if (status !== "berjalan") break;
      await Bun.sleep(10);
    }
    const plainReject = await req(plain, "POST", `/api/sessions/${plainId}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId,
      repo: "api",
    });
    expect(plainReject.status).toBe(400);
    expect(((await plainReject.json()) as { error: string }).error).toBe(
      "Sesi ini tidak punya workspace.",
    );
  });

  test("sesi berjalan tetap 409 untuk repo kedua", async () => {
    await changeInRepo(repoB, "berubah\n");
    const harness = await makeWorkflow();
    const hanging: AgentRunner = {
      async *run() {
        await new Promise<void>(() => {});
      },
    };
    const queued = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: hanging,
      workspaces: harness.service,
      undoDir,
    });
    const created = await req(queued, "POST", "/api/sessions", {
      prompt: "Halo",
      workspaceId: harness.workspaceId,
    });
    const id = ((await created.json()) as { session: { id: string } }).session.id;

    const res = await req(queued, "POST", `/api/sessions/${id}/changes/reject`, {
      path: "a.txt",
      scope: "file",
      diffId: "0".repeat(64),
      repo: "web",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.",
    );
    await req(queued, "POST", `/api/sessions/${id}/interrupt`, {});
  });
});

describe("workspaceRepos pada GET /api/sessions/:id", () => {
  test("primary dan missing dihitung saat dibaca, tidak ada di daftar", async () => {
    const harness = await makeWorkflow();
    const id = await createSession(harness, { cwd: repoA });

    const detail = await req(harness.app, "GET", `/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      session: { workspaceRepos?: Array<{ name: string; primary: boolean; missing: boolean }> };
    };
    expect(body.session.workspaceRepos).toEqual([
      { name: "api", primary: true, missing: false },
      { name: "web", primary: false, missing: false },
    ]);

    await rm(repoB, { recursive: true, force: true });
    const after = await req(harness.app, "GET", `/api/sessions/${id}`);
    const afterBody = (await after.json()) as {
      session: { workspaceRepos?: Array<{ name: string; primary: boolean; missing: boolean }> };
    };
    expect(afterBody.session.workspaceRepos).toEqual([
      { name: "api", primary: true, missing: false },
      { name: "web", primary: false, missing: true },
    ]);

    const list = await req(harness.app, "GET", "/api/sessions");
    const listBody = (await list.json()) as {
      sessions: Array<{ id: string; workspaceRepos?: unknown }>;
    };
    expect("workspaceRepos" in listBody.sessions[0]!).toBe(false);
  });

  test("sesi tanpa workspace atau workspace hilang tanpa field", async () => {
    const harness = await makeWorkflow();
    const id = await createSession(harness);
    const detail = await req(harness.app, "GET", `/api/sessions/${id}`);
    expect(((await detail.json()) as { session: { workspaceRepos?: unknown } }).session.workspaceRepos)
      .toBeDefined();

    await rm(join(home, "workspaces"), { recursive: true, force: true });
    const gone = await req(harness.app, "GET", `/api/sessions/${id}`);
    expect(gone.status).toBe(200);
    expect("workspaceRepos" in ((await gone.json()) as { session: object }).session).toBe(false);

    const plain = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: completedRunner(),
      undoDir,
    });
    const created = await req(plain, "POST", "/api/sessions", { prompt: "Halo", cwd: repoA });
    const plainId = ((await created.json()) as { session: { id: string } }).session.id;
    const plainDetail = await req(plain, "GET", `/api/sessions/${plainId}`);
    expect(
      "workspaceRepos" in ((await plainDetail.json()) as { session: object }).session,
    ).toBe(false);
  });
});
