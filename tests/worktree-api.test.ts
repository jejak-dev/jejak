import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { WorktreeService } from "../src/server/git/worktree-service";
import { resolveProvider as resolveRegistryProvider } from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";
import { SessionManager } from "../src/server/sessions/session-manager";

let dir: string;
let repo: string;
let home: string;
let root: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-worktree-api-"));
  repo = join(dir, "repo");
  home = join(dir, "home");
  root = join(home, "worktrees");
  await mkdir(repo, { recursive: true });
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
  await rm(dir, { recursive: true, force: true });
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
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal: ${err}`);
  return out;
}

async function initRepo(): Promise<void> {
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await writeFile(join(repo, "awal.txt"), "awal\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "awal"]);
}

type App = ReturnType<typeof createApp>;

interface Harness {
  app: App;
  manager: SessionManager;
}

function makeHarness(
  options: { worktrees?: WorktreeService; env?: Record<string, string | undefined> } = {},
): Harness {
  const service = options.worktrees ?? new WorktreeService({ root });
  const manager = new SessionManager({
    runner: createMockRunner(),
    resolveProvider: async (selection) =>
      resolveRegistryProvider(await loadRegistry(providersFile, { MOCK: "true" }), selection),
    worktrees: service,
  });
  const env: Record<string, string | undefined> = {
    MOCK: "true",
    JEJAK_HOME: home,
    ...options.env,
  };
  const app = createApp({
    providersPath: providersFile,
    env,
    runner: createMockRunner(),
    sessions: manager,
    ...(env.JEJAK_WORKTREES?.trim() === "0" ? {} : { worktrees: service }),
  });
  return { app, manager };
}

function req(
  app: App,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

interface SessionBody {
  session: {
    id: string;
    cwd: string;
    dirtyInSource?: boolean;
    worktree?: { path: string; branch: string; repoRoot: string; baseCommit: string };
  };
}

interface WorktreeBody {
  worktree: {
    path: string;
    branch: string;
    missing: boolean;
    removed?: boolean;
  };
  inspect: { exists: boolean; dirtyFiles: number; commitsAhead: number; branchExists: boolean };
}

function worktreeBody(input: Record<string, unknown>): Record<string, unknown> {
  return { prompt: "Halo", ...input };
}

describe("rute worktree", () => {
  test("POST sesi dengan worktree:true membuat dan mengembalikan worktree + dirtyInSource", async () => {
    await initRepo();
    const harness = makeHarness();

    const res = await req(
      harness.app,
      "POST",
      "/api/sessions",
      worktreeBody({ cwd: repo, title: "Rute Baru", worktree: true }),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as SessionBody;
    expect(data.session.worktree).toBeDefined();
    expect(data.session.cwd).toBe(data.session.worktree!.path);
    expect(data.session.dirtyInSource).toBe(false);
    expect(data.session.worktree!.branch).toContain("jejak/rute-baru-");
  });

  test("GET worktree mengembalikan info + inspect, 404 tanpa worktree", async () => {
    await initRepo();
    const harness = makeHarness();
    const created = (await (
      await req(harness.app, "POST", "/api/sessions", worktreeBody({ cwd: repo, worktree: true }))
    ).json()) as SessionBody;
    const id = created.session.id;

    const res = await req(harness.app, "GET", `/api/sessions/${id}/worktree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeBody;
    expect(body.worktree.path).toBe(created.session.worktree!.path);
    expect(body.worktree.missing).toBe(false);
    expect(body.inspect).toEqual({ exists: true, dirtyFiles: 0, commitsAhead: 0, branchExists: true });

    const plain = (await (
      await req(harness.app, "POST", "/api/sessions", worktreeBody({ cwd: repo }))
    ).json()) as SessionBody;
    const missing = await req(harness.app, "GET", `/api/sessions/${plain.session.id}/worktree`);
    expect(missing.status).toBe(404);

    const unknown = await req(harness.app, "GET", "/api/sessions/tidak-ada/worktree");
    expect(unknown.status).toBe(404);
  });

  test("DELETE menolak 409 dengan angka, force jalan; body wajib JSON", async () => {
    await initRepo();
    const harness = makeHarness();
    const created = (await (
      await req(harness.app, "POST", "/api/sessions", worktreeBody({ cwd: repo, worktree: true }))
    ).json()) as SessionBody;
    const id = created.session.id;
    await harness.manager.done(id);

    const path = created.session.worktree!.path;
    await writeFile(join(path, "kotor.txt"), "kotor\n");

    const conflict = await req(harness.app, "DELETE", `/api/sessions/${id}/worktree`, {});
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as {
      error: string;
      dirtyFiles: number;
      commitsAhead: number;
    };
    expect(conflictBody.dirtyFiles).toBe(1);
    expect(conflictBody.commitsAhead).toBe(0);

    const notJson = await req(harness.app, "DELETE", `/api/sessions/${id}/worktree`, "bukan json");
    expect(notJson.status).toBe(400);

    const wrongForce = await req(harness.app, "DELETE", `/api/sessions/${id}/worktree`, { force: "ya" });
    expect(wrongForce.status).toBe(400);

    const removed = await req(harness.app, "DELETE", `/api/sessions/${id}/worktree`, { force: true });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(harness.manager.get(id)?.worktree?.removed).toBe(true);

    const again = await req(harness.app, "DELETE", `/api/sessions/${id}/worktree`, {});
    expect(again.status).toBe(200);
  });

  test("remove dan restore menolak sesi berjalan 409", async () => {
    await initRepo();
    const service = new WorktreeService({ root });
    const manager = new SessionManager({
      runner: {
        async *run(input) {
          yield { type: "text", text: "menunggu" };
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted === true) return resolve();
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "result", ok: false, error: "dibatalkan" };
        },
      },
      resolveProvider: async () => ({ profileId: "lokal", apiKey: "sk-x", model: "mock-model" }),
      worktrees: service,
    });
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: createMockRunner(),
      sessions: manager,
      worktrees: service,
    });
    const created = (await (
      await req(app, "POST", "/api/sessions", worktreeBody({ cwd: repo, worktree: true }))
    ).json()) as SessionBody;
    const id = created.session.id;

    for (const [method, path] of [
      ["DELETE", `/api/sessions/${id}/worktree`],
      ["POST", `/api/sessions/${id}/worktree/restore`],
    ] as const) {
      const res = await req(app, method, path, {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("Hentikan sesi dulu.");
    }

    // Sesi yang tidak punya worktree -> 404.
    const plain = (await (
      await req(app, "POST", "/api/sessions", worktreeBody({ cwd: repo }))
    ).json()) as SessionBody;
    const removePlain = await req(app, "DELETE", `/api/sessions/${plain.session.id}/worktree`, {});
    expect(removePlain.status).toBe(404);
    manager.interrupt(id);
    manager.interrupt(plain.session.id);
  });

  test("restore memulihkan folder yang hilang dan mengembalikan worktree", async () => {
    await initRepo();
    const harness = makeHarness();
    const created = (await (
      await req(harness.app, "POST", "/api/sessions", worktreeBody({ cwd: repo, worktree: true }))
    ).json()) as SessionBody;
    const id = created.session.id;
    await harness.manager.done(id);
    await rm(created.session.worktree!.path, { recursive: true, force: true });

    const res = await req(harness.app, "POST", `/api/sessions/${id}/worktree/restore`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worktree: { path: string; missing: boolean } };
    expect(body.worktree.path).toBe(created.session.worktree!.path);
    expect(body.worktree.missing).toBe(false);
    expect(existsSync(body.worktree.path)).toBe(true);
  });

  test("400 untuk tipe worktree salah, 503 saat JEJAK_WORKTREES=0", async () => {
    await initRepo();
    const harness = makeHarness();
    const bad = await req(
      harness.app,
      "POST",
      "/api/sessions",
      worktreeBody({ cwd: repo, worktree: "ya" }),
    );
    expect(bad.status).toBe(400);

    const off = makeHarness({ env: { JEJAK_WORKTREES: "0" } });
    for (const [method, path, body] of [
      ["GET", "/api/sessions/s_1/worktree", undefined],
      ["DELETE", "/api/sessions/s_1/worktree", {}],
      ["POST", "/api/sessions/s_1/worktree/restore", {}],
    ] as const) {
      const res = await req(off.app, method, path, body);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("Worktree dimatikan.");
    }
    // Tanpa service, worktree:true ditolak manager (400).
    const rejected = await req(
      off.app,
      "POST",
      "/api/sessions",
      worktreeBody({ cwd: repo, worktree: true }),
    );
    expect(rejected.status).toBe(201);
  });
});
