import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, type GitProviderItem, type IndexedRepoItem } from "../src/client/lib/api";
import {
  INDEX_STALE_LABEL,
  emptyProviderForm,
  formFromProvider,
  indexedMeta,
  providerFormError,
  providerInputFrom,
  providerSummary,
} from "../src/client/lib/indexer";

const GL: GitProviderItem = { id: "gl", name: "GitLab kantor", kind: "gitlab", baseUrl: "https://git.contoh.id", hasToken: true };
const REPO: IndexedRepoItem = {
  key: "0123456789abcdef",
  providerId: "gl",
  name: "orders",
  fullPath: "grup/orders",
  commit: "a".repeat(40),
  branch: "main",
  indexedAt: "2026-11-10T08:00:00.000Z",
  files: 12,
  source: "indeks",
};

describe("fungsi murni", () => {
  test("providerFormError menangkap id, nama, lokasi, token, dan lokal", () => {
    const base = { ...emptyProviderForm(), id: "gl", name: "X", location: "https://git.contoh.id" };
    expect(providerFormError(base)).toBeUndefined();
    expect(providerFormError({ ...base, id: "Buruk!" })).toContain("Id");
    expect(providerFormError({ ...base, name: " " })).toContain("Nama");
    expect(providerFormError({ ...base, location: "" })).toContain("alamat");
    expect(providerFormError({ ...base, token: "a b" })).toContain("spasi");
    expect(providerFormError({ ...base, kind: "local", location: "relatif" })).toContain("absolut");
    expect(providerFormError({ ...base, kind: "local", location: "/p", token: "x" })).toContain("lokal");
  });

  test("providerInputFrom: token hanya bila diisi, kosong untuk hapus", () => {
    const form = { ...emptyProviderForm(), id: "gl", name: " GL ", location: " https://git.contoh.id " };
    expect(providerInputFrom(form)).toEqual({ name: "GL", kind: "gitlab", baseUrl: "https://git.contoh.id" });
    expect(providerInputFrom({ ...form, token: "glpat-x" }).token).toBe("glpat-x");
    expect(providerInputFrom({ ...form, clearToken: true }).token).toBe("");
    expect(providerInputFrom({ ...form, kind: "local", location: "/p" })).toEqual({ name: "GL", kind: "local", root: "/p" });
  });

  test("formFromProvider tidak membawa token; ringkasan dan meta", () => {
    expect(formFromProvider(GL)).toMatchObject({ id: "gl", location: "https://git.contoh.id", token: "", clearToken: false });
    expect(providerSummary(GL)).toBe("GitLab · https://git.contoh.id · token tersimpan");
    expect(providerSummary({ id: "l", name: "L", kind: "local", root: "/p", hasToken: false })).toBe("Folder lokal · /p");
    expect(indexedMeta(REPO)).toContain("commit aaaaaaa");
    expect(indexedMeta(REPO)).toContain("12 berkas");
    expect(INDEX_STALE_LABEL).toContain("tertinggal");
  });
});

describe("ApiClient indexer", () => {
  function fakeFetch(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return response();
    };
    return { fetch: impl as typeof fetch, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("metode dan jalur", async () => {
    const { fetch, calls } = fakeFetch(() => json({ providers: [GL], repos: [REPO], id: "gl", key: REPO.key }));
    const api = createApiClient({ fetch });
    expect(await api.listGitProviders()).toEqual([GL]);
    await api.putGitProvider("gl", { name: "X", kind: "gitlab", baseUrl: "https://git.contoh.id", token: "t" });
    await api.deleteGitProvider("gl");
    expect(await api.listProviderRepos("gl")).toHaveLength(1);
    expect(await api.listIndexedRepos()).toEqual([REPO]);
    await api.indexRepo("gl", "grup/orders");
    await api.deleteIndexedRepo(REPO.key);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/git-providers",
      "PUT /api/git-providers/gl",
      "DELETE /api/git-providers/gl",
      "GET /api/git-providers/gl/repos",
      "GET /api/index/repos",
      "POST /api/index/repos",
      `DELETE /api/index/repos/${REPO.key}`,
    ]);
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({ providerId: "gl", fullPath: "grup/orders" });
  });

  test("bentuk salah dan 503 menjadi ApiError", async () => {
    const bad = fakeFetch(() => json({ x: 1 }));
    await expect(createApiClient({ fetch: bad.fetch }).listGitProviders()).rejects.toBeInstanceOf(ApiError);
    const off = fakeFetch(() => json({ error: "Indexer dimatikan." }, 503));
    await expect(createApiClient({ fetch: off.fetch }).listIndexedRepos()).rejects.toBeInstanceOf(ApiError);
  });
});
