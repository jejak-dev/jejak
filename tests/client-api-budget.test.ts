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

const CONFIG = { sessionUsd: 2, dailyUsd: 5, warnAt: 0.8 };

describe("budget", () => {
  test("getBudget memakai GET tanpa body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(CONFIG));
    const api = createApiClient({ fetch });

    expect(await api.getBudget()).toEqual(CONFIG);
    expect(calls[0]?.url).toBe("/api/budget");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("putBudget mengirim patch JSON termasuk null untuk hapus", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ sessionUsd: 3, warnAt: 0.9 }),
    );
    const api = createApiClient({ fetch });

    const result = await api.putBudget({ sessionUsd: 3, dailyUsd: null, warnAt: 0.9 });

    expect(result).toEqual({ sessionUsd: 3, warnAt: 0.9 });
    expect(calls[0]?.url).toBe("/api/budget");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ sessionUsd: 3, dailyUsd: null, warnAt: 0.9 }),
    );
  });

  test("putBudget tidak mengirim field yang tidak diberikan", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(CONFIG));
    const api = createApiClient({ fetch });

    await api.putBudget({ warnAt: 0.8 });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ warnAt: 0.8 }));
  });

  test("getBudgetStatus tanpa sesi", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ config: CONFIG, todayUsd: 1.2, dayLevel: "ok" }),
    );
    const api = createApiClient({ fetch });

    const result = await api.getBudgetStatus();
    expect(result).toEqual({ config: CONFIG, todayUsd: 1.2, dayLevel: "ok" });
    expect(calls[0]?.url).toBe("/api/budget/status");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("getBudgetStatus dengan sesi meng-encode query", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        config: CONFIG,
        todayUsd: 1.2,
        dayLevel: "warn",
        sessionUsd: 1.8,
        sessionLevel: "warn",
      }),
    );
    const api = createApiClient({ fetch });

    const result = await api.getBudgetStatus("s 1");
    expect(result.sessionLevel).toBe("warn");
    expect(result.sessionUsd).toBe(1.8);
    expect(calls[0]?.url).toBe("/api/budget/status?session=s%201");
  });

  test("503 menjadi ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Anggaran dimatikan." }, 503));
    const api = createApiClient({ fetch });

    await expect(api.getBudget()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Anggaran dimatikan.",
    });
  });

  test("respons tidak valid menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ todayUsd: "x" }));
    const api = createApiClient({ fetch });

    const error = await api.getBudgetStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
  });
});
