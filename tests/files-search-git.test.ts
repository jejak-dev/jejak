import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { searchText } from "../src/server/files/search";

let dir: string;
let luar: string;
let home: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-search-git-"));
  luar = await mkdtemp(join(tmpdir(), "jejak-search-luar-"));
  home = await mkdtemp(join(tmpdir(), "jejak-search-git-home-"));
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
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  await mkdir(join(dir, "build"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), "build/\n");
  await writeFile(join(dir, "a.txt"), "foo123 bar\n");
  await writeFile(join(dir, "root.ts"), "foo root\n");
  await writeFile(join(dir, "src", "app.ts"), "const foo = 1;\n");
  await writeFile(join(dir, "docs", "d.md"), "foo docs\n");
  await writeFile(join(dir, "build", "ignored.txt"), "foo ignored\n");
  await writeFile(join(dir, "multi.txt"), "xx foo yy foo\n");
  await writeFile(join(dir, "multi byte.txt"), "é foo z\n");
  await writeFile(join(dir, "cat.txt"), "cat concatenate cat\n");
  await writeFile(join(dir, "weird:name file.txt"), "foo weird\n");
  await writeFile(join(dir, "upper.txt"), "FOO\n");
  await writeFile(join(dir, "lower.txt"), "foo\n");
  await git(dir, ["init", "-q", "."]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "awal"]);
  // Berkas untracked yang tidak diabaikan .gitignore.
  await writeFile(join(dir, "untracked.txt"), "foo untracked\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(luar, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
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
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} gagal: ${await new Response(proc.stderr).text()}`);
  }
  return out;
}

type App = ReturnType<typeof createApp>;

function completedRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

function makeApp(): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    runner: completedRunner(),
  });
}

function req(app: App, method: string, path: string): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, { method, headers: { host: "127.0.0.1:3000" } }),
  );
}

async function createSession(app: App, cwd = dir): Promise<string> {
  const created = await app.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd }),
    }),
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { session: { id: string } }).session.id;
}

function searchUrl(id: string, query: string, extra = ""): string {
  return `/api/sessions/${id}/search?q=${encodeURIComponent(query)}${extra}`;
}

describe("pencarian dengan git grep", () => {
  test(".gitignore dihormati, untracked ikut, engine git", async () => {
    const result = await searchText(dir, "foo");
    expect(result.engine).toBe("git");
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("untracked.txt");
    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("build/ignored.txt");
    expect(result.files).toBe(new Set(paths).size);
  });

  test("regex PCRE didukung (\\d)", async () => {
    const result = await searchText(dir, "foo\\d+", { regex: true });
    expect(result.engine).toBe("git");
    expect(result.matches.map((match) => match.path)).toEqual(["a.txt"]);
    expect(result.matches[0]?.text).toBe("foo123 bar");
  });

  test("wholeWord tidak cocok di dalam kata lain", async () => {
    const loose = await searchText(dir, "cat");
    expect(loose.matches[0]?.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 7, end: 10 },
      { start: 16, end: 19 },
    ]);
    const whole = await searchText(dir, "cat", { wholeWord: true });
    expect(whole.matches).toHaveLength(1);
    expect(whole.matches[0]?.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 16, end: 19 },
    ]);
  });

  test("peka dan tak peka huruf besar-kecil", async () => {
    const insensitive = await searchText(dir, "foo");
    const paths = insensitive.matches.map((match) => match.path);
    expect(paths).toContain("upper.txt");
    expect(paths).toContain("lower.txt");
    const sensitive = await searchText(dir, "foo", { caseSensitive: true });
    const sensitivePaths = sensitive.matches.map((match) => match.path);
    expect(sensitivePaths).not.toContain("upper.txt");
    expect(sensitivePaths).toContain("lower.txt");
  });

  test("include dan exclude memakai pathspec git", async () => {
    const result = await searchText(dir, "foo", {
      include: ["**/*.ts", "**/*.md"],
      exclude: ["docs/**"],
    });
    expect(result.matches.map((match) => match.path)).toEqual(["root.ts", "src/app.ts"]);

    // Tanpa include: seluruh repo dipindai, lalu dikecualikan.
    const excluded = await searchText(dir, "foo", { exclude: ["docs/**", "**/*.ts"] });
    const paths = excluded.matches.map((match) => match.path);
    expect(paths).toContain("a.txt");
    expect(paths).not.toContain("docs/d.md");
    expect(paths).not.toContain("src/app.ts");
  });

  test("rentang dua kemunculan dan karakter multibyte", async () => {
    const multi = await searchText(dir, "foo", { include: ["multi.txt"] });
    expect(multi.matches[0]?.ranges).toEqual([
      { start: 3, end: 6 },
      { start: 10, end: 13 },
    ]);
    const byte = await searchText(dir, "foo", { include: ["multi byte.txt"] });
    expect(byte.matches[0]?.ranges).toEqual([{ start: 2, end: 5 }]);
  });

  test("rentang pada pola regex memakai keluaran -o", async () => {
    await writeFile(join(dir, "re.txt"), "foo1 dan foo2 foo3\n");
    await writeFile(join(dir, "re byte.txt"), "é foo1 foo2\n");
    const result = await searchText(dir, "foo[0-9]+", { regex: true });
    const re = result.matches.find((match) => match.path === "re.txt");
    expect(re?.ranges).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
      { start: 14, end: 18 },
    ]);
    const multibyte = result.matches.find((match) => match.path === "re byte.txt");
    expect(multibyte?.ranges).toEqual([
      { start: 2, end: 6 },
      { start: 7, end: 11 },
    ]);
  });

  test("rentang regex PCRE dengan \\d dan multibyte", async () => {
    await writeFile(join(dir, "pc.txt"), "é foo1 foo22\n");
    const result = await searchText(dir, "foo\\d+", { regex: true });
    const pc = result.matches.find((match) => match.path === "pc.txt");
    expect(pc?.ranges).toEqual([
      { start: 2, end: 6 },
      { start: 7, end: 12 },
    ]);
  });

  test("nama berkas berisi titik dua dan spasi terbaca", async () => {
    const result = await searchText(dir, "weird");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("weird:name file.txt");
    expect(result.matches[0]?.text).toBe("foo weird");
  });

  test("tanpa hasil mengembalikan daftar kosong", async () => {
    const result = await searchText(dir, "tidak-ada-sama-sekali");
    expect(result.matches).toEqual([]);
    expect(result.engine).toBe("git");
    expect(result.truncated).toBe(false);
  });
});

describe("pencarian di luar repo git", () => {
  test("engine scan, literal, wholeWord, dan include berfungsi", async () => {
    await writeFile(join(luar, "a.txt"), "cat concatenate\n");
    await writeFile(join(luar, "b.ts"), "cat\n");
    const literal = await searchText(luar, "cat");
    expect(literal.engine).toBe("scan");
    expect(literal.matches.map((match) => match.path).sort()).toEqual(["a.txt", "b.ts"]);
    const whole = await searchText(luar, "cat", { wholeWord: true });
    expect(whole.matches.map((match) => match.path).sort()).toEqual(["a.txt", "b.ts"]);
    const included = await searchText(luar, "cat", { include: ["*.ts"] });
    expect(included.matches.map((match) => match.path)).toEqual(["b.ts"]);
  });
});

describe("GET /api/sessions/:id/search di repo git", () => {
  test("regex, wholeWord, include, dan exclude diteruskan", async () => {
    const app = makeApp();
    const id = await createSession(app);

    const regex = await req(app, "GET", searchUrl(id, "foo[0-9]+", "&regex=1"));
    expect(regex.status).toBe(200);
    const regexBody = (await regex.json()) as { engine: string; matches: Array<{ path: string }> };
    expect(regexBody.engine).toBe("git");
    expect(regexBody.matches.map((match) => match.path)).toEqual(["a.txt"]);

    const word = await req(app, "GET", searchUrl(id, "cat", "&word=1"));
    const wordBody = (await word.json()) as { matches: Array<{ ranges?: unknown }> };
    expect(wordBody.matches).toHaveLength(1);

    const scoped = await req(
      app,
      "GET",
      searchUrl(
        id,
        "foo",
        `&include=${encodeURIComponent("**/*.ts,**/*.md")}&exclude=${encodeURIComponent("docs/**")}`,
      ),
    );
    const scopedBody = (await scoped.json()) as { matches: Array<{ path: string }> };
    expect(scopedBody.matches.map((match) => match.path)).toEqual(["root.ts", "src/app.ts"]);
  });

  test("regex tidak valid -> 400", async () => {
    const app = makeApp();
    const id = await createSession(app);
    const res = await req(app, "GET", searchUrl(id, "(", "&regex=1"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Pola regex tidak valid.");
  });

  test("glob tidak valid -> 400", async () => {
    const app = makeApp();
    const id = await createSession(app);
    const res = await req(app, "GET", searchUrl(id, "foo", `&include=${encodeURIComponent("../x")}`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Pola berkas tidak valid.");
  });
});

describe("GET /api/sessions/:id/search di luar repo git", () => {
  test("regex -> 400 Regex memerlukan repo git.", async () => {
    await writeFile(join(luar, "a.txt"), "foo1\n");
    const app = makeApp();
    const id = await createSession(app, luar);
    const res = await req(app, "GET", searchUrl(id, "foo\\d+", "&regex=1"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Regex memerlukan repo git.");
  });
});
