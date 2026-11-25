import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const HOST = { host: "127.0.0.1:3000" };
let dir: string;
let probeDipanggil = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-acp-auth-"));
  probeDipanggil = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("rute agent ACP di balik autentikasi sandi", () => {
  test("tanpa cookie, daftar dan probe ditolak dan probe tidak dijalankan", async () => {
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      auth: { password: "sandi-uji-123", port: 3000 },
      acpProbe: async () => {
        probeDipanggil += 1;
        return undefined;
      },
    });
    const daftar = await app.handle(new Request("http://127.0.0.1:3000/api/acp/agents", { headers: HOST }));
    expect(daftar.status).toBe(401);
    const probe = await app.handle(
      new Request("http://127.0.0.1:3000/api/acp/agents/antigravity/probe", {
        method: "POST",
        headers: { ...HOST, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(probe.status).toBe(401);
    expect(probeDipanggil).toBe(0);
  });
});
