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

const STATUS = {
  installed: { version: "0.3.323", installedAt: "2026-11-12T10:00:00.000Z" },
  previous: "0.3.322",
  supportedRange: ">=0.3.0 <1",
  lastCheck: { latest: "0.3.323", checkedAt: "2026-11-12T10:05:00.000Z" },
  busy: false,
};

describe("getSdk", () => {
  test("memakai GET dan mengembalikan status lengkap", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATUS));
    const api = createApiClient({ fetch });

    expect(await api.getSdk()).toEqual(STATUS);
    expect(calls[0]?.url).toBe("/api/sdk");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("bentuk salah memakai default aman", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ installed: "tidak", previous: 7, supportedRange: 9, busy: "ya" }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getSdk()).toEqual({
      installed: null,
      previous: null,
      supportedRange: "",
      lastCheck: null,
      busy: false,
    });
  });

  test("502 menjadi ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Tidak bisa menghubungi registry npm." }, 502),
    );
    const api = createApiClient({ fetch });

    await expect(api.getSdk()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "Tidak bisa menghubungi registry npm.",
    });
  });
});

describe("checkSdk", () => {
  test("memakai POST dengan body JSON kosong dan mengembalikan kandidat", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        latest: "0.3.323",
        candidate: "0.3.322",
        note: "Versi terbaru di luar rentang.",
        installedVersion: "0.3.321",
        updateAvailable: true,
        unpackedSize: 5_200_000,
      }),
    );
    const api = createApiClient({ fetch });

    const result = await api.checkSdk();
    expect(result.candidate).toBe("0.3.322");
    expect(result.updateAvailable).toBe(true);
    expect(result.unpackedSize).toBe(5_200_000);
    expect(result.note).toContain("rentang");
    expect(calls[0]?.url).toBe("/api/sdk/check");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });

  test("bentuk salah tidak melempar untuk ukuran yang bukan angka", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ candidate: "0.3.1", unpackedSize: "besar" }),
    );
    const api = createApiClient({ fetch });

    const result = await api.checkSdk();
    expect(result.unpackedSize).toBeUndefined();
    expect(result.updateAvailable).toBe(false);
  });

  test("422 menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Integritas tidak cocok." }, 422));
    const api = createApiClient({ fetch });

    const error = await api.checkSdk().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
  });
});

describe("installSdk", () => {
  test("mengirim POST dengan body version persis", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ installed: { version: "0.3.322", installedAt: "2026-11-12T11:00:00.000Z" } }),
    );
    const api = createApiClient({ fetch });

    const result = await api.installSdk("0.3.322");
    expect(result.installed?.version).toBe("0.3.322");
    expect(calls[0]?.url).toBe("/api/sdk/install");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ version: "0.3.322" }));
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["content-type"],
    ).toBe("application/json");
  });

  test("tanpa version tetap mengirim body JSON kosong", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ installed: null }));
    const api = createApiClient({ fetch });

    expect(await api.installSdk()).toEqual({ installed: null });
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });

  test("409 menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Pemasangan SDK sedang berjalan." }, 409),
    );
    const api = createApiClient({ fetch });

    const error = await api.installSdk("0.3.322").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
  });
});

describe("rollbackSdk", () => {
  test("memakai POST dengan body JSON kosong dan mengembalikan versi aktif", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ installed: { version: "0.3.321", installedAt: "2026-11-12T12:00:00.000Z" } }),
    );
    const api = createApiClient({ fetch });

    const result = await api.rollbackSdk();
    expect(result.installed?.version).toBe("0.3.321");
    expect(calls[0]?.url).toBe("/api/sdk/rollback");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });

  test("404 menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Tidak ada versi SDK sebelumnya." }, 404),
    );
    const api = createApiClient({ fetch });

    const error = await api.rollbackSdk().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});
