import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { PasswordRecord, PasswordStore } from "../src/server/auth/password-store";
import {
  NetworkManager,
  type NetworkInterfaceEntry,
  type NetworkListener,
} from "../src/server/network/network-manager";
import {
  defaultNetworkSettings,
  type NetworkSettings,
  type NetworkStore,
} from "../src/server/network/network-store";

const PASSWORD = "sandi-uji-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let audit: SqliteAuditStore;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-network-routes-"));
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

const INTERFACES: NetworkInterfaceEntry[] = [
  { address: "192.168.1.5", family: "IPv4", internal: false },
];

/** Manajer dengan listener tiruan; tak membuka port sungguhan. */
function makeManager(hasPassword = true): {
  manager: NetworkManager;
  store: MemoryStore;
} {
  const store = new MemoryStore();
  const listener: NetworkListener = {
    requestIP: () => ({ address: "10.0.0.7" }),
    stop: () => undefined,
  };
  const manager = new NetworkManager({
    serve: () => listener,
    networkInterfaces: () => INTERFACES,
    passwordStore: passwordStore(hasPassword),
    store,
    handle: () => new Response("ok"),
  });
  return { manager, store };
}

function makeApp(manager?: NetworkManager): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    auth: { password: PASSWORD, port: 3000 },
    ...(manager === undefined ? {} : { network: manager }),
  });
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
      headers: { ...HOST, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function loginCookie(app: App): Promise<string> {
  const res = await request(app, "POST", "/api/auth/login", { password: PASSWORD });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("rute akses jaringan", () => {
  test("tanpa manajer rute menjawab 404", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    const res = await request(app, "GET", "/api/network", undefined, { cookie });
    expect(res.status).toBe(404);
  });

  test("butuh login", async () => {
    const { manager } = makeManager();
    const app = makeApp(manager);
    const res = await request(app, "GET", "/api/network");
    expect(res.status).toBe(401);
  });

  test("GET mengembalikan status", async () => {
    const { manager } = makeManager();
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    const res = await request(app, "GET", "/api/network", undefined, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      port: number;
      listening: boolean;
      urls: string[];
      passwordRequired: boolean;
    };
    expect(body.enabled).toBe(false);
    expect(body.port).toBe(4747);
    expect(body.listening).toBe(false);
    expect(body.passwordRequired).toBe(false);
  });

  test("PUT menyalakan akses dan mencatat audit", async () => {
    const { manager, store } = makeManager();
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/network",
      { enabled: true, port: 5000 },
      { cookie },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; port: number; listening: boolean };
    expect(body.enabled).toBe(true);
    expect(body.port).toBe(5000);
    expect(body.listening).toBe(true);
    expect(store.settings.enabled).toBe(true);
    const entries = audit.list({ kind: "pengaturan" });
    const aksi = entries.map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("jaringan-diaktifkan");
  });

  test("PUT mematikan akses dan mencatat audit", async () => {
    const { manager } = makeManager();
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/network", { enabled: true }, { cookie });
    const res = await request(app, "PUT", "/api/network", { enabled: false }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
    const aksi = audit.list({ kind: "pengaturan" }).map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("jaringan-dimatikan");
  });

  test("port tak sah dijawab 400", async () => {
    const { manager } = makeManager();
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    const res = await request(
      app,
      "PUT",
      "/api/network",
      { enabled: true, port: 80 },
      { cookie },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("1024");
  });

  test("tanpa sandi dijawab 409", async () => {
    const { manager } = makeManager(false);
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    const res = await request(app, "PUT", "/api/network", { enabled: true }, { cookie });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Buat sandi");
  });

  test("bind gagal dijawab 409 dengan pesan Indonesia", async () => {
    const store = new MemoryStore();
    const manager = new NetworkManager({
      serve: () => {
        const error = new Error("Address already in use");
        (error as { code?: string }).code = "EADDRINUSE";
        throw error;
      },
      networkInterfaces: () => INTERFACES,
      passwordStore: passwordStore(true),
      store,
      handle: () => new Response("ok"),
    });
    const app = makeApp(manager);
    const cookie = await loginCookie(app);
    const res = await request(app, "PUT", "/api/network", { enabled: true }, { cookie });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sudah dipakai");
    expect(store.settings.enabled).toBe(false);
  });
});

describe("hapus sandi mematikan akses jaringan", () => {
  test("sandi dihapus: listener ditutup dan enabled false", async () => {
    const { manager, store } = makeManager();
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      audit,
      auth: { password: PASSWORD, port: 3000 },
      network: manager,
      passwordStore: {
        has: () => true,
        load: (): PasswordRecord | undefined => ({
          version: 1,
          salt: "c2FsdA==",
          hash: "aGFzaA==",
          params: { N: 32768, r: 8, p: 1 },
          updatedAt: "2026-11-16T08:00:00.000Z",
        }),
        set: () => {
          throw new Error("tak dipakai");
        },
        clear: () => true,
        verify: () => true,
      },
    });
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/network", { enabled: true }, { cookie });
    const res = await request(
      app,
      "DELETE",
      "/api/auth/password",
      { current: PASSWORD },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(manager.status().enabled).toBe(false);
    expect(manager.status().listening).toBe(false);
    expect(store.settings.enabled).toBe(false);
    const aksi = audit.list({ kind: "pengaturan" }).map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("jaringan-dimatikan");
  });
});
