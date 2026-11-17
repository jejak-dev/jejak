import { describe, expect, test } from "bun:test";
import type { PasswordRecord, PasswordStore } from "../src/server/auth/password-store";
import {
  NetworkError,
  NetworkManager,
  type NetworkInterfaceEntry,
  type NetworkListener,
  type NetworkServe,
} from "../src/server/network/network-manager";
import {
  DEFAULT_NETWORK_PORT,
  defaultNetworkSettings,
  type NetworkSettings,
  type NetworkStore,
} from "../src/server/network/network-store";

/** Penyimpanan sandi tiruan: hanya `has()` yang dipakai manajer. */
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

/** Penyimpanan pengaturan di memori. */
class MemoryStore implements NetworkStore {
  settings: NetworkSettings = defaultNetworkSettings();

  load(): NetworkSettings {
    return { ...this.settings };
  }

  save(settings: NetworkSettings): void {
    this.settings = { ...settings };
  }
}

interface FakeServe {
  serve: NetworkServe;
  /** Opsi yang dipakai pada pemanggilan `serve` terakhir. */
  calls: Array<{ hostname: string; port: number }>;
  /** Berapa kali listener dibuat. */
  created: number;
  /** Berapa kali listener dihentikan. */
  stopped: number;
  /** Bila diisi, `serve` melempar galat ini. */
  failWith?: Error;
}

function fakeServe(): FakeServe {
  const state: FakeServe = {
    calls: [],
    created: 0,
    stopped: 0,
    serve: (options) => {
      state.calls.push({ hostname: options.hostname, port: options.port });
      if (state.failWith !== undefined) throw state.failWith;
      state.created += 1;
      const listener: NetworkListener = {
        requestIP: () => ({ address: "10.0.0.7" }),
        stop: () => {
          state.stopped += 1;
        },
      };
      return listener;
    },
  };
  return state;
}

const INTERFACES: NetworkInterfaceEntry[] = [
  { address: "127.0.0.1", family: "IPv4", internal: true },
  { address: "192.168.1.5", family: "IPv4", internal: false },
  { address: "fe80::1", family: "IPv6", internal: false },
  { address: "10.0.0.3", family: "IPv4", internal: false },
];

function makeManager(
  options: {
    hasPassword?: boolean;
    store?: MemoryStore;
    serve?: FakeServe;
    authActive?: boolean;
  } = {},
): { manager: NetworkManager; store: MemoryStore; serve: FakeServe } {
  const store = options.store ?? new MemoryStore();
  const serve = options.serve ?? fakeServe();
  const manager = new NetworkManager({
    serve: serve.serve,
    networkInterfaces: () => INTERFACES,
    passwordStore: passwordStore(options.hasPassword ?? true),
    store,
    handle: () => new Response("ok"),
    authActive: () => options.authActive ?? true,
  });
  return { manager, store, serve };
}

describe("manajer akses jaringan", () => {
  test("enable tanpa sandi ditolak", async () => {
    const { manager, store } = makeManager({ hasPassword: false });
    await expect(manager.enable(4747)).rejects.toBeInstanceOf(NetworkError);
    let pesan = "";
    try {
      await manager.enable(4747);
    } catch (error) {
      pesan = error instanceof Error ? error.message : "";
    }
    expect(pesan).toContain("Buat sandi");
    expect(store.settings.enabled).toBe(false);
    expect(manager.status().listening).toBe(false);
  });

  test("enable sukses menyimpan enabled dan menyalakan listener", async () => {
    const { manager, store, serve } = makeManager();
    const status = await manager.enable(4747);
    expect(status.enabled).toBe(true);
    expect(status.listening).toBe(true);
    expect(status.port).toBe(4747);
    expect(status.passwordRequired).toBe(false);
    expect(store.settings).toEqual({ version: 1, enabled: true, port: 4747, tunnelEnabled: false });
    expect(serve.calls[0]?.hostname).toBe("0.0.0.0");
    expect(serve.calls[0]?.port).toBe(4747);
  });

  test("port tak sah ditolak tanpa menyentuh listener", async () => {
    const { manager, serve } = makeManager();
    await expect(manager.enable(80)).rejects.toBeInstanceOf(NetworkError);
    expect(serve.created).toBe(0);
  });

  test("bind gagal tidak mengubah enabled dan memberi pesan Indonesia", async () => {
    const serve = fakeServe();
    const error = new Error("Address already in use");
    (error as { code?: string }).code = "EADDRINUSE";
    serve.failWith = error;
    const { manager, store } = makeManager({ serve });
    let pesan = "";
    try {
      await manager.enable(4747);
    } catch (caught) {
      pesan = caught instanceof Error ? caught.message : "";
    }
    expect(pesan).toContain("Port 4747 sudah dipakai proses lain.");
    expect(store.settings.enabled).toBe(false);
    expect(manager.status().enabled).toBe(false);
    expect(manager.status().listening).toBe(false);
    expect(manager.status().error).toContain("sudah dipakai");
  });

  test("disable menutup listener dan menyimpan enabled false", async () => {
    const { manager, store, serve } = makeManager();
    await manager.enable(4747);
    const status = await manager.disable();
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    expect(serve.stopped).toBe(1);
    expect(store.settings.enabled).toBe(false);
  });

  test("onPasswordCleared menutup listener dan mematikan akses", async () => {
    const { manager, store, serve } = makeManager();
    await manager.enable(4747);
    await manager.onPasswordCleared();
    expect(manager.status().enabled).toBe(false);
    expect(manager.status().listening).toBe(false);
    expect(serve.stopped).toBe(1);
    expect(store.settings.enabled).toBe(false);
  });

  test("start memulihkan listener saat akses diizinkan dan sandi ada", async () => {
    const store = new MemoryStore();
    store.settings = { version: 1, enabled: true, port: 5000, tunnelEnabled: false };
    const { manager, serve } = makeManager({ store });
    await manager.start();
    expect(manager.status().listening).toBe(true);
    expect(manager.status().port).toBe(5000);
    expect(serve.calls[0]?.port).toBe(5000);
  });

  test("start tanpa sandi tidak menyalakan listener dan menyimpan enabled false", async () => {
    const store = new MemoryStore();
    store.settings = { version: 1, enabled: true, port: 5000, tunnelEnabled: false };
    const { manager, serve } = makeManager({ store, hasPassword: false });
    await manager.start();
    expect(manager.status().listening).toBe(false);
    expect(serve.created).toBe(0);
    expect(store.settings.enabled).toBe(false);
  });

  test("start tanpa akses diizinkan tak membuka listener", async () => {
    const { manager, serve } = makeManager();
    await manager.start();
    expect(serve.created).toBe(0);
    expect(manager.status().listening).toBe(false);
  });

  test("start tak menjatuhkan server saat bind gagal", async () => {
    const store = new MemoryStore();
    store.settings = { version: 1, enabled: true, port: 5000, tunnelEnabled: false };
    const serve = fakeServe();
    const error = new Error("Address already in use");
    (error as { code?: string }).code = "EADDRINUSE";
    serve.failWith = error;
    const { manager } = makeManager({ store, serve });
    await manager.start();
    expect(manager.status().error).toContain("sudah dipakai");
    expect(manager.status().listening).toBe(false);
  });

  test("daftar URL hanya dari antarmuka IPv4 non-internal, urut stabil", async () => {
    const { manager } = makeManager();
    await manager.enable(4747);
    const status = manager.status();
    expect(status.urls).toEqual([
      "http://10.0.0.3:4747",
      "http://192.168.1.5:4747",
    ]);
  });

  test("status melaporkan passwordRequired saat sandi belum ada", async () => {
    const { manager } = makeManager({ hasPassword: false });
    expect(manager.status().passwordRequired).toBe(true);
    expect(manager.status().port).toBe(DEFAULT_NETWORK_PORT);
  });

  test("listener tak boleh hidup bila autentikasi belum aktif", async () => {
    const { manager, store, serve } = makeManager({ authActive: false });
    let pesan = "";
    try {
      await manager.enable(4747);
    } catch (error) {
      pesan = error instanceof Error ? error.message : "";
    }
    expect(pesan).toContain("Mulai ulang");
    expect(serve.created).toBe(0);
    expect(store.settings.enabled).toBe(false);
  });

  test("start tidak menyalakan listener bila autentikasi belum aktif", async () => {
    const store = new MemoryStore();
    store.settings = { version: 1, enabled: true, port: 5000, tunnelEnabled: false };
    const { manager, serve } = makeManager({ store, authActive: false });
    await manager.start();
    expect(serve.created).toBe(0);
    expect(manager.status().listening).toBe(false);
    expect(manager.status().error).toContain("Mulai ulang");
    // Pengaturan tak hilang: aktif lagi setelah server dimulai ulang.
    expect(store.settings.enabled).toBe(true);
  });
});
