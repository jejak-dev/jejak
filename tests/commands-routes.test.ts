import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner, CommandInfo } from "../src/server/agent/events";

let dir: string;
let project: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-perintah-"));
  project = join(dir, "proyek");
  await mkdir(project, { recursive: true });
  providersFile = join(dir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia-123",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

const PERINTAH: CommandInfo[] = [
  { name: "compact", description: "Padatkan percakapan.", argumentHint: "" },
  { name: "ping", description: "Perintah kustom.", argumentHint: "<x>" },
];

/** Runner tiruan dengan daftar perintah yang disuntik. */
function runnerPerintah(daftar: CommandInfo[] = PERINTAH): AgentRunner {
  return {
    async *run() {
      yield { type: "result", ok: true };
    },
    async listCommands() {
      return daftar.map((item) => ({ ...item }));
    },
  };
}

function makeApp(options: { auth?: boolean } = {}): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner: runnerPerintah(),
    ...(options.auth === true
      ? { auth: { password: "sandi-uji-123", port: 3000 } }
      : {}),
  });
}

function req(
  app: App,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "GET",
      headers: { host: "127.0.0.1:3000", ...headers },
    }),
  );
}

describe("rute perintah", () => {
  test("daftar perintah dikembalikan", async () => {
    const app = makeApp();

    const res = await req(
      app,
      `/api/commands?cwd=${encodeURIComponent(project)}`,
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      commands: CommandInfo[];
      source: string;
    };
    expect(payload.source).toBe("sdk");
    expect(payload.commands.map((item) => item.name)).toEqual(["compact", "ping"]);
  });

  test("cwd wajib diisi", async () => {
    const app = makeApp();

    const res = await req(app, "/api/commands");

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("cwd");
  });

  test("cwd relatif ditolak", async () => {
    const app = makeApp();

    const res = await req(app, "/api/commands?cwd=./proyek");

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("absolut");
  });

  test("cwd yang tak ada ditolak", async () => {
    const app = makeApp();

    const res = await req(
      app,
      `/api/commands?cwd=${encodeURIComponent(join(dir, "hilang"))}`,
    );

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error.length).toBeGreaterThan(0);
  });

  test("berkas bukan direktori ditolak", async () => {
    const app = makeApp();
    const berkas = join(dir, "berkas.txt");
    await writeFile(berkas, "isi", "utf8");

    const res = await req(app, `/api/commands?cwd=${encodeURIComponent(berkas)}`);

    expect(res.status).toBe(400);
  });

  test("rute dijaga autentikasi", async () => {
    const app = makeApp({ auth: true });

    const res = await req(
      app,
      `/api/commands?cwd=${encodeURIComponent(project)}`,
    );

    expect(res.status).toBe(401);
  });

  test("rute terbuka setelah login", async () => {
    const app = makeApp({ auth: true });
    const masuk = await app.handle(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({ password: "sandi-uji-123" }),
      }),
    );
    expect(masuk.status).toBe(200);
    const cookie = (masuk.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const res = await req(
      app,
      `/api/commands?cwd=${encodeURIComponent(project)}`,
      { cookie },
    );

    expect(res.status).toBe(200);
  });
});
