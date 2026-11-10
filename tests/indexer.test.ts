import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterError, GitLabAdapter, LocalAdapter, createAdapter } from "../src/server/gitprovider/adapters";
import {
  FileGitProviderStore,
  GitProviderError,
  normalizeBaseUrl,
  viewOf,
  type GitProviderProfile,
} from "../src/server/gitprovider/provider-store";
import { IndexerError, RepoIndexer, repoKey } from "../src/server/indexer/repo-indexer";

let dir: string;
let projects: string;
let cache: string;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "user.name=Uji", "-c", "user.email=uji@example.test", "-c", "commit.gpgsign=false", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(projects, name);
  await mkdir(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "# Layanan order\nTabel orders ditulis di sini.\n");
  await writeFile(join(repo, "src", "app.ts"), "export const kolom = 'orders.status';\n");
  await writeFile(join(repo, ".env"), "TOKEN=rahasia-sintetis-123456\n");
  await writeFile(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "awal");
  return repo;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-indexer-"));
  projects = join(dir, "proyek");
  cache = join(dir, "cache");
  await mkdir(projects, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LOCAL = (): GitProviderProfile => ({ id: "lokal", name: "Lokal", kind: "local", root: projects });

describe("penyimpanan penyedia", () => {
  test("validasi, token tidak bocor di view, token dipertahankan, berkas 0600", async () => {
    const path = join(dir, "gp", "git-providers.json");
    const store = new FileGitProviderStore(path);
    const saved = store.put("gl", { name: "GitLab kantor", kind: "gitlab", baseUrl: "https://git.example.test/", token: "glpat-uji12345678" });
    expect(saved.baseUrl).toBe("https://git.example.test");
    expect(JSON.stringify(viewOf(saved))).not.toContain("glpat");
    expect(viewOf(saved).hasToken).toBe(true);
    const kept = store.put("gl", { name: "GitLab kantor 2" });
    expect(kept.token).toBe("glpat-uji12345678");
    expect(store.put("gl", { token: "" }).token).toBeUndefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(new FileGitProviderStore(path).list()).toHaveLength(1);
    expect(store.delete("gl")).toBe(true);
    expect(store.delete("gl")).toBe(false);
  });

  test("galat: id, jenis, alamat, token pada lokal, folder tak ada", () => {
    const store = new FileGitProviderStore(":memory:");
    expect(() => store.put("BURUK", { name: "x", kind: "local", root: projects })).toThrow(GitProviderError);
    expect(() => store.put("a", { name: "x", kind: "svn" })).toThrow(GitProviderError);
    expect(() => store.put("a", { name: "x", kind: "gitlab", baseUrl: "http://git.example.test" })).toThrow(/https/);
    expect(() => store.put("a", { name: "x", kind: "gitlab", baseUrl: "https://u:p@git.example.test" })).toThrow(/kredensial/);
    expect(() => store.put("a", { name: "x", kind: "local", root: projects, token: "abc" })).toThrow(/token/);
    expect(() => store.put("a", { name: "x", kind: "local", root: join(dir, "nihil") })).toThrow(GitProviderError);
    expect(normalizeBaseUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });
});

describe("adapter", () => {
  test("GitLab: header token, paginasi, redirect ditolak, 401, bentuk salah", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `p${i}`,
        path_with_namespace: `grup/p${i}`,
        http_url_to_repo: `https://git.example.test/grup/p${i}.git`,
        default_branch: "main",
      }));
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const pageNo = Number(new URL(String(url)).searchParams.get("page"));
      return new Response(JSON.stringify(pageNo === 1 ? page(100) : page(3)));
    }) as unknown as typeof fetch;
    const adapter = new GitLabAdapter("https://git.example.test", "glpat-uji12345678", { fetch: fake });
    const repos = await adapter.listRepos();
    expect(repos).toHaveLength(103);
    expect(repos[0]).toMatchObject({ name: "p0", fullPath: "grup/p0", defaultBranch: "main" });
    expect((calls[0]?.init?.headers as Record<string, string>)["private-token"]).toBe("glpat-uji12345678");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls).toHaveLength(2);

    const denied = new GitLabAdapter("https://git.example.test", "x", { fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
    await expect(denied.listRepos()).rejects.toThrow(/menolak token/);
    const odd = new GitLabAdapter("https://git.example.test", "x", { fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(odd.listRepos()).rejects.toThrow(AdapterError);
    const down = new GitLabAdapter("https://git.example.test", "x", { fetch: (async () => { throw new Error("jaringan"); }) as unknown as typeof fetch });
    await expect(down.listRepos()).rejects.toThrow(/koneksi gagal/);
  });

  test("Lokal: hanya folder berisi .git", async () => {
    await makeRepo("order");
    await mkdir(join(projects, "bukan-repo"));
    const repos = await new LocalAdapter(projects).listRepos();
    expect(repos.map((r) => r.fullPath)).toEqual(["order"]);
    expect(repos[0]?.cloneUrl).toBe(pathToFileURL(join(projects, "order")).href);
    expect(createAdapter(LOCAL())).toBeInstanceOf(LocalAdapter);
  });
});

describe("indexer", () => {
  async function indexed() {
    await makeRepo("order");
    const indexer = new RepoIndexer({ root: cache, now: () => new Date("2026-11-10T08:00:00Z") });
    const [repo] = await new LocalAdapter(projects).listRepos();
    const meta = await indexer.index(LOCAL(), repo!);
    return { indexer, meta, repo: repo! };
  }

  test("clone dangkal, meta, daftar berkas tanpa rahasia", async () => {
    const { indexer, meta } = await indexed();
    expect(meta.key).toBe(repoKey("lokal", "order"));
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.branch).toBe("main");
    expect(meta.source).toBe("indeks");
    expect(meta.indexedAt).toBe("2026-11-10T08:00:00.000Z");
    const { files } = await indexer.files(meta.key);
    expect(files).toContain("README.md");
    expect(files).toContain("src/app.ts");
    expect(files).not.toContain(".env");
    expect(indexer.list()).toHaveLength(1);
    expect((await stat(join(cache, meta.key, "meta.json"))).mode & 0o777).toBe(0o600);
  });

  test("baca berkas: ok, rahasia/.git/biner/di luar ditolak, besar dipotong", async () => {
    const { indexer, meta } = await indexed();
    const ok = await indexer.read(meta.key, "src/app.ts");
    expect(ok.content).toContain("orders.status");
    for (const path of [".env", ".git/config", "blob.bin", "../meta.json", "/etc/passwd"]) {
      await expect(indexer.read(meta.key, path)).rejects.toThrow(IndexerError);
    }
    await expect(indexer.read(meta.key, "tidak-ada.txt")).rejects.toThrow(/tidak ditemukan/);
    await expect(indexer.read("0123456789abcdef", "a")).rejects.toThrow(/tidak ditemukan/);
    await expect(indexer.read("../x", "a")).rejects.toThrow(/tidak valid/);
  });

  test("pencarian teks tetap dan penyaringan rahasia", async () => {
    const { indexer } = await indexed();
    const hits = await indexer.search("orders.status");
    expect(hits.join("\n")).toContain("order:src/app.ts:1:");
    expect(await indexer.search("rahasia-sintetis")).toEqual([]);
    await expect(indexer.search("  ")).rejects.toThrow(IndexerError);
  });

  test("refresh mengambil commit baru dan hapus membersihkan cache", async () => {
    const { indexer, meta, repo } = await indexed();
    const source = join(projects, "order");
    await writeFile(join(source, "baru.txt"), "tambahan\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "kedua");
    const again = await indexer.index(LOCAL(), repo);
    expect(again.commit).not.toBe(meta.commit);
    expect((await indexer.files(meta.key)).files).toContain("baru.txt");
    await indexer.remove(meta.key);
    expect(indexer.list()).toHaveLength(0);
    expect(() => indexer.get(meta.key)).toThrow(/tidak ditemukan/);
  });

  test("alamat clone dari luar penyedia ditolak; token tidak masuk meta atau askpass", async () => {
    const indexer = new RepoIndexer({ root: cache });
    const gl: GitProviderProfile = { id: "gl", name: "GL", kind: "gitlab", baseUrl: "https://git.example.test", token: "glpat-uji12345678" };
    await expect(
      indexer.index(gl, { name: "x", fullPath: "g/x", cloneUrl: "https://jahat.example.net/g/x.git" }),
    ).rejects.toThrow(/tidak berasal/);
    await expect(
      indexer.index(gl, { name: "x", fullPath: "g/x", cloneUrl: "https://u:p@git.example.test/g/x.git" }),
    ).rejects.toThrow(/kredensial/);
    await expect(
      indexer.index(LOCAL(), { name: "x", fullPath: "x", cloneUrl: "https://git.example.test/x.git" }),
    ).rejects.toThrow(/file/);
    // Clone gagal (host tak ada): galat bersih tanpa token, tanpa sisa cache.
    const err = await indexer
      .index({ ...gl, baseUrl: "http://127.0.0.1:9" }, { name: "x", fullPath: "g/x", cloneUrl: "http://127.0.0.1:9/g/x.git" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(String((err as Error).message)).not.toContain("glpat");
    expect(indexer.list()).toHaveLength(0);
    const askpass = await readFile(join(cache, "askpass.sh"), "utf8");
    expect(askpass).not.toContain("glpat");
  });
});
