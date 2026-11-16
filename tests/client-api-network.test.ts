import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient } from "../src/client/lib/api";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
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

const STATUS = {
  enabled: true,
  port: 4747,
  listening: true,
  urls: ["http://192.168.1.5:4747"],
  passwordRequired: false,
};

describe("api akses jaringan", () => {
  test("getNetworkStatus memakai GET /api/network", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATUS));
    const api = createApiClient({ fetch });

    const status = await api.getNetworkStatus();

    expect(status.enabled).toBe(true);
    expect(status.listening).toBe(true);
    expect(status.urls).toEqual(["http://192.168.1.5:4747"]);
    expect(status.passwordRequired).toBe(false);
    expect(calls[0]?.url).toBe("/api/network");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("setNetwork mengirim PUT dengan enabled dan port", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATUS));
    const api = createApiClient({ fetch });

    await api.setNetwork({ enabled: true, port: 5000 });

    expect(calls[0]?.url).toBe("/api/network");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      enabled: true,
      port: 5000,
    });
  });

  test("setNetwork tanpa port tak mengirim kolom port", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATUS));
    const api = createApiClient({ fetch });

    await api.setNetwork({ enabled: false });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ enabled: false });
  });

  test("server tanpa fitur jaringan menjawab 404 dan melempar ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "akses jaringan tidak tersedia" }, 404));
    const api = createApiClient({ fetch });

    let galat: unknown;
    try {
      await api.getNetworkStatus();
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(ApiError);
    expect((galat as ApiError).status).toBe(404);
  });
});
