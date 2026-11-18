import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, type DesignResult } from "../src/client/lib/api";

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
