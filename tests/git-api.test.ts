import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { resolveProvider as resolveRegistryProvider } from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";
import { SessionManager } from "../src/server/sessions/session-manager";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let root: string;
let dir: string;
let repoA: string;
let repoB: string;
let home: string;
let providersFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-git-api-"));
  dir = join(root, "kerja");
  repoA = join(root, "api");
  repoB = join(root, "web");
  home = join(root, "home");
  await mkdir(dir, { recursive: true });
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
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
  await git(cwd, ["init", "-q", "-b", "main", "."]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "user.email", "t@t"]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "awal"]);
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

type App = ReturnType<typeof createApp>;

interface Harness {
  app: App;
  workspaceId: string;
  manager: SessionManager;
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
  const manager =
    extra.sessions ??
    new SessionManager({
      runner: extra.runner ?? createMockRunner(),
      resolveProvider: async (selection) =>
        resolveRegistryProvider(await loadRegistry(providersFile, { MOCK: "true" }), selection),
      workspaces: {
        get: async (id) => {
          const view = await service.get(id);
          if (view === undefined || view === null) return undefined;
          return {
            id: view.id,
            name: view.name,
            repos: view.repos.map((repo) => ({
              name: repo.name,
              path: repo.path,
              kind: repo.card.kind,
              missing: repo.missing,
            })),
          };
        },
      },
    });
  const app = createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    runner: createMockRunner(),
    workspaces: service,
    ...extra,
    sessions: manager,
  });
  return { app, workspaceId: workspace.id, manager };
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

async function createSession(harness: Harness, body: Record<string, unknown> = {}): Promise<string> {
  const res = await req(harness.app, "POST", "/api/sessions", {
    prompt: "Halo",
    ...body,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { session: { id: string } };
  return data.session.id;
}

interface StatusBody {
  isRepo: boolean;
  branch?: string;
  detached: boolean;
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: string[];
  state: string;
  truncated: boolean;
}

interface ErrorBody {
  error: string;
}

/** Sesi dibuat lalu ditandai selesai agar rute tulis tidak 409 "sedang berjalan". */
async function idleSession(harness: Harness, body: Record<string, unknown> = {}): Promise<string> {
  const id = await createSession(harness, body);
  await harness.manager.done(id);
  return id;
}

describe("rute git baca", () => {
  test("status, log, dan show lewat sesi dengan cwd repo", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll(dir, "tambah a");
    await writeFile(join(dir, "b.txt"), "baru\n");

    const harness = await makeWorkflow();
    const id = await createSession(harness, { cwd: dir });

    const statusRes = await req(harness.app, "GET", `/api/sessions/${id}/git/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as StatusBody;
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.untracked).toEqual(["b.txt"]);
    expect(status.state).toBe("normal");

    const logRes = await req(harness.app, "GET", `/api/sessions/${id}/git/log?limit=1`);
    expect(logRes.status).toBe(200);
    const log = (await logRes.json()) as { commits: Array<{ hash: string; subject: string }> };
    expect(log.commits.length).toBe(1);
    expect(log.commits[0]?.subject).toBe("tambah a");

    const hash = log.commits[0]!.hash;
    const showRes = await req(harness.app, "GET", `/api/sessions/${id}/git/show?hash=${hash}`);
    expect(showRes.status).toBe(200);
    const show = (await showRes.json()) as { text: string; truncated: boolean };
    expect(show.text).toContain("tambah a");
    expect(show.truncated).toBe(false);
  });

  test("sesi tidak ada 404, parameter buruk 400, hash tak ada 404", async () => {
    await initRepo(dir);
    const harness = await makeWorkflow();
    const id = await createSession(harness, { cwd: dir });

    const missing = await req(harness.app, "GET", "/api/sessions/tidak-ada/git/status");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error).toBe('Sesi "tidak-ada" tidak ditemukan.');

    for (const limit of ["0", "101", "abc", "1.5"]) {
      const res = await req(harness.app, "GET", `/api/sessions/${id}/git/log?limit=${limit}`);
      expect(res.status).toBe(400);
    }

    const badHash = await req(harness.app, "GET", `/api/sessions/${id}/git/show?hash=xyz`);
    expect(badHash.status).toBe(400);

    const noHash = await req(harness.app, "GET", `/api/sessions/${id}/git/show`);
    expect(noHash.status).toBe(400);

    const unknown = await req(harness.app, "GET", `/api/sessions/${id}/git/show?hash=${"0".repeat(40)}`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrorBody).error).toBe("Commit tidak ditemukan.");
  });

  test("param repo workspace dipakai sebagai akar", async () => {
    await initRepo(repoB);
    await writeFile(join(repoB, "web.txt"), "isi\n");
    await commitAll(repoB, "web awal");

    const harness = await makeWorkflow();
    const id = await createSession(harness, {
      workspaceId: harness.workspaceId,
      cwd: repoA,
    });

    const statusRes = await req(harness.app, "GET", `/api/sessions/${id}/git/status?repo=web`);
    expect(statusRes.status).toBe(200);
    expect(((await statusRes.json()) as StatusBody).branch).toBe("main");

    const unknown = await req(harness.app, "GET", `/api/sessions/${id}/git/status?repo=tidak-ada`);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ErrorBody).error).toBe("Repo tidak ada di workspace.");
  });

  test("JEJAK_GIT=0 menjawab 503 di semua rute", async () => {
    await initRepo(dir);
    const harness = await makeWorkflow({ env: { MOCK: "true", JEJAK_HOME: home, JEJAK_GIT: "0" } });
    const id = await createSession(harness, { cwd: dir });

    for (const path of ["status", "log", "show?hash=abc"]) {
      const res = await req(harness.app, "GET", `/api/sessions/${id}/git/${path}`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrorBody).error).toBe("Panel git dimatikan.");
    }
  });

  test("rute baca tidak mengubah repo", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll(dir, "tambah a");
    await writeFile(join(dir, "belum.txt"), "draf\n");
    await writeFile(join(dir, "a.txt"), "satu\ndua\n");

    const before = await git(dir, ["status", "--porcelain=v2", "--branch"]);

    const harness = await makeWorkflow();
    const id = await createSession(harness, { cwd: dir });
    await req(harness.app, "GET", `/api/sessions/${id}/git/status`);
    const log = (await (await req(harness.app, "GET", `/api/sessions/${id}/git/log`)).json()) as {
      commits: Array<{ hash: string }>;
    };
    await req(harness.app, "GET", `/api/sessions/${id}/git/show?hash=${log.commits[0]!.hash}`);

    const after = await git(dir, ["status", "--porcelain=v2", "--branch"]);
    expect(after).toBe(before);
  });
});

describe("rute git tulis", () => {
  async function setup(): Promise<{ harness: Harness; id: string; app: App }> {
    await initRepo(dir);
    const harness = await makeWorkflow();
    const id = await idleSession(harness, { cwd: dir });
    return { harness, id, app: harness.app };
  }

  test("stage, unstage, dan commit end-to-end", async () => {
    const { app, id } = await setup();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await writeFile(join(dir, "nama dengan spasi.txt"), "dua\n");

    const staged = await req(app, "POST", `/api/sessions/${id}/git/stage`, {
      paths: ["a.txt", "nama dengan spasi.txt"],
    });
    expect(staged.status).toBe(200);
    expect((await staged.json()) as { ok: boolean }).toEqual({ ok: true });

    const status = (await (await req(app, "GET", `/api/sessions/${id}/git/status`)).json()) as StatusBody;
    expect(status.staged.map((file) => file.path).sort()).toEqual(["a.txt", "nama dengan spasi.txt"]);

    const unstage = await req(app, "POST", `/api/sessions/${id}/git/unstage`, { paths: ["a.txt"] });
    expect(unstage.status).toBe(200);
    const afterUnstage = (await (await req(app, "GET", `/api/sessions/${id}/git/status`)).json()) as StatusBody;
    expect(afterUnstage.staged.map((file) => file.path)).toEqual(["nama dengan spasi.txt"]);

    const commit = await req(app, "POST", `/api/sessions/${id}/git/commit`, { message: "dua berkas" });
    expect(commit.status).toBe(200);
    const data = (await commit.json()) as { hash: string; short: string; subject: string };
    expect(data.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(data.short).toBe(data.hash.slice(0, 7));
    expect(data.subject).toBe("dua berkas");

    const afterCommit = (await (await req(app, "GET", `/api/sessions/${id}/git/status`)).json()) as StatusBody;
    expect(afterCommit.staged).toEqual([]);
    expect(afterCommit.untracked).toEqual(["a.txt"]);
  });

  test("all true pada stage dan unstage", async () => {
    const { app, id } = await setup();
    await writeFile(join(dir, "x.txt"), "x\n");
    await writeFile(join(dir, "y.txt"), "y\n");

    expect((await req(app, "POST", `/api/sessions/${id}/git/stage`, { all: true })).status).toBe(200);
    let status = (await (await req(app, "GET", `/api/sessions/${id}/git/status`)).json()) as StatusBody;
    expect(status.staged.length).toBe(2);

    expect((await req(app, "POST", `/api/sessions/${id}/git/unstage`, { all: true })).status).toBe(200);
    status = (await (await req(app, "GET", `/api/sessions/${id}/git/status`)).json()) as StatusBody;
    expect(status.staged).toEqual([]);
  });

  test("commit tanpa staged 409 dan pesan tidak valid 400", async () => {
    const { app, id } = await setup();

    const empty = await req(app, "POST", `/api/sessions/${id}/git/commit`, { message: "x" });
    expect(empty.status).toBe(409);
    expect(((await empty.json()) as ErrorBody).error).toBe("Tidak ada perubahan yang ter-stage.");

    for (const message of ["", "   ", "x".repeat(2001), 42]) {
      const response = await req(app, "POST", `/api/sessions/${id}/git/commit`, { message });
      expect(response.status).toBe(400);
    }
  });

  test("body bukan JSON, bukan objek, dan field asing ditolak 400", async () => {
    const { app, id } = await setup();

    const raw = await req(app, "POST", `/api/sessions/${id}/git/stage`, "bukan json");
    expect(raw.status).toBe(400);

    const array = await req(app, "POST", `/api/sessions/${id}/git/stage`, [1, 2]);
    expect(array.status).toBe(400);

    const foreign = await req(app, "POST", `/api/sessions/${id}/git/stage`, {
      paths: ["a.txt"],
      aneh: true,
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as ErrorBody).error).toBe('Field "aneh" tidak dikenal.');

    const foreignCommit = await req(app, "POST", `/api/sessions/${id}/git/commit`, {
      message: "x",
      amend: true,
    });
    expect(foreignCommit.status).toBe(400);

    const both = await req(app, "POST", `/api/sessions/${id}/git/stage`, { paths: ["a.txt"], all: true });
    expect(both.status).toBe(400);

    const traversal = await req(app, "POST", `/api/sessions/${id}/git/stage`, { paths: ["../luar.txt"] });
    expect(traversal.status).toBe(400);
  });

  test("sesi tidak ada 404", async () => {
    await initRepo(dir);
    const harness = await makeWorkflow();
    for (const [route, body] of [
      ["stage", { paths: ["a.txt"] }],
      ["unstage", { paths: ["a.txt"] }],
      ["commit", { message: "x" }],
    ] as const) {
      const response = await req(harness.app, "POST", `/api/sessions/tidak-ada/git/${route}`, body);
      expect(response.status).toBe(404);
    }
  });

  test("sesi berjalan 409 untuk semua rute tulis", async () => {
    await initRepo(dir);
    // Runner yang menahan giliran sampai dibatalkan: status tetap `berjalan`.
    const harness = await makeWorkflow({
      runner: {
        async *run(input) {
          yield { type: "text", text: "menunggu" };
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted === true) {
              resolve();
              return;
            }
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "result", ok: false, error: "dibatalkan" };
        },
      },
    });
    const id = await createSession(harness, { cwd: dir });
    expect(harness.manager.get(id)?.status).toBe("berjalan");

    for (const [route, body] of [
      ["stage", { paths: ["a.txt"] }],
      ["unstage", { paths: ["a.txt"] }],
      ["commit", { message: "x" }],
    ] as const) {
      const response = await req(harness.app, "POST", `/api/sessions/${id}/git/${route}`, body);
      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorBody).error).toBe(
        "Sesi sedang berjalan; tunggu selesai sebelum mengubah git.",
      );
    }
    harness.manager.interrupt(id);
    await harness.manager.done(id);
  });

  test("JEJAK_GIT_WRITE=0 menjawab 403, JEJAK_GIT=0 menjawab 503", async () => {
    await initRepo(dir);
    const readOnly = await makeWorkflow({
      env: { MOCK: "true", JEJAK_HOME: home, JEJAK_GIT_WRITE: "0" },
    });
    const id = await idleSession(readOnly, { cwd: dir });
    for (const [route, body] of [
      ["stage", { paths: ["a.txt"] }],
      ["unstage", { paths: ["a.txt"] }],
      ["commit", { message: "x" }],
    ] as const) {
      const response = await req(readOnly.app, "POST", `/api/sessions/${id}/git/${route}`, body);
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorBody).error).toBe("Penulisan git dimatikan.");
    }

    const off = await makeWorkflow({ env: { MOCK: "true", JEJAK_HOME: home, JEJAK_GIT: "0" } });
    const id2 = await idleSession(off, { cwd: dir });
    for (const [route, body] of [
      ["stage", { paths: ["a.txt"] }],
      ["unstage", { paths: ["a.txt"] }],
      ["commit", { message: "x" }],
    ] as const) {
      const response = await req(off.app, "POST", `/api/sessions/${id2}/git/${route}`, body);
      expect(response.status).toBe(503);
      expect(((await response.json()) as ErrorBody).error).toBe("Panel git dimatikan.");
    }
  });

  test("param repo workspace dipakai untuk stage dan commit", async () => {
    await initRepo(repoB);
    const harness = await makeWorkflow();
    const id = await idleSession(harness, { workspaceId: harness.workspaceId, cwd: repoA });
    await writeFile(join(repoB, "web.txt"), "isi\n");

    expect(
      (await req(harness.app, "POST", `/api/sessions/${id}/git/stage`, {
        paths: ["web.txt"],
        repo: "web",
      })).status,
    ).toBe(200);
    const commit = await req(harness.app, "POST", `/api/sessions/${id}/git/commit`, {
      message: "web",
      repo: "web",
    });
    expect(commit.status).toBe(200);
    expect(((await commit.json()) as { subject: string }).subject).toBe("web");
    expect((await git(repoB, ["status", "--porcelain"])).trim()).toBe("");
  });
});
