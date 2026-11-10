import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { FileGitProviderStore } from "../src/server/gitprovider/provider-store";
import { IndexTools } from "../src/server/indexer/index-tools";
import { RepoIndexer } from "../src/server/indexer/repo-indexer";
import { checkSecretAccess } from "../src/server/security/secret-paths";

let dir: string;
let projects: string;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "user.name=Uji", "-c", "user.email=uji@example.test", "-c", "commit.gpgsign=false", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-idx-routes-"));
  projects = join(dir, "proyek");
  const repo = join(projects, "billing");
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "src", "queue.ts"), "export const QUEUE = 'billing.invoice';\n");
  await writeFile(join(repo, ".env"), "KUNCI=rahasia-sintetis\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "awal");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(enabled = true) {
  const audit = new SqliteAuditStore(":memory:");
  const indexer = new RepoIndexer({ root: join(dir, "cache") });
  const app = createApp({
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    ...(enabled ? { gitProviders: new FileGitProviderStore(":memory:"), indexer } : {}),
  });
  const req = (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { req, audit, indexer };
}

describe("rute indexer", () => {
  test("alur penyedia lokal: simpan, daftar repo, indeks, berkas, baca, hapus", async () => {
    const { req, audit } = setup();
    const put = await req("PUT", "/api/git-providers/lokal", { name: "Lokal", kind: "local", root: projects });
    expect(put.status).toBe(200);
    const providers = (await (await req("GET", "/api/git-providers")).json()) as { providers: Array<{ hasToken: boolean }> };
    expect(providers.providers).toHaveLength(1);

    const remote = (await (await req("GET", "/api/git-providers/lokal/repos")).json()) as {
      repos: Array<{ fullPath: string; indexed: boolean }>;
    };
    expect(remote.repos).toEqual([expect.objectContaining({ fullPath: "billing", indexed: false })]);

    const created = await req("POST", "/api/index/repos", { providerId: "lokal", fullPath: "billing" });
    expect(created.status).toBe(200);
    const meta = (await created.json()) as { key: string; source: string; files: number };
    expect(meta.source).toBe("indeks");
    expect(meta.files).toBe(1);

    const list = (await (await req("GET", "/api/index/repos")).json()) as { repos: unknown[] };
    expect(list.repos).toHaveLength(1);
    const files = (await (await req("GET", `/api/index/repos/${meta.key}/files`)).json()) as { files: string[] };
    expect(files.files).toEqual(["src/queue.ts"]);
    const file = (await (await req("GET", `/api/index/repos/${meta.key}/file?path=src/queue.ts`)).json()) as { content: string };
    expect(file.content).toContain("billing.invoice");
    expect((await req("GET", `/api/index/repos/${meta.key}/file?path=.env`)).status).toBe(400);
    expect((await req("GET", `/api/index/repos/${meta.key}/file?path=../x`)).status).toBe(400);

    expect((await req("DELETE", `/api/index/repos/${meta.key}`, {})).status).toBe(200);
    expect((await req("DELETE", `/api/index/repos/${meta.key}`, {})).status).toBe(404);
    const summaries = audit.list({ kind: "pengaturan", limit: 20 }).map((e) => e.summary);
    expect(summaries).toContain("Indexer: repo-diindeks");
    audit.close();
  });

  test("token tidak pernah muncul di respons; galat dan 503", async () => {
    const { req, audit } = setup();
    const saved = await req("PUT", "/api/git-providers/gl", {
      name: "GitLab",
      kind: "gitlab",
      baseUrl: "https://git.example.test",
      token: "glpat-uji12345678",
    });
    expect(JSON.stringify(await saved.json())).not.toContain("glpat");
    expect(JSON.stringify(await (await req("GET", "/api/git-providers")).json())).not.toContain("glpat");
    expect((await req("PUT", "/api/git-providers/x", { name: "x", kind: "svn" })).status).toBe(400);
    expect((await req("PUT", "/api/git-providers/x", { name: "x", kind: "local", root: projects, foo: 1 })).status).toBe(400);
    expect((await req("GET", "/api/git-providers/nihil/repos")).status).toBe(404);
    expect((await req("POST", "/api/index/repos", { providerId: "gl", fullPath: 5 })).status).toBe(400);
    expect((await req("DELETE", "/api/git-providers/gl", {})).status).toBe(200);
    audit.close();
    const off = setup(false);
    expect((await off.req("GET", "/api/git-providers")).status).toBe(503);
    expect((await off.req("GET", "/api/index/repos")).status).toBe(503);
    off.audit.close();
  });
});

describe("tool index_*", () => {
  test("daftar, cari, baca dengan label indeks; rahasia dan repo tak dikenal ditolak", async () => {
    const indexer = new RepoIndexer({ root: join(dir, "cache2"), now: () => new Date("2026-11-10T08:00:00Z") });
    const store = new FileGitProviderStore(":memory:");
    const profile = store.put("lokal", { name: "Lokal", kind: "local", root: projects });
    const { LocalAdapter } = await import("../src/server/gitprovider/adapters");
    const [repo] = await new LocalAdapter(projects).listRepos();
    await indexer.index(profile, repo!);
    const tools = new IndexTools(indexer);
    const ctx = { sessionId: "s1", projectKey: "/p", cwd: "/p" };

    const listed = await tools.call(ctx, "index_repos", {});
    expect(listed.text).toContain("mungkin tertinggal");
    expect(listed.text).toContain("billing @");
    const hit = await tools.call(ctx, "index_search", { query: "billing.invoice" });
    expect(hit.text).toContain("billing:src/queue.ts");
    expect((await tools.call(ctx, "index_search", { query: "rahasia-sintetis" })).text).toContain("Tidak ada");
    const read = await tools.call(ctx, "index_file", { repo: "billing", path: "src/queue.ts" });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("diindeks 2026-11-10");
    expect((await tools.call(ctx, "index_file", { repo: "billing", path: ".env" })).isError).toBe(true);
    expect((await tools.call(ctx, "index_file", { repo: "lain", path: "a" })).isError).toBe(true);
    expect((await tools.call(ctx, "index_repos", { x: 1 })).isError).toBe(true);
    expect((await tools.call(ctx, "lain", {})).isError).toBe(true);
  });
});

test("Bash yang menyebut /api/git-providers diblokir", () => {
  const verdict = checkSecretAccess({
    toolName: "Bash",
    toolInput: { command: "curl -X PUT http://127.0.0.1:3000/api/git-providers/gl -d '{}'" },
    cwd: "/proyek/uji",
    home: "/rumah/uji",
  });
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("git-providers-api");
});
