import { describe, expect, test } from "bun:test";
import { listModels } from "../src/server/connection-test";
import { pickFolderNative } from "../src/server/files/native-picker";
import type { ResolvedProvider } from "../src/server/provider";

function resolved(extra: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return { baseUrl: "https://api.test/", apiKey: "sk-rahasia", ...extra } as ResolvedProvider;
}

function fakeFetch(res: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return res();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("listModels", () => {
  test("membaca data[].id, dedupe, dan memakai key hanya di header", async () => {
    const f = fakeFetch(
      () => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "a" }, { x: 1 }] })),
    );
    const result = await listModels(resolved(), { fetch: f.impl });
    expect(result).toEqual({ ok: true, models: ["a", "b"] });
    expect(f.calls[0]!.url).toStartWith("https://api.test/v1/models");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-rahasia");
  });

  test("membaca jendela konteks dari field context_length dan sejenisnya", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "a", context_length: 1_000_000 },
              { id: "b", max_model_len: 131072 },
              { id: "c", context_length: "besar" },
              { id: "d" },
            ],
          }),
        ),
    );
    const result = await listModels(resolved(), { fetch: f.impl });
    expect(result.models).toEqual(["a", "b", "c", "d"]);
    expect(result.contextWindows).toEqual({ a: 1_000_000, b: 131072 });
  });

  test("401 -> galat autentikasi, 404 -> isi manual, 200 tak dikenal -> galat", async () => {
    for (const [status, text] of [
      [401, "autentikasi"],
      [404, "isi manual"],
      [500, "ditolak"],
    ] as const) {
      const f = fakeFetch(() => new Response("{}", { status }));
      const result = await listModels(resolved(), { fetch: f.impl });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(text);
    }
    const bad = fakeFetch(() => new Response(JSON.stringify({ foo: 1 })));
    expect((await listModels(resolved(), { fetch: bad.impl })).ok).toBe(false);
  });

  test("jaringan gagal -> galat tanpa membocorkan key", async () => {
    const impl = (async () => {
      throw new Error("boom sk-rahasia");
    }) as unknown as typeof fetch;
    const result = await listModels(resolved(), { fetch: impl });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-rahasia");
  });
});

describe("pickFolderNative", () => {
  test("bukan macOS -> galat", async () => {
    await expect(pickFolderNative(undefined, { platform: "linux" })).rejects.toThrow();
  });

  test("mengembalikan path tanpa slash akhir dan mengirim start lewat argv", async () => {
    let cmd: string[] = [];
    const out = await pickFolderNative("/tmp/x", {
      platform: "darwin",
      run: async (c) => {
        cmd = c;
        return { code: 0, stdout: "/Users/a/proyek/\n" };
      },
    });
    expect(out).toEqual({ path: "/Users/a/proyek" });
    expect(cmd[0]).toBe("osascript");
    expect(cmd[cmd.length - 1]).toBe("/tmp/x");
    expect(cmd.join(" ")).not.toContain("tmp/x\"");
  });

  test("dibatalkan (kode non-nol) -> tanpa path", async () => {
    const out = await pickFolderNative(undefined, {
      platform: "darwin",
      run: async () => ({ code: 1, stdout: "" }),
    });
    expect(out).toEqual({});
  });
});

import { createApp } from "../src/server";
import { createApiClient } from "../src/client/lib/api";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("rute dan klien", () => {
  test("POST /api/providers/models memakai profil tersimpan; /api/fs/native dan /api/fs/pick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jejak-models-"));
    try {
      const file = join(dir, "providers.json");
      await writeFile(
        file,
        JSON.stringify({
          profiles: [{ id: "p", name: "P", baseUrl: "https://p.test", apiKey: "sk-x", models: [{ id: "m" }], defaultModel: "m" }],
          activeProfileId: "p",
        }),
      );
      const seen: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
      }) as unknown as typeof fetch;
      const app = createApp({
        providersPath: file,
        env: {},
        fetch: fetchImpl,
      });
      const handle = (input: RequestInfo | URL, init?: RequestInit) =>
        app.handle(new Request(String(input), init));
      const api = createApiClient({
        baseUrl: "http://127.0.0.1:3000",
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          handle(input, {
            ...init,
            headers: { host: "127.0.0.1:3000", ...(init?.headers as Record<string, string>) },
          })) as typeof fetch,
      });
      expect(await api.listProviderModels("p")).toEqual({ ok: true, models: ["m1", "m2"] });
      expect(seen[0]).toStartWith("https://p.test/v1/models");
      expect(typeof (await api.nativePickerAvailable())).toBe("boolean");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
