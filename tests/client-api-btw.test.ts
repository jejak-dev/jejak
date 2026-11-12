import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient } from "../src/client/lib/api";

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

describe("askSideQuestion", () => {
  test("memakai POST ke /btw dan mengembalikan jawaban", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ answer: "Jawaban ringkas." }));
    const api = createApiClient({ fetch });

    expect(await api.askSideQuestion("s_1", "apa agenda?")).toEqual({
      answer: "Jawaban ringkas.",
    });

    const call = calls[0];
    expect(call?.url).toBe("/api/sessions/s_1/btw");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(JSON.stringify({ question: "apa agenda?" }));
    expect((call?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  test("id sesi di-encode pada path", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ answer: "ok" }));
    const api = createApiClient({ fetch });

    await api.askSideQuestion("s/1 2", "halo");

    expect(calls[0]?.url).toBe("/api/sessions/s%2F1%202/btw");
  });

  test("galat server menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Sesi ini belum punya riwayat." }, 400));
    const api = createApiClient({ fetch });

    await expect(api.askSideQuestion("s_1", "halo")).rejects.toBeInstanceOf(ApiError);
    await expect(api.askSideQuestion("s_1", "halo")).rejects.toThrow(
      "Sesi ini belum punya riwayat.",
    );
  });

  test("jawaban kosong tetap menjadi string", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}));
    const api = createApiClient({ fetch });

    expect(await api.askSideQuestion("s_1", "halo")).toEqual({ answer: "" });
  });
});
