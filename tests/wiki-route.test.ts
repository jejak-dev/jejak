import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { FileGitProviderStore } from "../src/server/gitprovider/provider-store";

let dir: string;
let projects: string;
let wikiSrc: string;
let providersFile: string;

const TOKEN = "glpat-rahasia-123456";

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
  dir = await mkdtemp(join(tmpdir(), "jejak-wiki-rute-"));
  projects = join(dir, "proyek");
  wikiSrc = join(dir, "wiki-src");
  providersFile = join(dir, "providers.json");
  const wikiRepo = join(wikiSrc, "panduan");
  await mkdir(join(wikiRepo, "panduan"), { recursive: true });
  git(wikiRepo, "init", "-q", "-b", "main");
  await writeFile(join(wikiRepo, "Home.md"), "# Beranda\nSelamat datang di wiki.\n");
  await writeFile(join(wikiRepo, "panduan", "deploy.md"), "# Deploy\nLangkah deploy.\n");
  await writeFile(join(wikiRepo, "_Sidebar.md"), "- [Beranda](Home)\n");
  git(wikiRepo, "add", "-A");
  git(wikiRepo, "commit", "-q", "-m", "awal");

  await mkdir(projects, { recursive: true });
  git(projects, "init", "-q", "-b", "main");
  git(projects, "remote", "add", "origin", "http://127.0.0.1:1/grup/proyek.git");

  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia-123",
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

/** Adapter GitLab palsu: tidak menyentuh jaringan sungguhan. */
const fakeFetch = (async () =>
  new Response(
    JSON.stringify([
      {
        path: "proyek",
        path_with_namespace: "grup/proyek",
        http_url_to_repo: "http://127.0.0.1:1/grup/proyek.git",
        default_branch: "main",
      },
    ]),
  )) as unknown as typeof fetch;

type App = ReturnType<typeof createApp>;

function setup(options: { withWiki?: boolean; withAuth?: boolean } = {}) {
  const audit = new SqliteAuditStore(":memory:");
  const store = new FileGitProviderStore(":memory:");
  const withWiki = options.withWiki !== false;
  if (withWiki) {
    store.put("lokal", { name: "Lokal", kind: "local", root: wikiSrc });
    store.put("gl", {
      name: "GitLab uji",
      kind: "gitlab",
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
    });
  }
  const app = createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    runner: createMockRunner(),
    audit,
    ...(withWiki ? { gitProviders: store, gitAdapterDeps: { fetch: fakeFetch } } : {}),
    ...(options.withAuth === true ? { auth: { password: "sandi-uji-123", port: 3000 } } : {}),
  });
  const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const head: Record<string, string> = { host: "127.0.0.1:3000", ...headers };
    const init: RequestInit = { method, headers: head };
    if (body !== undefined) {
      head["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { app, req, audit };
}

/** Buat sesi supaya foldernya dikenal server. */
async function buatSesi(app: App): Promise<void> {
  const res = await app.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd: projects }),
    }),
  );
  expect(res.status).toBe(201);
}

describe("rute wiki", () => {
  test("sinkron, daftar halaman, dan baca halaman", async () => {
    const { req, audit } = setup();
    const sinkron = await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan" });
    expect(sinkron.status).toBe(200);
    const isi = (await sinkron.json()) as {
      commit: string;
      fetchedAt: string;
      pages: Array<{ slug: string; title: string; format: string }>;
      sidebar?: string;
    };
    expect(isi.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(isi.pages.map((page) => page.slug)).toEqual(["Home", "panduan/deploy"]);
    expect(isi.sidebar).toContain("Beranda");

    const daftar = await req("GET", "/api/wiki/pages?providerId=lokal&fullPath=panduan");
    expect(daftar.status).toBe(200);
    const halaman = (await daftar.json()) as { pages: unknown[] };
    expect(halaman.pages).toHaveLength(2);

    const baca = await req("GET", "/api/wiki/page?providerId=lokal&fullPath=panduan&slug=Home");
    expect(baca.status).toBe(200);
    const isiHalaman = (await baca.json()) as { page: { content: string; format: string } };
    expect(isiHalaman.page.content).toContain("Selamat datang");
    expect(isiHalaman.page.format).toBe("markdown");
    audit.close();
  });

  test("kode galat: 400, 404, 409, 502", async () => {
    const { req, audit } = setup();
    // Belum sinkron -> 409
    expect((await req("GET", "/api/wiki/pages?providerId=lokal&fullPath=panduan")).status).toBe(409);
    // Penyedia tak dikenal -> 404
    expect((await req("GET", "/api/wiki/pages?providerId=hilang&fullPath=panduan")).status).toBe(404);
    // Field asing -> 400
    expect(
      (await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan", lain: 1 })).status,
    ).toBe(400);
    // Parameter hilang -> 400
    expect((await req("GET", "/api/wiki/pages?providerId=lokal")).status).toBe(400);
    // Slug berbahaya -> 400; slug tak ada -> 404
    await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan" });
    expect(
      (await req("GET", "/api/wiki/page?providerId=lokal&fullPath=panduan&slug=../rahasia")).status,
    ).toBe(400);
    expect(
      (await req("GET", "/api/wiki/page?providerId=lokal&fullPath=panduan&slug=tidak-ada")).status,
    ).toBe(404);
    // Klon ke host tak terjangkau -> 502
    const gagal = await req("POST", "/api/wiki/sync", { providerId: "gl", fullPath: "grup/proyek" });
    expect(gagal.status).toBe(502);
    const teks = JSON.stringify(await gagal.json());
    expect(teks).not.toContain("glpat");
    audit.close();
  });

  test("proyek dari remote origin: 200 dan folder tak dikenal 404", async () => {
    const { app, req, audit } = setup();
    await buatSesi(app);
    const proyek = await req("GET", `/api/wiki/project?cwd=${encodeURIComponent(projects)}`);
    expect(proyek.status).toBe(200);
    expect(await proyek.json()).toEqual({ providerId: "gl", fullPath: "grup/proyek" });
    const asing = await req("GET", `/api/wiki/project?cwd=${encodeURIComponent(join(dir, "tidak-ada"))}`);
    expect(asing.status).toBe(404);
    audit.close();
  });

  test("wiki dimatikan menjawab 503", async () => {
    const { req, audit } = setup({ withWiki: false });
    expect((await req("GET", "/api/wiki/pages?providerId=lokal&fullPath=panduan")).status).toBe(503);
    expect((await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan" })).status).toBe(
      503,
    );
    expect((await req("GET", "/api/wiki/project?cwd=/tmp")).status).toBe(503);
    audit.close();
  });

  test("tanpa cookie, rute wiki menjawab 401", async () => {
    const { req, audit } = setup({ withAuth: true });
    expect((await req("GET", "/api/wiki/pages?providerId=lokal&fullPath=panduan")).status).toBe(401);
    expect((await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan" })).status).toBe(
      401,
    );
    audit.close();
  });

  test("audit mencatat sinkron dan baca tanpa isi halaman", async () => {
    const { req, audit } = setup();
    await req("POST", "/api/wiki/sync", { providerId: "lokal", fullPath: "panduan" });
    await req("GET", "/api/wiki/page?providerId=lokal&fullPath=panduan&slug=Home");
    const entri = audit.list({ kind: "pengaturan", limit: 50 });
    const sinkron = entri.find((item) => item.meta.aksi === "wiki-sinkron");
    const baca = entri.find((item) => item.meta.aksi === "wiki-baca");
    expect(sinkron?.meta.hasil).toBe("ok");
    expect(sinkron?.meta.providerId).toBe("lokal");
    expect(sinkron?.meta.fullPath).toBe("panduan");
    expect(baca?.meta.slug).toBe("Home");
    const rekap = JSON.stringify(entri);
    expect(rekap).not.toContain("Selamat datang");
    expect(rekap).not.toContain("glpat");
    audit.close();
  });
});
