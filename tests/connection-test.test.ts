import { describe, expect, test } from "bun:test";
import { testConnection } from "../src/server/connection-test";
import type { ResolvedProvider } from "../src/server/provider";

const API_KEY = "sk-rahasia-uji";
const BASE = { profileId: "alpha", model: "claude-test" } satisfies ResolvedProvider;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const resolvedInit = init ?? {};
    calls.push({ url, init: resolvedInit });
    return handler(url, resolvedInit);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("testConnection: sukses", () => {
  test("tool_use echo menghasilkan toolCalling ok", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({
        content: [
          { type: "text", text: "baik" },
          { type: "tool_use", name: "echo", input: { text: "ping" } },
        ],
      }),
    );

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.toolCalling).toBe("ok");
    expect(result.model).toBe("claude-test");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("tanpa tool_use tetap ok dengan toolCalling tidak-dipanggil", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ content: [{ type: "text", text: "halo" }] }));

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(true);
    expect(result.toolCalling).toBe("tidak-dipanggil");
  });

  test("tool_use dengan input.text bukan string dianggap tidak-dipanggil", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({ content: [{ type: "tool_use", name: "echo", input: { text: 42 } }] }),
    );

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(true);
    expect(result.toolCalling).toBe("tidak-dipanggil");
  });
});

describe("testConnection: permintaan", () => {
  test("URL, header, body, redirect, dan signal benar", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ content: [] }));

    await testConnection(
      { ...BASE, baseUrl: "https://contoh.test/api/", apiKey: API_KEY },
      { fetch: impl },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://contoh.test/api/v1/messages");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);

    const headers = call?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe(API_KEY);

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-test");
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([{ role: "user", content: 'Panggil tool echo dengan text "ping".' }]);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.name).toBe("echo");
    expect(tools[0]?.input_schema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  test("tanpa baseUrl memakai api.anthropic.com", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ content: [] }));

    await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  test("tanpa apiKey tidak mengirim x-api-key", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ content: [] }));

    await testConnection({ ...BASE }, { fetch: impl });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("model kosong tidak memanggil fetch", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ content: [] }));

    const result = await testConnection({ profileId: "alpha", apiKey: API_KEY }, { fetch: impl });

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.toolCalling).toBe("tidak-diuji");
    expect(result.error).toBe("model belum diatur pada profil ini");
  });
});

describe("testConnection: status non-2xx", () => {
  const cases: Array<[number, string]> = [
    [401, "autentikasi ditolak (periksa API key)"],
    [403, "autentikasi ditolak (periksa API key)"],
    [404, "endpoint tidak ditemukan (periksa base URL dan model)"],
    [429, "terkena rate limit"],
    [500, "provider mengalami kesalahan (status 500)"],
    [418, "permintaan ditolak (status 418)"],
  ];

  for (const [status, error] of cases) {
    test(`status ${status} menghasilkan pesan yang sesuai`, async () => {
      const { impl } = fakeFetch(() => jsonResponse({ error: "isi body rahasia" }, status));

      const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      expect(result.error).toBe(error);
      expect(result.error).not.toContain("isi body rahasia");
      expect(result.toolCalling).toBe("tidak-diuji");
    });
  }
});

describe("testConnection: respons tidak dikenali dan jaringan", () => {
  test("200 non-JSON ditolak", async () => {
    const { impl } = fakeFetch(() => textResponse("<html>ok</html>"));

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.toolCalling).toBe("tidak-diuji");
    expect(result.error).toBe(
      "respons tidak dikenali (apakah base URL menunjuk ke API kompatibel Anthropic?)",
    );
  });

  test("200 JSON tanpa array content ditolak", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ content: "bukan array" }));

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.toolCalling).toBe("tidak-diuji");
  });

  test("fetch melempar tidak meneruskan error asli maupun key", async () => {
    const { impl } = fakeFetch(() => {
      throw new Error(`gagal menghubungi ${API_KEY} di https://user:pass@contoh.test/rahasia`);
    });

    const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.toolCalling).toBe("tidak-diuji");
    expect(result.error).toBe("tidak dapat terhubung ke provider (timeout atau jaringan)");
  });
});

describe("testConnection: kerahasiaan", () => {
  test("hasil JSON tidak memuat apiKey", async () => {
    const responses = [
      () => jsonResponse({ content: [{ type: "tool_use", name: "echo", input: { text: "ping" } }] }),
      () => jsonResponse({ error: API_KEY }, 401),
      () => textResponse("bukan json"),
      () => {
        throw new Error(`gagal ${API_KEY}`);
      },
    ];

    for (const respond of responses) {
      const { impl } = fakeFetch(respond);
      const result = await testConnection({ ...BASE, apiKey: API_KEY }, { fetch: impl });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
  });
});
