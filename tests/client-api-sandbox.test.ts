import { describe, expect, test } from "bun:test";
import {
  ApiError,
  createApiClient,
  type SandboxConfigItem,
  type SandboxState,
} from "../src/client/lib/api";

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

const CONFIG: SandboxConfigItem = {
  mode: "standar",
  allowedDomains: ["example.com"],
  extraDenyRead: ["~/.ssh"],
  extraDenyWrite: ["/etc"],
  extraAllowWrite: ["~/tmp"],
  extraAllowUnixSockets: ["/var/run/docker.sock"],
  allowLocalBinding: false,
};

const STATE: SandboxState = {
  config: CONFIG,
  defaults: {
    allowedDomains: ["registry.npmjs.org"],
    denyRead: [".ssh"],
    denyWrite: [".git/hooks"],
  },
  available: { ok: true, detail: "sandbox-exec tersedia" },
};

describe("getSandbox", () => {
  test("memakai GET dan mengembalikan state lengkap", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(STATE));
    const api = createApiClient({ fetch });

    expect(await api.getSandbox()).toEqual(STATE);
    expect(calls[0]?.url).toBe("/api/sandbox");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("bentuk salah memakai default aman dan daftar disaring", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        config: { mode: "asing", allowedDomains: ["a.com", 1], extraDenyRead: "x" },
        defaults: { allowedDomains: [true] },
        available: { ok: "ya", detail: 5 },
      }),
    );
    const api = createApiClient({ fetch });

    expect(await api.getSandbox()).toEqual({
      config: {
        mode: "standar",
        allowedDomains: ["a.com"],
        extraDenyRead: [],
        extraDenyWrite: [],
        extraAllowWrite: [],
        extraAllowUnixSockets: [],
        allowLocalBinding: false,
      },
      defaults: { allowedDomains: [], denyRead: [], denyWrite: [] },
      available: { ok: false, detail: "" },
    });
  });

  test("503 menjadi ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Sandbox dimatikan." }, 503));
    const api = createApiClient({ fetch });

    await expect(api.getSandbox()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Sandbox dimatikan.",
    });
  });
});

describe("putSandbox", () => {
  test("mengirim PUT dengan field yang diberikan saja", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ config: CONFIG }));
    const api = createApiClient({ fetch });

    const result = await api.putSandbox({
      mode: "mati",
      extraAllowWrite: ["~/tmp"],
      extraAllowUnixSockets: ["/var/run/docker.sock"],
      allowLocalBinding: true,
    });

    expect(result).toEqual(CONFIG);
    expect(calls[0]?.url).toBe("/api/sandbox");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        mode: "mati",
        extraAllowWrite: ["~/tmp"],
        extraAllowUnixSockets: ["/var/run/docker.sock"],
        allowLocalBinding: true,
      }),
    );
  });

  test("400 menjadi ApiError dengan pesan validasi", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: 'Mode sandbox hanya "standar" atau "mati".' }, 400),
    );
    const api = createApiClient({ fetch });

    const error = await api.putSandbox({ mode: "mati" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("standar");
  });
});

describe("createSession sandbox", () => {
  const SESSION = { session: { id: "s1", title: "t" } };

  test("mengirim sandbox bila diisi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(SESSION));
    const api = createApiClient({ fetch });

    await api.createSession({ prompt: "hai", sandbox: "mati" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ prompt: "hai", sandbox: "mati" });
  });

  test("tidak mengirim sandbox bila tidak diisi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(SESSION));
    const api = createApiClient({ fetch });

    await api.createSession({ prompt: "hai" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ prompt: "hai" });
  });
});

describe("setSessionSandbox", () => {
  test("PATCH ke sesi dengan body sandbox dan content-type json", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ session: { id: "s1", sandbox: "mati" } }));
    const api = createApiClient({ fetch });

    const info = await api.setSessionSandbox("s1", "mati");
    expect(info.sandbox).toBe("mati");
    expect(calls[0]?.url).toBe("/api/sessions/s1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["content-type"],
    ).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ sandbox: "mati" });
  });
});
