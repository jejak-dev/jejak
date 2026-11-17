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

describe("command-env", () => {
  test("getCommandEnv memakai GET tanpa body", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ path: "/tmp/proyek/.env", keys: ["A", "B"] }),
    );
    const api = createApiClient({ fetch });

    const result = await api.getCommandEnv("s 1");

    expect(result).toEqual({ path: "/tmp/proyek/.env", keys: ["A", "B"] });
    expect(calls[0]?.url).toBe("/api/sessions/s%201/command-env");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("getCommandEnv tanpa path hanya berisi keys", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ keys: [] }));
    const api = createApiClient({ fetch });

    expect(await api.getCommandEnv("s1")).toEqual({ keys: [] });
  });

  test("setCommandEnv mengirim PUT dengan body path", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ path: "/tmp/.env", keys: ["A"] }),
    );
    const api = createApiClient({ fetch });

    const result = await api.setCommandEnv("s1", "/tmp/.env");

    expect(result).toEqual({ path: "/tmp/.env", keys: ["A"] });
    expect(calls[0]?.url).toBe("/api/sessions/s1/command-env");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "/tmp/.env" }));
  });

  test("clearCommandEnv mengirim DELETE tanpa body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ removed: true }));
    const api = createApiClient({ fetch });

    expect(await api.clearCommandEnv("s1")).toEqual({ removed: true });
    expect(calls[0]?.url).toBe("/api/sessions/s1/command-env");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("400 validasi menjadi ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Berkas tidak ditemukan." }, 400),
    );
    const api = createApiClient({ fetch });

    const error = await api.setCommandEnv("s1", "/x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("Berkas tidak ditemukan.");
  });

  test("503 menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Env perintah dimatikan." }, 503),
    );
    const api = createApiClient({ fetch });

    await expect(api.getCommandEnv("s1")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Env perintah dimatikan.",
    });
  });
});
