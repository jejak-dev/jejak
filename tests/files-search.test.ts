import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { searchText } from "../src/server/files/search";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let dir: string;
let outside: string;
let home: string;
let providersFile: string;
let repoB: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-search-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-search-outside-"));
  home = await mkdtemp(join(tmpdir(), "jejak-search-home-"));
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

async function createSession(app: App, cwd = dir, workspaceId?: string): Promise<string> {
  const body: Record<string, unknown> = { prompt: "Halo", cwd };
  if (workspaceId !== undefined) body.workspaceId = workspaceId;
  const created = await app.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { session: { id: string } }).session.id;
}

function searchUrl(id: string, query: string, extra = ""): string {
  return `/api/sessions/${id}/search?q=${encodeURIComponent(query)}${extra}`;
}

interface SearchBody {
  matches: Array<{ path: string; line: number; text: string }>;
  files: number;
  truncated: boolean;
}

describe("searchText", () => {
  test("literal, bukan regex, dan tak peka huruf besar-kecil", async () => {
    await writeFile(join(dir, "a.txt"), "baris satu\nHalo Dunia\n");
    await writeFile(join(dir, "b.txt"), "tidak ada\n");
    const result = await searchText(dir, "halo dunia");
    expect(result.matches).toEqual([{ path: "a.txt", line: 2, text: "Halo Dunia" }]);
    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);

    const regex = await searchText(dir, "a.*b");
    expect(regex.matches).toEqual([]);
  });

  test("caseSensitive hanya mencocokkan persis", async () => {
    await writeFile(join(dir, "a.txt"), "Halo\nhalo\n");
    const insensitive = await searchText(dir, "HALO");
    expect(insensitive.matches.map((m) => m.line)).toEqual([1, 2]);
    const sensitive = await searchText(dir, "Halo", { caseSensitive: true });
    expect(sensitive.matches.map((m) => m.line)).toEqual([1]);
  });

  test("melewati node_modules, .git, dist, dan symlink", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "dist"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "x.js"), "kata kunci");
    await writeFile(join(dir, ".git", "config"), "kata kunci");
    await writeFile(join(dir, "dist", "out.js"), "kata kunci");
    await writeFile(join(dir, "src", "ok.ts"), "kata kunci");
    await writeFile(join(outside, "luar.txt"), "kata kunci");
    await symlink(join(outside, "luar.txt"), join(dir, "tautan.txt"));
    await symlink(outside, join(dir, "folder-luar"));

    const result = await searchText(dir, "kata kunci");
    expect(result.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
    expect(result.files).toBe(1);
  });

  test("berkas biner dan berkas > 1 MB dilewati", async () => {
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x6b, 0x61, 0x74, 0x00, 0x61]));
    await writeFile(join(dir, "besar.txt"), `kata kunci\n${"x".repeat(1024 * 1024 + 10)}`);
    await writeFile(join(dir, "kecil.txt"), "kata kunci");
    const result = await searchText(dir, "kata kunci");
    expect(result.matches.map((m) => m.path)).toEqual(["kecil.txt"]);
  });

  test("batas kecocokan, berkas, dan tenggat menandai truncated", async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `kata ${index}`).join("\n");
    await writeFile(join(dir, "banyak.txt"), lines);
    const capped = await searchText(dir, "kata");
    expect(capped.matches.length).toBe(200);
    expect(capped.truncated).toBe(true);

    await writeFile(join(dir, "kedua.txt"), "kata");
    const filesCapped = await searchText(dir, "kata", { maxFiles: 1 });
    expect(filesCapped.truncated).toBe(true);
    expect(filesCapped.files).toBe(1);

    const timedOut = await searchText(dir, "kata", { deadlineMs: 0 });
    expect(timedOut.truncated).toBe(true);
    expect(timedOut.matches).toEqual([]);
  });

  test("teks dipotong 300 karakter dan line 1-based", async () => {
    await writeFile(join(dir, "panjang.txt"), `${"a".repeat(400)}jarum\n`);
    const result = await searchText(dir, "jarum");
    expect(result.matches[0]?.line).toBe(1);
    expect(result.matches[0]?.text.length).toBe(300);
  });
});

describe("GET /api/sessions/:id/search", () => {
  test("mencocokkan dan path relatif ber-/, sesi tak ada 404", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "cari AKU\n");
    const app = makeApp();
    const id = await createSession(app);

    const res = await req(app, "GET", searchUrl(id, "cari aku"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.matches).toEqual([{ path: "sub/a.txt", line: 1, text: "cari AKU" }]);
    expect(body.matches.every((match) => !match.path.startsWith("/"))).toBe(true);

    const sensitive = await req(app, "GET", searchUrl(id, "cari AKU", "&case=1"));
    expect(((await sensitive.json()) as SearchBody).matches.length).toBe(1);
    const sensitiveMiss = await req(app, "GET", searchUrl(id, "cari aku", "&case=1"));
    expect(((await sensitiveMiss.json()) as SearchBody).matches.length).toBe(0);

    const missing = await req(app, "GET", "/api/sessions/tidak-ada/search?q=x");
    expect(missing.status).toBe(404);
  });

  test("q tidak valid dan array -> 400", async () => {
    const app = makeApp();
    const id = await createSession(app);
    for (const path of [
      `/api/sessions/${id}/search`,
      searchUrl(id, ""),
      searchUrl(id, "x".repeat(201)),
      searchUrl(id, "a\nb"),
      `/api/sessions/${id}/search?q=${encodeURIComponent("a\u0000b")}`,
      `/api/sessions/${id}/search?q=a&q=b`,
    ]) {
      const res = await req(app, "GET", path);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Kata kunci tidak valid.");
    }
  });

  test("?repo= mencari di repo workspace", async () => {
    const service = new WorkspaceService({ dir: join(home, "workspaces") });
    const workspace = await service.create({
      name: "Kantor",
      repos: [{ name: "web", path: repoB }],
    });
    await writeFile(join(repoB, "web.txt"), "jarum di web\n");
    await writeFile(join(dir, "cwd.txt"), "jarum di cwd\n");
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: home },
      runner: completedRunner(),
      workspaces: service,
      undoDir: join(home, "undo"),
    });
    const id = await createSession(app, repoB, workspace.id);

    const res = await req(app, "GET", `${searchUrl(id, "jarum")}&repo=web`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.matches.map((match) => match.path)).toEqual(["web.txt"]);

    const plain = await req(app, "GET", searchUrl(id, "jarum"));
    expect(((await plain.json()) as SearchBody).matches.map((match) => match.path)).toEqual([
      "web.txt",
    ]);
  });
});
