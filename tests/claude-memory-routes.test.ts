import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { claudeMemoryRoutes } from "../src/server/routes/claude-memory";
import { claudeProjectEntries } from "../src/server/memory/claude-memory";
import { authGuard } from "../src/server/auth/auth-guard";
import { createSessionCodec } from "../src/server/auth/session-cookie";

let dir: string;
let claudeRoot: string;
let projectPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-claude-routes-"));
  claudeRoot = join(dir, "claude");
  projectPath = join(dir, "proyek");
  await mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeClaudeMemory(
  project: string,
  name: string,
  content: string,
): Promise<string> {
  const slug = project.replace(/[^A-Za-z0-9]/g, "-");
  const folder = join(claudeRoot, "projects", slug, "memory");
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, content, "utf8");
  return path;
}

function makeApp(projects: string[] = [projectPath]): Elysia {
  return new Elysia().use(
    claudeMemoryRoutes({
      projects: () => claudeProjectEntries(projects.map((cwd) => ({ cwd }))),
      env: { CLAUDE_CONFIG_DIR: claudeRoot, JEJAK_HOME: join(dir, "jejak") },
    }),
  ) as unknown as Elysia;
}

function get(app: Elysia, path: string): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

interface DirBody {
  label: string;
  dirExists: boolean;
  items: { file: string; title: string; type: string; body: string }[];
}

interface Body {
  project: string;
  dirs: DirBody[];
}

describe("rute memory Claude Code", () => {
  test("200 dengan daftar item", async () => {
    await writeClaudeMemory(
      projectPath,
      "satu.md",
      "---\nname: satu\ndescription: ringkasan\nmetadata:\n  type: project\n---\nIsi satu.\n",
    );
    const app = makeApp();
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.project).toBe("proyek");
    expect(body.dirs).toHaveLength(1);
    expect(body.dirs[0]!.dirExists).toBe(true);
    expect(body.dirs[0]!.items).toHaveLength(1);
    expect(body.dirs[0]!.items[0]!.title).toBe("satu");
    expect(body.dirs[0]!.items[0]!.type).toBe("project");
    expect(body.dirs[0]!.items[0]!.body).toBe("Isi satu.");
  });

  test("proyek tak dikenal 404 dengan pesan Indonesia", async () => {
    const app = makeApp();
    const res = await get(app, "/api/memory/claude?project=/tidak/ada");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Proyek tidak dikenal." });
  });

  test("parameter project kosong 400", async () => {
    const app = makeApp();
    const res = await get(app, "/api/memory/claude?project=");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Parameter project wajib diisi." });
  });

  test("parameter tak dikenal 400", async () => {
    const app = makeApp();
    const res = await get(
      app,
      `/api/memory/claude?project=${encodeURIComponent(projectPath)}&x=1`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Parameter "x" tidak dikenal.' });
  });

  test("folder Claude tak ada: dirExists false tanpa galat", async () => {
    const app = makeApp();
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.dirs[0]!.dirExists).toBe(false);
    expect(body.dirs[0]!.items).toEqual([]);
  });

  test("tidak ada penulisan: folder Claude tak berubah", async () => {
    const path = await writeClaudeMemory(
      projectPath,
      "satu.md",
      "---\nname: satu\n---\nIsi satu.\n",
    );
    const before = await readdir(join(claudeRoot, "projects"));
    const beforeFiles = await readdir(
      join(claudeRoot, "projects", projectPath.replace(/[^A-Za-z0-9]/g, "-"), "memory"),
    );
    const app = makeApp();
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(200);
    const after = await readdir(join(claudeRoot, "projects"));
    const afterFiles = await readdir(
      join(claudeRoot, "projects", projectPath.replace(/[^A-Za-z0-9]/g, "-"), "memory"),
    );
    expect(after).toEqual(before);
    expect(afterFiles).toEqual(beforeFiles);
    expect(await Bun.file(path).text()).toContain("Isi satu.");
  });

  test("tanpa autentikasi ditolak 401", async () => {
    const codec = createSessionCodec({ port: 3000 });
    const app = new Elysia()
      .use(authGuard({ codec }))
      .use(
        claudeMemoryRoutes({
          projects: () => claudeProjectEntries([{ cwd: projectPath }]),
          env: { CLAUDE_CONFIG_DIR: claudeRoot, JEJAK_HOME: join(dir, "jejak") },
        }),
      ) as unknown as Elysia;
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "perlu login" });
  });

  test("path menthah dan path ter-resolve digabung", async () => {
    // Folder Claude dibuat dari path yang sudah di-resolve (symlink `/var`).
    const resolved = await realpath(projectPath);
    await writeClaudeMemory(
      resolved,
      "ter-resolve.md",
      "---\nname: ter-resolve\n---\nIsi ter-resolve.\n",
    );
    await writeClaudeMemory(
      projectPath,
      "mentah.md",
      "---\nname: mentah\n---\nIsi mentah.\n",
    );
    const app = makeApp();
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(projectPath)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    const files = body.dirs[0]!.items.map((item) => item.file).sort();
    expect(files).toEqual(["mentah.md", "ter-resolve.md"]);
  });
});

describe("pemetaan worktree", () => {
  test("worktree Jejak juga membaca folder repo asal", async () => {
    const worktrees = join(dir, "jejak", "worktrees", "s-1");
    const repoRoot = join(dir, "repo-asli");
    await mkdir(worktrees, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeClaudeMemory(
      repoRoot,
      "asal.md",
      "---\nname: asal\n---\nIsi repo asal.\n",
    );
    const app = new Elysia().use(
      claudeMemoryRoutes({
        projects: () =>
          claudeProjectEntries([
            {
              cwd: worktrees,
              worktree: { path: worktrees, repoRoot },
            },
          ]),
        env: { CLAUDE_CONFIG_DIR: claudeRoot, JEJAK_HOME: join(dir, "jejak") },
      }),
    ) as unknown as Elysia;
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(worktrees)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.dirs).toHaveLength(2);
    expect(body.dirs[1]!.label).toBe("repo-asli");
    expect(body.dirs[1]!.items.map((item) => item.file)).toEqual(["asal.md"]);
  });

  test("worktree tanpa data repo asal hanya membaca folder proyek", async () => {
    const worktrees = join(dir, "jejak", "worktrees", "s-2");
    await mkdir(worktrees, { recursive: true });
    const app = new Elysia().use(
      claudeMemoryRoutes({
        projects: () => claudeProjectEntries([{ cwd: worktrees }]),
        env: { CLAUDE_CONFIG_DIR: claudeRoot, JEJAK_HOME: join(dir, "jejak") },
      }),
    ) as unknown as Elysia;
    const res = await get(app, `/api/memory/claude?project=${encodeURIComponent(worktrees)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.dirs).toHaveLength(1);
  });
});
