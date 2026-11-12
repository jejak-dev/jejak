import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { createApiClient } from "../src/client/lib/api";
import {
  buildTree,
  filterPages,
  freshness,
  quoteText,
  resolveWikiLink,
  WIKI_STALE_MS,
  wikiErrorMessage,
  type WikiPageRef,
} from "../src/client/lib/wiki";
import {
  filterRepos,
  gitlabProviders,
  matchRepos,
  readStoredProject,
  storedProjectErrorMessage,
  writeStoredProject,
  WIKI_PROJECT_MAX_ENTRIES,
} from "../src/client/lib/wiki-project";
import {
  WikiView,
  type WikiActions,
  type WikiState,
} from "../src/client/components/WikiTab";
import { Markdown } from "../src/client/components/Markdown";
import { parsePanelPrefs } from "../src/client/lib/panel-prefs";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function byTag(node: ComponentChild, tag: string): VNode[] {
  return findNodes(node, (vnode) => vnode.type === tag);
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function buttonTexts(node: ComponentChild): string[] {
  return byTag(node, "button").map((vnode) => textOf(propsOf(vnode).children as ComponentChild));
}

/* ---------- Data bantu ---------- */

function page(slug: string, title: string): WikiPageRef {
  return { slug, title, format: "markdown" };
}

const PAGES: WikiPageRef[] = [
  page("Beranda", "Beranda"),
  page("panduan/deploy", "Deploy"),
  page("panduan/konsep", "Konsep"),
  page("Panduan-Deploy", "Panduan Deploy"),
];

const NOOP_ACTIONS: WikiActions = {
  onRetry: () => undefined,
  onRefresh: () => undefined,
  onQueryChange: () => undefined,
  onOpenPage: () => undefined,
  onClosePage: () => undefined,
  onQuote: () => undefined,
  onLink: () => false,
  onSelectProvider: () => undefined,
  onRepoQueryChange: () => undefined,
  onPickRepo: () => undefined,
  onRetryRepos: () => undefined,
  onRetryProviders: () => undefined,
  onChangeProject: () => undefined,
};

function stateOf(overrides: Partial<WikiState> = {}): WikiState {
  return {
    pages: [],
    manual: false,
    picker: false,
    providers: [],
    repos: [],
    repoQuery: "",
    reposLoading: false,
    providersLoading: false,
    stale: false,
    loading: false,
    syncing: false,
    canRetry: true,
    query: "",
    pageLoading: false,
    ...overrides,
  };
}

/* ---------- Fungsi murni ---------- */

describe("buildTree", () => {
  test("tanpa sidebar: halaman dikelompokkan menurut folder", () => {
    const nodes = buildTree(PAGES);

    const groups = nodes.filter((node) => node.depth === 0).map((node) => node.title);
    expect(groups).toEqual(["Halaman", "panduan"]);

    const beranda = nodes.filter((node) => node.slug === "Beranda");
    expect(beranda).toHaveLength(1);

    const deploy = nodes.find((node) => node.slug === "panduan/deploy");
    expect(deploy?.title).toBe("Deploy");
    expect(deploy?.depth).toBe(1);
  });

  test("sidebar menjadi kelompok teratas menurut urutannya", () => {
    const sidebar = "[Deploy](panduan/deploy)\n[Konsep](panduan/konsep)\n";
    const nodes = buildTree(PAGES, sidebar);

    expect(nodes[0]).toEqual({ slug: "", title: "Dari _Sidebar", depth: 0 });
    expect(nodes.slice(1, 3).map((node) => node.slug)).toEqual([
      "panduan/deploy",
      "panduan/konsep",
    ]);
  });

  test("tautan sidebar yang berulang tidak menggandakan halaman", () => {
    const sidebar = "[Deploy](panduan/deploy)\n[Deploy lagi](panduan/deploy)\n";
    const nodes = buildTree(PAGES, sidebar);

    const slugs = nodes.filter((node) => node.depth === 1).map((node) => node.slug);
    expect(slugs.filter((slug) => slug === "panduan/deploy")).toHaveLength(1);
  });

  test("halaman yang tidak disebut sidebar tetap dikelompokkan menurut folder", () => {
    const sidebar = "[Deploy](panduan/deploy)\n";
    const nodes = buildTree(PAGES, sidebar);

    const groups = nodes.filter((node) => node.depth === 0).map((node) => node.title);
    expect(groups).toEqual(["Dari _Sidebar", "Halaman", "panduan"]);
    const deployInFolder = nodes.filter(
      (node) => node.depth === 1 && node.slug === "panduan/deploy",
    );
    expect(deployInFolder).toHaveLength(1);
  });

  test("sidebar tanpa tautan yang cocok tidak membuat kelompok", () => {
    const nodes = buildTree(PAGES, "[Hantu](tidak-ada)\n");
    expect(nodes.filter((node) => node.depth === 0).map((node) => node.title)).not.toContain(
      "Dari _Sidebar",
    );
  });

  test("daftar kosong tidak menghasilkan simpul", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("filterPages", () => {
  test("saringan kosong mengembalikan semua halaman", () => {
    expect(filterPages(PAGES, "")).toHaveLength(PAGES.length);
    expect(filterPages(PAGES, "   ")).toHaveLength(PAGES.length);
  });

  test("menyaring judul dan slug tanpa peduli huruf besar", () => {
    expect(filterPages(PAGES, "deploy").map((item) => item.slug)).toEqual([
      "panduan/deploy",
      "Panduan-Deploy",
    ]);
    expect(filterPages(PAGES, "BERANDA").map((item) => item.slug)).toEqual(["Beranda"]);
    expect(filterPages(PAGES, "konsep").map((item) => item.slug)).toEqual(["panduan/konsep"]);
  });

  test("saringan yang tidak cocok menghasilkan daftar kosong", () => {
    expect(filterPages(PAGES, "tidak-ada")).toEqual([]);
  });
});

describe("resolveWikiLink", () => {
  test("tautan relatif diselesaikan terhadap folder halaman", () => {
    expect(resolveWikiLink("deploy", "panduan/deploy", PAGES)).toEqual({
      kind: "wiki",
      slug: "panduan/deploy",
    });
    expect(resolveWikiLink("./deploy", "panduan/deploy", PAGES)).toEqual({
      kind: "wiki",
      slug: "panduan/deploy",
    });
  });

  test("tautan ../ naik ke folder induk", () => {
    expect(resolveWikiLink("../Beranda", "panduan/deploy", PAGES)).toEqual({
      kind: "wiki",
      slug: "Beranda",
    });
  });

  test("ekstensi .md dan fragmen dibuang", () => {
    expect(resolveWikiLink("panduan/deploy.md", "Beranda", PAGES)).toEqual({
      kind: "wiki",
      slug: "panduan/deploy",
    });
    expect(resolveWikiLink("panduan/deploy#bagian", "Beranda", PAGES)).toEqual({
      kind: "wiki",
      slug: "panduan/deploy",
    });
  });

  test("spasi dan %20 menjadi tanda hubung", () => {
    expect(resolveWikiLink("Panduan%20Deploy", "Beranda", PAGES)).toEqual({
      kind: "wiki",
      slug: "Panduan-Deploy",
    });
    expect(resolveWikiLink("Panduan Deploy", "Beranda", PAGES)).toEqual({
      kind: "wiki",
      slug: "Panduan-Deploy",
    });
  });

  test("tautan http dan https bersifat eksternal", () => {
    expect(resolveWikiLink("https://contoh.test/a", "Beranda", PAGES)).toEqual({
      kind: "external",
      href: "https://contoh.test/a",
    });
    expect(resolveWikiLink("http://contoh.test/a", "Beranda", PAGES)).toEqual({
      kind: "external",
      href: "http://contoh.test/a",
    });
  });

  test("javascript: dan skema lain tidak dikenal", () => {
    expect(resolveWikiLink("javascript:alert(1)", "Beranda", PAGES)).toEqual({ kind: "none" });
    expect(resolveWikiLink("mailto:a@b.c", "Beranda", PAGES)).toEqual({ kind: "none" });
  });

  test("slug yang tidak ada di daftar tidak menjadi tautan wiki", () => {
    expect(resolveWikiLink("tidak-ada", "Beranda", PAGES)).toEqual({ kind: "none" });
    expect(resolveWikiLink("#bagian", "Beranda", PAGES)).toEqual({ kind: "none" });
    expect(resolveWikiLink("", "Beranda", PAGES)).toEqual({ kind: "none" });
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");

  test("baru saja", () => {
    const result = freshness("2026-11-12T09:59:30Z", now);
    expect(result.label).toBe("baru saja");
    expect(result.stale).toBe(false);
  });

  test("beberapa menit lalu", () => {
    expect(freshness("2026-11-12T09:55:00Z", now).label).toBe("5 menit lalu");
  });

  test("lebih dari sepuluh menit berarti basi", () => {
    const result = freshness("2026-11-12T09:49:00Z", now);
    expect(result.stale).toBe(true);
    expect(WIKI_STALE_MS).toBe(600_000);
  });

  test("jam dan hari", () => {
    expect(freshness("2026-11-12T08:00:00Z", now).label).toBe("2 jam lalu");
    expect(freshness("2026-11-09T10:00:00Z", now).label).toBe("3 hari lalu");
  });
});

describe("quoteText", () => {
  test("kutipan berlabel sumber, commit, dan tanggal", () => {
    const text = quoteText({
      slug: "panduan/deploy",
      title: "Deploy",
      content: "Isi halaman",
      commit: "abcdef1234567890",
      fetchedAt: "2026-11-12T09:00:00Z",
      source: "grup/proyek",
    });

    expect(text).toContain('<wiki sumber="grup/proyek/panduan/deploy"');
    expect(text).toContain('commit="abcdef1"');
    expect(text).toContain('tanggal="2026-11-12"');
    expect(text).toContain("Isi halaman");
    expect(text.trimEnd().endsWith("</wiki>")).toBe(true);
  });

  test("isi panjang dipotong dan diberi tanda", () => {
    const text = quoteText({
      slug: "Beranda",
      title: "Beranda",
      content: "x".repeat(9000),
      commit: "abcdef1",
      fetchedAt: "2026-11-12T09:00:00Z",
      source: "grup/proyek",
    });

    expect(text).toContain("[dipotong]");
    expect(text).not.toContain("x".repeat(8001));
  });

  test("penutup wiki pada isi dinetralkan", () => {
    const text = quoteText({
      slug: "Beranda",
      title: "Beranda",
      content: "sebut </wiki> di dalam isi",
      commit: "abcdef1",
      fetchedAt: "2026-11-12T09:00:00Z",
      source: "grup/proyek",
    });

    expect(text).toContain("<\\/wiki>");
    expect(text.match(/<\/wiki>/g)).toHaveLength(1);
  });
});

describe("wikiErrorMessage", () => {
  test("404 menjelaskan tidak ada proyek GitLab", () => {
    expect(wikiErrorMessage(404)).toContain("Tidak ada proyek GitLab dari remote origin");
  });

  test("409 meminta penyegaran", () => {
    expect(wikiErrorMessage(409)).toContain("belum disinkronkan");
  });

  test("502 memakai pesan server", () => {
    expect(wikiErrorMessage(502, "Gagal mengklon wiki.")).toBe("Gagal mengklon wiki.");
  });

  test("503 menjelaskan wiki dimatikan dan menyebut halaman Workspace", () => {
    const message = wikiErrorMessage(503, "Wiki dimatikan.");
    expect(message).toContain("Wiki dimatikan");
    expect(message).toContain("Workspace");
  });
});

/* ---------- Pilihan proyek manual ---------- */

describe("readStoredProject", () => {
  test("isi rusak dianggap tidak ada pilihan", () => {
    expect(readStoredProject("{rusak", "/a")).toBeUndefined();
    expect(readStoredProject("", "/a")).toBeUndefined();
    expect(readStoredProject(null, "/a")).toBeUndefined();
    expect(readStoredProject(undefined, "/a")).toBeUndefined();
  });

  test("bentuk salah diabaikan", () => {
    expect(readStoredProject("[]", "/a")).toBeUndefined();
    expect(readStoredProject(JSON.stringify({ "/a": "teks" }), "/a")).toBeUndefined();
    expect(readStoredProject(JSON.stringify({ "/a": { providerId: "p_1" } }), "/a")).toBeUndefined();
    expect(
      readStoredProject(JSON.stringify({ "/a": { providerId: "", fullPath: "grup/proyek" } }), "/a"),
    ).toBeUndefined();
    expect(
      readStoredProject(JSON.stringify({ "/a": { providerId: "p_1", fullPath: 7 } }), "/a"),
    ).toBeUndefined();
  });

  test("pilihan yang sah dibaca per folder", () => {
    const raw = JSON.stringify({ "/a": { providerId: "p_1", fullPath: "grup/proyek" } });
    expect(readStoredProject(raw, "/a")).toEqual({
      providerId: "p_1",
      fullPath: "grup/proyek",
    });
    expect(readStoredProject(raw, "/b")).toBeUndefined();
  });
});

describe("writeStoredProject", () => {
  test("menambah entri lalu dibaca kembali", () => {
    const next = writeStoredProject(null, "/a", { providerId: "p_1", fullPath: "grup/proyek" });
    expect(readStoredProject(next, "/a")).toEqual({
      providerId: "p_1",
      fullPath: "grup/proyek",
    });
  });

  test("entri folder lain tetap utuh", () => {
    const start = writeStoredProject(null, "/a", { providerId: "p_1", fullPath: "grup/satu" });
    const next = writeStoredProject(start, "/b", { providerId: "p_2", fullPath: "grup/dua" });
    expect(readStoredProject(next, "/a")?.fullPath).toBe("grup/satu");
    expect(readStoredProject(next, "/b")?.fullPath).toBe("grup/dua");
  });

  test("proyek undefined menghapus entri folder itu", () => {
    const start = writeStoredProject(null, "/a", { providerId: "p_1", fullPath: "grup/satu" });
    const next = writeStoredProject(start, "/a", undefined);
    expect(readStoredProject(next, "/a")).toBeUndefined();
  });

  test("isi rusak tidak merusak peta baru", () => {
    const next = writeStoredProject("{rusak", "/a", {
      providerId: "p_1",
      fullPath: "grup/proyek",
    });
    expect(readStoredProject(next, "/a")?.fullPath).toBe("grup/proyek");
  });

  test("jumlah folder tersimpan dibatasi lima puluh", () => {
    let raw: string | null = null;
    for (let index = 0; index < WIKI_PROJECT_MAX_ENTRIES + 10; index += 1) {
      raw = writeStoredProject(raw, `/folder-${index}`, {
        providerId: "p_1",
        fullPath: `grup/proyek-${index}`,
      });
    }
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(WIKI_PROJECT_MAX_ENTRIES);
    expect(readStoredProject(raw, `/folder-${WIKI_PROJECT_MAX_ENTRIES + 9}`)).toBeDefined();
  });
});

describe("gitlabProviders", () => {
  test("hanya penyedia gitlab yang diambil", () => {
    const options = gitlabProviders([
      { id: "p_1", name: "GitLab Kantor", kind: "gitlab" },
      { id: "p_2", name: "Folder Lokal", kind: "local" },
    ]);
    expect(options).toEqual([{ id: "p_1", name: "GitLab Kantor" }]);
  });
});

describe("filterRepos", () => {
  const REPOS = [
    { name: "satu", fullPath: "grup/satu" },
    { name: "dua", fullPath: "grup/sub/dua" },
    { name: "tiga", fullPath: "lain/tiga" },
  ];

  test("saringan kosong mengembalikan semua repo", () => {
    expect(filterRepos(REPOS, "")).toHaveLength(3);
    expect(filterRepos(REPOS, "   ")).toHaveLength(3);
  });

  test("saringan mencocokkan sebagian fullPath tanpa cares huruf besar", () => {
    expect(filterRepos(REPOS, "grup/sub").map((repo) => repo.fullPath)).toEqual([
      "grup/sub/dua",
    ]);
    expect(filterRepos(REPOS, "GRUP").map((repo) => repo.fullPath)).toEqual([
      "grup/satu",
      "grup/sub/dua",
    ]);
  });

  test("saringan tanpa hasil menghasilkan daftar kosong", () => {
    expect(filterRepos(REPOS, "tidak-ada")).toEqual([]);
  });

  test("hasil dibatasi lima puluh tapi jumlah sebenarnya tetap diketahui", () => {
    const banyak = Array.from({ length: 120 }, (_, index) => ({
      name: `r${index}`,
      fullPath: `grup/r${index}`,
    }));
    expect(filterRepos(banyak, "grup")).toHaveLength(50);
    expect(filterRepos(banyak, "grup", 10)).toHaveLength(10);
    expect(matchRepos(banyak, "grup")).toHaveLength(120);
  });
});

describe("storedProjectErrorMessage", () => {
  test("menyertakan pesan server bila ada", () => {
    expect(storedProjectErrorMessage(404, "Repo tidak ditemukan di penyedia.")).toContain(
      "Repo tidak ditemukan di penyedia.",
    );
  });

  test("tanpa pesan memakai kalimat bawaan", () => {
    expect(storedProjectErrorMessage(404)).toContain("tidak ditemukan");
  });
});

/* ---------- Klien API ---------- */

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api wiki", () => {
  test("wikiProject memakai GET dengan query cwd ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ providerId: "p_1", fullPath: "grup/proyek" }),
    );
    const api = createApiClient({ fetch });

    const result = await api.wikiProject("/Users/proyek");

    expect(result).toEqual({ providerId: "p_1", fullPath: "grup/proyek" });
    expect(calls[0]?.url).toBe("/api/wiki/project?cwd=%2FUsers%2Fproyek");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("wikiSync memakai POST dengan providerId dan fullPath", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        commit: "abcdef1234",
        fetchedAt: "2026-11-12T09:00:00Z",
        pages: [{ slug: "Beranda", title: "Beranda", format: "markdown" }],
      }),
    );
    const api = createApiClient({ fetch });

    const result = await api.wikiSync("p_1", "grup/proyek");

    expect(result.commit).toBe("abcdef1234");
    expect(result.pages[0]?.slug).toBe("Beranda");
    expect(calls[0]?.url).toBe("/api/wiki/sync");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ providerId: "p_1", fullPath: "grup/proyek" }),
    );
  });

  test("wikiPages memakai GET dengan query ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        commit: "abcdef1234",
        fetchedAt: "2026-11-12T09:00:00Z",
        pages: [],
        sidebar: "[Beranda](Beranda)",
      }),
    );
    const api = createApiClient({ fetch });

    const result = await api.wikiPages("p/1", "grup/proyek");

    expect(result.sidebar).toBe("[Beranda](Beranda)");
    expect(calls[0]?.url).toBe(
      "/api/wiki/pages?providerId=p%2F1&fullPath=grup%2Fproyek",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("wikiPage memakai GET dengan slug ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        page: {
          slug: "panduan/deploy",
          title: "Deploy",
          format: "markdown",
          content: "isi",
          truncated: false,
          commit: "abcdef1234",
          fetchedAt: "2026-11-12T09:00:00Z",
        },
      }),
    );
    const api = createApiClient({ fetch });

    const result = await api.wikiPage("p_1", "grup/proyek", "panduan/deploy");

    expect(result.content).toBe("isi");
    expect(result.truncated).toBe(false);
    expect(calls[0]?.url).toBe(
      "/api/wiki/page?providerId=p_1&fullPath=grup%2Fproyek&slug=panduan%2Fdeploy",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("respons tidak valid menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ halaman: "salah" }));
    const api = createApiClient({ fetch });

    await expect(api.wikiPages("p_1", "grup/proyek")).rejects.toBeInstanceOf(Error);
  });
});

/* ---------- Tampilan tab Wiki ---------- */

describe("WikiView", () => {
  test("tanpa proyek GitLab menampilkan pesan tanpa tombol aksi", () => {
    const node = WikiView({
      state: stateOf({ error: wikiErrorMessage(404), canRetry: false }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Tidak ada proyek GitLab dari remote origin");
    expect(buttonTexts(node)).not.toContain("Coba lagi");
  });

  test("galat lain tetap menampilkan tombol coba lagi", () => {
    const node = WikiView({
      state: stateOf({ error: "Gagal mengambil wiki dari server." }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(buttonTexts(node)).toContain("Coba lagi");
  });

  test("keadaan memuat dan mengambil wiki ditampilkan", () => {
    const loading = WikiView({
      state: stateOf({ loading: true }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;
    expect(textOf(loading)).toContain("Memuat wiki…");

    const syncing = WikiView({
      state: stateOf({ syncing: true }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;
    expect(textOf(syncing)).toContain("Mengambil wiki…");
  });

  test("daftar ditampilkan bergrup dengan tombol segarkan", () => {
    const node = WikiView({
      state: stateOf({
        project: { providerId: "p_1", fullPath: "grup/proyek" },
        pages: PAGES,
        commit: "abcdef1234567",
        fetchedAt: new Date().toISOString(),
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    const titles = byClass(node, "jk-wiki-group-title").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(titles).toEqual(["Halaman", "panduan"]);
    expect(textOf(node)).toContain("Deploy");
    expect(textOf(node)).toContain("commit abcdef1");

    const labels = byTag(node, "button").map((vnode) => propsOf(vnode)["aria-label"]);
    expect(labels).toContain("Segarkan wiki");
  });

  test("daftar kosong menampilkan pesan wiki belum punya halaman", () => {
    const node = WikiView({
      state: stateOf({ project: { providerId: "p_1", fullPath: "grup/proyek" }, pages: [] }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Wiki ini belum punya halaman.");
  });

  test("cache basi memberi label mungkin tertinggal", () => {
    const node = WikiView({
      state: stateOf({
        project: { providerId: "p_1", fullPath: "grup/proyek" },
        pages: PAGES,
        commit: "abcdef1234567",
        fetchedAt: "2026-11-12T09:00:00Z",
        stale: true,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("mungkin tertinggal");
  });

  test("halaman terbuka menampilkan isi dan tombol kutip", () => {
    const node = WikiView({
      state: stateOf({
        project: { providerId: "p_1", fullPath: "grup/proyek" },
        page: {
          slug: "panduan/deploy",
          title: "Deploy",
          format: "markdown",
          content: "Isi halaman",
          truncated: true,
          commit: "abcdef1234567",
          fetchedAt: "2026-11-12T09:00:00Z",
        },
      }),
      actions: NOOP_ACTIONS,
      canQuote: true,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Deploy");
    expect(textOf(node)).toContain("Isi halaman");
    expect(textOf(node)).toContain("Halaman dipotong.");
    expect(buttonTexts(node)).toContain("Kutip ke komposer");
    const labels = byTag(node, "button").map((vnode) => propsOf(vnode)["aria-label"]);
    expect(labels).toContain("Kutip ke komposer");
  });

  test("tanpa onQuote tombol kutip tidak muncul", () => {
    const node = WikiView({
      state: stateOf({
        project: { providerId: "p_1", fullPath: "grup/proyek" },
        page: {
          slug: "panduan/deploy",
          title: "Deploy",
          format: "text",
          content: "Isi polos",
          truncated: false,
          commit: "abcdef1234567",
          fetchedAt: "2026-11-12T09:00:00Z",
        },
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(buttonTexts(node)).not.toContain("Kutip ke komposer");
    expect(byTag(node, "pre")).toHaveLength(1);
  });
});

describe("WikiView pemilih proyek manual", () => {
  const PROVIDERS = [
    { id: "p_1", name: "GitLab Kantor" },
    { id: "p_2", name: "GitLab kedua" },
  ];
  const REPOS = [
    { name: "proyek", fullPath: "grup/proyek" },
    { name: "lain", fullPath: "grup/lain" },
  ];

  test("tanpa penyedia gitlab menampilkan pesan lama tanpa pemilih", () => {
    const node = WikiView({
      state: stateOf({ error: wikiErrorMessage(404), canRetry: false }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Tambahkan penyedia GitLab di halaman Workspace");
    expect(byTag(node, "select")).toHaveLength(0);
  });

  test("pemilih menampilkan daftar penyedia dan repo", () => {
    const node = WikiView({
      state: stateOf({
        picker: true,
        providers: PROVIDERS,
        providerId: "p_1",
        repos: REPOS,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    const selects = byTag(node, "select");
    expect(selects).toHaveLength(1);
    const options = byTag(selects[0]!, "option");
    expect(options.map((vnode) => propsOf(vnode).value)).toEqual(["", "p_1", "p_2"]);
    expect(textOf(node)).toContain("grup/proyek");
    expect(textOf(node)).toContain("grup/lain");
  });

  test("satu penyedia saja tidak memakai opsi kosong", () => {
    const node = WikiView({
      state: stateOf({
        picker: true,
        providers: [PROVIDERS[0]!],
        providerId: "p_1",
        repos: REPOS,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    const selects = byTag(node, "select");
    expect(byTag(selects[0]!, "option")).toHaveLength(1);
  });

  test("daftar repo yang dimuat menampilkan status memuat", () => {
    const node = WikiView({
      state: stateOf({
        picker: true,
        providers: PROVIDERS,
        providerId: "p_1",
        reposLoading: true,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Memuat daftar repo…");
  });

  test("galat daftar repo menampilkan tombol coba lagi", () => {
    const node = WikiView({
      state: stateOf({
        picker: true,
        providers: PROVIDERS,
        providerId: "p_1",
        reposError: "Gagal memuat daftar repo.",
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Gagal memuat daftar repo.");
    expect(buttonTexts(node)).toContain("Coba lagi");
  });

  test("daftar repo dibatasi lima puluh dan menawarkan persempit pencarian", () => {
    const banyak = Array.from({ length: 80 }, (_, index) => ({
      name: `r${index}`,
      fullPath: `grup/r${index}`,
    }));
    const node = WikiView({
      state: stateOf({
        picker: true,
        providers: PROVIDERS,
        providerId: "p_1",
        repos: banyak,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(byClass(node, "jk-wiki-page")).toHaveLength(50);
    expect(textOf(node)).toContain("Persempit pencarian");
  });
});

describe("WikiView kepala proyek", () => {
  test("proyek manual menampilkan tombol ganti proyek", () => {
    const node = WikiView({
      state: stateOf({
        project: { providerId: "p_1", fullPath: "grup/proyek" },
        manual: true,
      }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Proyek: grup/proyek (manual)");
    expect(buttonTexts(node)).toContain("Ganti proyek");
  });

  test("proyek dari pencocokan remote tidak menampilkan tombol ganti proyek", () => {
    const node = WikiView({
      state: stateOf({ project: { providerId: "p_1", fullPath: "grup/proyek" } }),
      actions: NOOP_ACTIONS,
      canQuote: false,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Proyek: grup/proyek");
    expect(textOf(node)).not.toContain("(manual)");
    expect(buttonTexts(node)).not.toContain("Ganti proyek");
  });
});

/* ---------- Preferensi panel ---------- */

describe("panel-prefs", () => {
  test("tab Wiki dikenali", () => {
    expect(parsePanelPrefs(JSON.stringify({ open: true, tab: "wiki" }))).toEqual({
      open: true,
      tab: "wiki",
    });
  });
});

/* ---------- Markdown dengan penanganan tautan ---------- */

describe("Markdown dengan onLink", () => {
  test("tanpa prop, tautan relatif tetap teks biasa", () => {
    const node = Markdown({ text: "[Deploy](panduan/deploy)" }) as unknown as ComponentChild;

    expect(byTag(node, "a")).toHaveLength(0);
    expect(textOf(node)).toBe("[Deploy](panduan/deploy)");
  });

  test("dengan prop, tautan relatif jadi tautan tanpa tab baru", () => {
    const node = Markdown({
      text: "[Deploy](panduan/deploy)",
      onLink: () => true,
    }) as unknown as ComponentChild;

    const links = byTag(node, "a");
    expect(links).toHaveLength(1);
    expect(propsOf(links[0]).href).toBe("panduan/deploy");
    expect(propsOf(links[0]).target).toBeUndefined();
  });

  test("tautan eksternal tetap membuka tab baru", () => {
    const node = Markdown({
      text: "[Situs](https://contoh.test)",
      onLink: () => true,
    }) as unknown as ComponentChild;

    const links = byTag(node, "a");
    expect(propsOf(links[0]).target).toBe("_blank");
    expect(propsOf(links[0]).rel).toBe("noopener noreferrer");
  });

  test("klik tautan memanggil onLink dan membatalkan navigasi bila ditangani", () => {
    let seen = "";
    const node = Markdown({
      text: "[Deploy](panduan/deploy)",
      onLink: (href) => {
        seen = href;
        return true;
      },
    }) as unknown as ComponentChild;

    const links = byTag(node, "a");
    const onClick = propsOf(links[0]).onClick;
    expect(typeof onClick).toBe("function");
    let prevented = false;
    (onClick as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(seen).toBe("panduan/deploy");
    expect(prevented).toBe(true);
  });
});
