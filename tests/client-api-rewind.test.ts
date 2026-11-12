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

describe("rewindConversation", () => {
  test("memakai POST ke /rewind dengan eventSeq dan mengembalikan teks", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ text: "pesan kedua" }));
    const api = createApiClient({ fetch });

    expect(await api.rewindConversation("s_1", 4)).toEqual({ text: "pesan kedua" });

    const call = calls[0];
    expect(call?.url).toBe("/api/sessions/s_1/rewind");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(JSON.stringify({ eventSeq: 4 }));
    expect((call?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  test("id sesi di-encode pada path", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ text: "ok" }));
    const api = createApiClient({ fetch });

    await api.rewindConversation("s/1 2", 3);

    expect(calls[0]?.url).toBe("/api/sessions/s%2F1%202/rewind");
  });

  test("galat server menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Hentikan sesi dulu." }, 409));
    const api = createApiClient({ fetch });

    await expect(api.rewindConversation("s_1", 4)).rejects.toBeInstanceOf(ApiError);
    await expect(api.rewindConversation("s_1", 4)).rejects.toThrow("Hentikan sesi dulu.");
  });

  test("teks kosong tetap menjadi string", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}));
    const api = createApiClient({ fetch });

    expect(await api.rewindConversation("s_1", 4)).toEqual({ text: "" });
  });
});
