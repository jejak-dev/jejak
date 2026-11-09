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

const STATE = { root: "/tmp/proyek", allowed: [".env"] };

describe("secret-allow", () => {
  test("getSecretAllow memakai GET tanpa body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATE));
    const api = createApiClient({ fetch });

    const result = await api.getSecretAllow("s 1");

    expect(result).toEqual(STATE);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/secret-allow");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("addSecretAllow mengirim POST dengan body path", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ path: ".env", rule: "env", allowed: [".env"] }),
    );
    const api = createApiClient({ fetch });

    const result = await api.addSecretAllow("s1", ".env");

    expect(result).toEqual({ path: ".env", rule: "env", allowed: [".env"] });
    expect(calls[0]?.url).toBe("/api/sessions/s1/secret-allow");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: ".env" }));
  });

  test("removeSecretAllow mengirim DELETE dengan body path", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ removed: true, allowed: [] }),
    );
    const api = createApiClient({ fetch });

    const result = await api.removeSecretAllow("s1", ".env");

    expect(result).toEqual({ removed: true, allowed: [] });
    expect(calls[0]?.url).toBe("/api/sessions/s1/secret-allow");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: ".env" }));
  });

  test("503 menjadi ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Daftar izin rahasia dimatikan." }, 503),
    );
    const api = createApiClient({ fetch });

    await expect(api.getSecretAllow("s1")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Daftar izin rahasia dimatikan.",
    });
  });

  test("400 validasi menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Jalur berada di luar proyek." }, 400),
    );
    const api = createApiClient({ fetch });

    const error = await api.addSecretAllow("s1", "../x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("Jalur berada di luar proyek.");
  });
});
