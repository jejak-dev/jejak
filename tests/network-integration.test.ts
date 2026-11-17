import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { FilePasswordStore } from "../src/server/auth/password-store";
import { NetworkManager } from "../src/server/network/network-manager";
import { mainFetch } from "../src/server/network/network-fetch";
import { defaultNetworkSettings, type NetworkStore } from "../src/server/network/network-store";

const PASSWORD = "sandi-uji-123";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-network-integration-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class MemoryStore implements NetworkStore {
  settings = defaultNetworkSettings();

  load() {
    return { ...this.settings };
  }

  save(settings: {
    version: number;
    enabled: boolean;
    port: number;
    publicHost?: string;
    tunnelEnabled: boolean;
  }): void {
    this.settings = { ...settings };
  }
}

interface Harness {
  app: ReturnType<typeof createApp>;
  manager: NetworkManager;
  /** Port nyata listener jaringan (acak, loopback). */
  port: number;
  /** Listener jaringan (untuk permintaan dengan Host buatan). */
  netServer: { fetch(request: Request): Response | Promise<Response> };
  /** Listener utama (loopback). */
  mainServer: { fetch(request: Request): Response | Promise<Response> };
  stop(): Promise<void>;
}

/**
 * Rangkaian nyata: aplikasi Jejak + listener jaringan sungguhan (port acak
 * di loopback) + listener utama. Hostname listener jaringan diinjeksi ke
 * loopback supaya tes tak membuka port ke jaringan sungguhan.
 */
async function makeHarness(): Promise<Harness> {
  const passwordStore = new FilePasswordStore(join(dir, "auth.json"));
  passwordStore.set(PASSWORD);

  // Aplikasi dan manajer saling butuh: aplikasi memakai manajer (rute dan
  // penjaga host), manajer memakai aplikasi (penangan permintaan).
  const holder: { app?: ReturnType<typeof createApp> } = {};

  let netServer: { port?: number; fetch(request: Request): Response | Promise<Response> } | undefined;
  const manager = new NetworkManager({
    serve: (options) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, srv) => options.fetch(request, srv),
      });
      netServer = server;
      return server;
    },
    networkInterfaces: () => [],
    passwordStore,
    store: new MemoryStore(),
    handle: (request) => holder.app?.handle(request) ?? new Response("belum siap", { status: 503 }),
  });

  const app = createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    auth: { password: PASSWORD, port: 3000 },
    passwordStore,
    network: manager,
  });
  holder.app = app;
  await manager.enable(4747);

  const mainServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      mainFetch((req) => app.handle(req), (req, srv) => srv?.requestIP?.(req)?.address)(
        request,
        server,
      ),
  });

  if (netServer === undefined) throw new Error("listener jaringan tak dibuat");
  const jaringan = netServer;

  return {
    app,
    manager,
    port: jaringan.port ?? 0,
    netServer: jaringan,
    mainServer,
    stop: async () => {
      await manager.stop();
      mainServer.stop(true);
    },
  };
}

describe("integrasi nyata listener jaringan", () => {
  test("login lewat listener jaringan berhasil dan body terkirim utuh", async () => {
    const harness = await makeHarness();
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie") ?? "").toContain("jejak_sid_");
    } finally {
      await harness.stop();
    }
  });

  test("sandi salah ditolak dan halaman statis tetap terbuka", async () => {
    const harness = await makeHarness();
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "salah-sekali" }),
      });
      expect(res.status).toBe(401);
      const halaman = await fetch(`http://127.0.0.1:${harness.port}/`);
      expect(halaman.status).toBe(200);
    } finally {
      await harness.stop();
    }
  });

  test("jalur desktop tak terjangkau dari listener jaringan", async () => {
    const harness = await makeHarness();
    try {
      const res = await fetch(
        `http://127.0.0.1:${harness.port}/__desktop/enter?t=token`,
      );
      expect(res.status).toBe(404);
    } finally {
      await harness.stop();
    }
  });

  test("host privat hanya boleh lewat jalur bertanda jaringan", async () => {
    const harness = await makeHarness();
    try {
      const viaJaringan = await harness.netServer.fetch(
        new Request("http://192.168.1.5:4747/api/health", {
          headers: { host: "192.168.1.5:4747" },
        }),
      );
      expect(viaJaringan.status).toBe(200);

      // Tanpa penanda jaringan (langsung ke aplikasi) host privat ditolak.
      const langsung = await harness.app.handle(
        new Request("http://192.168.1.5:4747/api/health", {
          headers: { host: "192.168.1.5:4747" },
        }),
      );
      expect(langsung.status).toBe(403);
    } finally {
      await harness.stop();
    }
  });

  test("listener utama membuang penanda jaringan dari klien", async () => {
    const harness = await makeHarness();
    try {
      // Klien memalsukan penanda pada listener utama: header dibuang sehingga
      // host privat tetap ditolak.
      const palsu = await harness.mainServer.fetch(
        new Request("http://192.168.1.5:4747/api/health", {
          headers: { host: "192.168.1.5:4747", "x-jejak-via": "net" },
        }),
      );
      expect(palsu.status).toBe(403);
    } finally {
      await harness.stop();
    }
  });
});
