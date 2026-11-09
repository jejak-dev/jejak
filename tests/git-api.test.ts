import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
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
    runner: createMockRunner(),
    workspaces: service,
    ...extra,
  });
  return { app, workspaceId: workspace.id };
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
