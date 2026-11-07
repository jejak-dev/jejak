import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";
import { VERSION } from "../src/shared/version";

type App = ReturnType<typeof createApp>;

function req(
  server: App,
  path = "/api/info",
  headers: Record<string, string> = { host: "127.0.0.1:3000" },
): Promise<Response> {
  return server.handle(new Request(`http://127.0.0.1:3000${path}`, { method: "GET", headers }));
}

describe("GET /api/info", () => {
  test("mengembalikan name, version, cwd kustom, dan mock false", async () => {
    const res = await req(createApp({ env: {}, cwd: "/tmp/proyek" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "jejak",
      version: VERSION,
      cwd: "/tmp/proyek",
      mock: false,
    });
  });

  test("cwd bawaan process.cwd() bila tidak diberikan", async () => {
    const res = await req(createApp({ env: {} }));
    const data = (await res.json()) as { cwd: string };
    expect(data.cwd).toBe(process.cwd());
  });

  test("mock mengikuti env MOCK=true (trim dan case-insensitive)", async () => {
    for (const value of ["true", " TRUE ", "True"]) {
      const res = await req(createApp({ env: { MOCK: value } }));
      const data = (await res.json()) as { mock: boolean };
      expect(data.mock).toBe(true);
    }

    for (const env of [{}, { MOCK: "false" }, { MOCK: "1" }] as Array<
      Record<string, string>
    >) {
      const res = await req(createApp({ env }));
      const data = (await res.json()) as { mock: boolean };
      expect(data.mock).toBe(false);
    }
  });

  test("Host evil.test ditolak 403", async () => {
    const res = await req(createApp({ env: {} }), "/api/info", { host: "evil.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });
});
