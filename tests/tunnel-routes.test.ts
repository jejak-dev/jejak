import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { PasswordRecord, PasswordStore } from "../src/server/auth/password-store";
import {
  defaultNetworkSettings,
  type NetworkSettings,
  type NetworkStore,
} from "../src/server/network/network-store";
import type { TunnelTokenStore } from "../src/server/network/token-store";
import { TunnelManager, type TunnelProcess } from "../src/server/network/tunnel-manager";
import { VIA_HEADER, VIA_NETWORK } from "../src/server/network/network-fetch";

const PASSWORD = "sandi-uji-123";
const TOKEN = "token-rahasia-uji-123";
const HOST = "jejak.contoh.com";
const HOST_HEADER = { host: "127.0.0.1:3000" };

let dir: string;
let audit: SqliteAuditStore;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-tunnel-routes-"));
  audit = new SqliteAuditStore(":memory:");
});

afterEach(async () => {
  audit.close();
  await rm(dir, { recursive: true, force: true });
});

class MemoryStore implements NetworkStore {
  settings: NetworkSettings = defaultNetworkSettings();

  load(): NetworkSettings {
    return { ...this.settings };
  }

  save(settings: NetworkSettings): void {
    this.settings = { ...settings };
  }
}

class MemoryTokenStore implements TunnelTokenStore {
  token: string | undefined;

  has(): boolean {
    return this.token !== undefined;
  }

  get(): string | undefined {
    return this.token;
  }

  set(token: string): void {
    this.token = token;
  }

  clear(): boolean {
    const ada = this.token !== undefined;
    this.token = undefined;
    return ada;
  }
}

function passwordStore(has: boolean): PasswordStore {
  return {
    has: () => has,
    load: (): PasswordRecord | undefined => undefined,
    set: () => {
      throw new Error("tak dipakai");
    },
    clear: () => false,
    verify: () => false,
  };
}

interface Harness {
  app: App;
  manager: TunnelManager;
  store: MemoryStore;
  tokens: MemoryTokenStore;
  spawns: Array<{ cmd: string[]; env: Record<string, string> }>;
}

function makeHarness(
  options: { hasPassword?: boolean; listening?: boolean; installed?: boolean } = {},
): Harness {
  const store = new MemoryStore();
  const tokens = new MemoryTokenStore();
  const spawns: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  const manager = new TunnelManager({
    spawn: (cmd, env) => {
      spawns.push({ cmd, env });
      const proc: TunnelProcess = {
        exited: new Promise<number>(() => undefined),
        kill: () => undefined,
      };
      return proc;
    },
    which: () => (options.installed === false ? undefined : "/usr/local/bin/cloudflared"),
    store,
    tokenStore: tokens,
    passwordStore: passwordStore(options.hasPassword ?? true),
    network: { status: () => ({ listening: options.listening ?? true }) },
  });
  const app = createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    auth: { password: PASSWORD, port: 3000 },
    tunnel: manager,
  });
  return { app, manager, store, tokens, spawns };
}

function request(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { ...HOST_HEADER, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function loginCookie(app: App): Promise<string> {
  const res = await request(app, "POST", "/api/auth/login", { password: PASSWORD });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("rute tunnel", () => {
  test("tanpa manajer rute menjawab 404", async () => {
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      audit,
      auth: { password: PASSWORD, port: 3000 },
    });
    const cookie = await loginCookie(app);
    const res = await request(app, "GET", "/api/tunnel", undefined, { cookie });
    expect(res.status).toBe(404);
  });

  test("butuh login", async () => {
    const { app } = makeHarness();
    const res = await request(app, "GET", "/api/tunnel");
    expect(res.status).toBe(401);
  });

  test("GET mengembalikan status tanpa token", async () => {
    const { app } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(app, "GET", "/api/tunnel", undefined, { cookie });
    expect(res.status).toBe(200);
    const teks = await res.text();
    expect(teks).not.toContain(TOKEN);
    const body = JSON.parse(teks) as { enabled: boolean; hasToken: boolean; installed: boolean };
    expect(body.enabled).toBe(false);
    expect(body.hasToken).toBe(false);
    expect(body.installed).toBe(true);
  });

  test("PUT menyalakan tunnel, menyimpan token, dan mencatat audit", async () => {
    const { app, store, tokens, spawns } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    expect(res.status).toBe(200);
    const teks = await res.text();
    expect(teks).not.toContain(TOKEN);
    const body = JSON.parse(teks) as { enabled: boolean; running: boolean; url: string };
    expect(body.enabled).toBe(true);
    expect(body.running).toBe(true);
    expect(body.url).toBe(`https://${HOST}`);
    expect(tokens.token).toBe(TOKEN);
    expect(store.settings.tunnelEnabled).toBe(true);
    expect(spawns[0]!.env.TUNNEL_TOKEN).toBe(TOKEN);
    const entries = audit.list({ kind: "pengaturan" });
    const aksi = entries.map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("tunnel-diaktifkan");
    // Token tak pernah masuk audit.
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });

  test("PUT mematikan tunnel dan mencatat audit", async () => {
    const { app } = makeHarness();
    const cookie = await loginCookie(app);
    await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    const res = await request(app, "PUT", "/api/tunnel", { enabled: false }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
    const aksi = audit.list({ kind: "pengaturan" }).map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("tunnel-dimatikan");
  });

  test("token kosong tidak menghapus token tersimpan", async () => {
    const { app, tokens } = makeHarness();
    const cookie = await loginCookie(app);
    await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    await request(app, "PUT", "/api/tunnel", { enabled: false }, { cookie });
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, token: "" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(tokens.token).toBe(TOKEN);
  });

  test("syarat kurang dijawab 409 dengan pesan Indonesia", async () => {
    const { app } = makeHarness({ listening: false });
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("akses dari jaringan");
  });

  test("cloudflared tak ada dijawab 409", async () => {
    const { app } = makeHarness({ installed: false });
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cloudflared");
  });

  test("host tak sah dijawab 400", async () => {
    const { app } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: "https://evil.test/x", token: TOKEN },
      { cookie },
    );
    expect(res.status).toBe(400);
  });

  test("enabled bukan boolean dijawab 400", async () => {
    const { app } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(app, "PUT", "/api/tunnel", { enabled: "ya" }, { cookie });
    expect(res.status).toBe(400);
  });

  test("DELETE token menghapus token, mematikan tunnel, dan mencatat audit", async () => {
    const { app, tokens, store } = makeHarness();
    const cookie = await loginCookie(app);
    await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    const res = await request(app, "DELETE", "/api/tunnel/token", undefined, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasToken: boolean; enabled: boolean };
    expect(body.hasToken).toBe(false);
    expect(body.enabled).toBe(false);
    expect(tokens.token).toBeUndefined();
    expect(store.settings.tunnelEnabled).toBe(false);
    const aksi = audit.list({ kind: "pengaturan" }).map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("tunnel-token-dihapus");
  });

  test("PUT dari listener jaringan dijawab 403", async () => {
    const { app, tokens } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie, [VIA_HEADER]: VIA_NETWORK },
    );
    expect(res.status).toBe(403);
    expect(tokens.token).toBeUndefined();
  });

  test("DELETE token dari listener jaringan dijawab 403", async () => {
    const { app, tokens } = makeHarness();
    const cookie = await loginCookie(app);
    await request(
      app,
      "PUT",
      "/api/tunnel",
      { enabled: true, publicHost: HOST, token: TOKEN },
      { cookie },
    );
    const res = await request(app, "DELETE", "/api/tunnel/token", undefined, {
      cookie,
      [VIA_HEADER]: VIA_NETWORK,
    });
    expect(res.status).toBe(403);
    expect(tokens.token).toBe(TOKEN);
  });

  test("GET dari listener jaringan tetap boleh", async () => {
    const { app } = makeHarness();
    const cookie = await loginCookie(app);
    const res = await request(app, "GET", "/api/tunnel", undefined, {
      cookie,
      [VIA_HEADER]: VIA_NETWORK,
    });
    expect(res.status).toBe(200);
  });
});
