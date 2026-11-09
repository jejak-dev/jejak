import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, type AuditEntryItem } from "../src/client/lib/api";

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

const ENTRY: AuditEntryItem = {
  id: 7,
  ts: "2026-11-09T07:00:00.000Z",
  sessionId: "s1",
  kind: "tool",
  summary: "Read src/a.ts",
  meta: { tool: "Read" },
};

const SUMMARY = {
  days: 7,
  since: "2026-11-02T00:00:00.000Z",
  total: 3,
  byKind: { tool: 3 },
  redactedSessions: 1,
};

describe("listAudit", () => {
  test("tanpa parameter tidak mengirim query string", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ entries: [ENTRY], next: null }));
    const api = createApiClient({ fetch });

    const result = await api.listAudit();

    expect(result).toEqual({ entries: [ENTRY], next: null });
    expect(calls[0]?.url).toBe("/api/audit");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("membangun query dan membuang nilai kosong", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ entries: [], next: 12 }));
    const api = createApiClient({ fetch });

    await api.listAudit({ session: "a b", kind: "tool", before: 40, limit: 50 });
    await api.listAudit({ session: "", kind: "" });

    expect(calls[0]?.url).toBe("/api/audit?session=a%20b&kind=tool&before=40&limit=50");
    expect(calls[1]?.url).toBe("/api/audit");
  });

  test("next angka dikembalikan sebagai kursor", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ entries: [ENTRY], next: 3 }));
    const api = createApiClient({ fetch });

    expect((await api.listAudit()).next).toBe(3);
  });

  test("respons tanpa entries menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ next: null }));
    const api = createApiClient({ fetch });

    await expect(api.listAudit()).rejects.toBeInstanceOf(ApiError);
  });

  test("503 mengikuti pola ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Log audit dimatikan." }, 503),
    );
    const api = createApiClient({ fetch });

    const error = await api.listAudit().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).message).toBe("Log audit dimatikan.");
  });
});

describe("getAuditSummary", () => {
  test("GET /api/audit/summary", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(SUMMARY));
    const api = createApiClient({ fetch });

    expect(await api.getAuditSummary()).toEqual(SUMMARY);
    expect(calls[0]?.url).toBe("/api/audit/summary");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("respons tidak valid menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ days: 7 }));
    const api = createApiClient({ fetch });

    await expect(api.getAuditSummary()).rejects.toBeInstanceOf(ApiError);
  });

  test("503 mengikuti pola ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Log audit dimatikan." }, 503));
    const api = createApiClient({ fetch });

    await expect(api.getAuditSummary()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
