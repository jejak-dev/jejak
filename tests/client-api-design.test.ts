import { describe, expect, test } from "bun:test";
import {
  ApiError,
  createApiClient,
  designFrameUrl,
  type DesignComment,
  type DesignResult,
} from "../src/client/lib/api";

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

const DESIGN: DesignResult = {
  exists: true,
  pages: [
    {
      slug: "beranda",
      title: "Beranda",
      route: "/",
      device: "desktop",
      x: 0,
      y: 0,
      mtime: 1,
      missing: false,
      tooLarge: false,
    },
  ],
  tokens: { mtime: null },
  warnings: [],
};

describe("klien API desain", () => {
  test("getDesign GET path ter-encode dengan query repo", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(DESIGN));
    const api = createApiClient({ fetch });

    expect(await api.getDesign("a/b c", "repo satu")).toEqual(DESIGN);
    expect(calls[0]?.url).toBe("/api/sessions/a%2Fb%20c/design?repo=repo%20satu");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("getDesign tanpa repo tidak mengirim query", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(DESIGN));
    const api = createApiClient({ fetch });

    await api.getDesign("s1");
    expect(calls[0]?.url).toBe("/api/sessions/s1/design");
  });

  test("getDesignStamp mengembalikan stamp", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ stamp: "abc123" }));
    const api = createApiClient({ fetch });

    expect(await api.getDesignStamp("s1", "web")).toEqual({ stamp: "abc123" });
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/stamp?repo=web");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getDesignStamp menolak respons tanpa stamp", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}));
    const api = createApiClient({ fetch });

    await expect(api.getDesignStamp("s1")).rejects.toBeInstanceOf(ApiError);
  });

  test("getDesignStamp meneruskan captures yang sah dan membuang yang tak sah", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        stamp: "abc123",
        captures: [
          { id: "k_1", slug: "beranda", scale: 1 },
          { id: "k_2", slug: "masuk", scale: 2 },
          { id: "id salah", slug: "beranda", scale: 1 },
          { id: "k_3", slug: "beranda", scale: 3 },
          { id: "k_4", scale: 1 },
          { slug: "masuk", scale: 1 },
          { id: "k_5", slug: "", scale: 1 },
          { id: "x".repeat(65), slug: "beranda", scale: 1 },
          "bukan objek",
          null,
          { id: "k_6", slug: "profil", scale: 2 },
        ],
      }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getDesignStamp("s1")).toEqual({
      stamp: "abc123",
      captures: [
        { id: "k_1", slug: "beranda", scale: 1 },
        { id: "k_2", slug: "masuk", scale: 2 },
        { id: "k_6", slug: "profil", scale: 2 },
      ],
    });
  });

  test("getDesignStamp membatasi captures maksimal sepuluh", async () => {
    const captures = Array.from({ length: 15 }, (_, i) => ({
      id: `k_${i}`,
      slug: "beranda",
      scale: 1,
    }));
    const { fetch } = fakeFetch(() => jsonResponse({ stamp: "s", captures }));
    const api = createApiClient({ fetch });

    const hasil = await api.getDesignStamp("s1");
    expect(hasil.captures).toHaveLength(10);
    expect(hasil.captures?.[9]?.id).toBe("k_9");
  });

  test("uploadDesignCapture POST body JSON dengan id ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.uploadDesignCapture(
      "s 1",
      "k/1",
      { dataUrl: "data:image/png;base64,AAAA" },
      "repo satu",
    );

    expect(calls[0]?.url).toBe("/api/sessions/s%201/design/capture/k%2F1?repo=repo%20satu");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
    });
  });

  test("uploadDesignCapture meneruskan alasan gagal tanpa repo", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.uploadDesignCapture("s1", "k_1", { error: "no-frame" });
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/capture/k_1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ error: "no-frame" });
  });

  test("uploadDesignCapture melempar galat server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Permintaan tidak ditemukan." }, 404));
    const api = createApiClient({ fetch });

    await expect(
      api.uploadDesignCapture("s1", "k_1", { error: "failed" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("getDesignPage mengirim slug dan repo ter-encode", async () => {
    const payload = { slug: "beranda", html: "<html></html>", mtime: 5, warnings: ["a"] };
    const { fetch, calls } = fakeFetch(() => jsonResponse(payload));
    const api = createApiClient({ fetch });

    expect(await api.getDesignPage("s1", "beranda", "repo satu")).toEqual(payload);
    expect(calls[0]?.url).toBe(
      "/api/sessions/s1/design/page?slug=beranda&repo=repo%20satu",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getDesignPage menolak respons tanpa html", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ slug: "x" }));
    const api = createApiClient({ fetch });

    await expect(api.getDesignPage("s1", "x")).rejects.toBeInstanceOf(ApiError);
  });

  test("designFrameUrl meng-encode id, slug, versi, dan repo", () => {
    expect(designFrameUrl("a/b c", "beranda", 12, "repo satu")).toBe(
      "/api/sessions/a%2Fb%20c/design/frame?slug=beranda&v=12&repo=repo%20satu",
    );
    expect(designFrameUrl("s1", "x y", 0)).toBe(
      "/api/sessions/s1/design/frame?slug=x%20y&v=0",
    );
  });

  test("klien menyediakan designFrameUrl yang sama", () => {
    const { fetch } = fakeFetch(() => jsonResponse({}));
    const api = createApiClient({ fetch });
    expect(api.designFrameUrl("s1", "beranda", 3, "web")).toBe(
      "/api/sessions/s1/design/frame?slug=beranda&v=3&repo=web",
    );
  });

  test("saveDesignLayout PUT body pages dan repo", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, updated: 2 }));
    const api = createApiClient({ fetch });
    const pages = [
      { slug: "beranda", x: 0, y: 0 },
      { slug: "profil", x: 1520, y: 0, device: "mobile" as const },
    ];

    expect(await api.saveDesignLayout("s1", pages, "web")).toEqual({ ok: true, updated: 2 });
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/layout?repo=web");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ pages, repo: "web" });
  });

  test("saveDesignLayout tanpa repo tidak mengirim key repo", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true, updated: 0 }));
    const api = createApiClient({ fetch });

    await api.saveDesignLayout("s1", []);
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/layout");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ pages: [] });
  });

  test("initDesign POST dan mengembalikan created", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ ok: true, created: ["design/design.json"] }, 201),
    );
    const api = createApiClient({ fetch });

    expect(await api.initDesign("s1", "web")).toEqual({
      ok: true,
      created: ["design/design.json"],
    });
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/init?repo=web");
    expect(calls[0]?.init.method).toBe("POST");
    // Penjaga server menolak POST tanpa content-type JSON (415).
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init.body).toBe("{}");
  });

  test("initDesign meneruskan tracked true di body", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ ok: true, created: ["design/design.json"] }, 201),
    );
    const api = createApiClient({ fetch });

    await api.initDesign("s1", "web", { tracked: true });
    expect(calls[0]?.url).toBe("/api/sessions/s1/design/init?repo=web");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ tracked: true });
  });

  test("initDesign dengan tracked false mengirim body kosong", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ ok: true, created: [] }, 201),
    );
    const api = createApiClient({ fetch });

    await api.initDesign("s1", undefined, { tracked: false });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  test("galat server dilempar dengan pesan dan status", async () => {
    for (const [status, message] of [
      [403, "Penyuntingan berkas dimatikan."],
      [409, "Sesi sedang berjalan."],
    ] as const) {
      const { fetch } = fakeFetch(() => jsonResponse({ error: message }, status));
      const api = createApiClient({ fetch });

      let caught: unknown;
      try {
        await api.initDesign("s1");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(status);
      expect((caught as ApiError).message).toBe(message);
    }
  });
});

describe("klien API komentar desain", () => {
  const COMMENT: DesignComment = {
    id: "c_aaaaaaaaaa",
    slug: "beranda",
    selector: '[id="judul"]',
    text: "Perbesar judul",
    status: "open",
    createdAt: 1,
  };

  test("listDesignComments GET dan membuang elemen tak sah", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        comments: [COMMENT, { id: 5 }, { ...COMMENT, status: "lama" }, "x"],
        mtime: 123,
      }),
    );
    const api = createApiClient({ fetch });

    expect(await api.listDesignComments("a/b c", "repo satu")).toEqual({
      comments: [COMMENT],
      mtime: 123,
    });
    expect(calls[0]?.url).toBe("/api/sessions/a%2Fb%20c/design/comments?repo=repo%20satu");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("listDesignComments menolak respons tanpa daftar", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ comments: "x" }));
    const api = createApiClient({ fetch });
    await expect(api.listDesignComments("s1")).rejects.toBeInstanceOf(ApiError);
  });

  test("addDesignComment POST body JSON dan repo di query", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ comment: COMMENT }, 201));
    const api = createApiClient({ fetch });

    const hasil = await api.addDesignComment(
      "s 1",
      { slug: "beranda", selector: '[id="judul"]', text: "Perbesar judul" },
      "web",
    );
    expect(hasil).toEqual(COMMENT);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/design/comments?repo=web");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      slug: "beranda",
      selector: '[id="judul"]',
      text: "Perbesar judul",
    });
  });

  test("addDesignComment menolak respons tanpa komentar sah", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}, 201));
    const api = createApiClient({ fetch });
    await expect(
      api.addDesignComment("s1", { slug: "beranda", selector: "#a", text: "x" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("updateDesignComment PATCH id ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ comment: { ...COMMENT, status: "done" } }),
    );
    const api = createApiClient({ fetch });

    const hasil = await api.updateDesignComment("s1", "c/a b", { status: "done" }, "web");
    expect(hasil.status).toBe("done");
    expect(calls[0]?.url).toBe(
      "/api/sessions/s1/design/comments/c%2Fa%20b?repo=web",
    );
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: "done" });
  });

  test("deleteDesignComment DELETE dengan content-type JSON", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.deleteDesignComment("s1", "c_aaaaaaaaaa", "web");
    expect(calls[0]?.url).toBe(
      "/api/sessions/s1/design/comments/c_aaaaaaaaaa?repo=web",
    );
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });
});
