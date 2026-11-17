import { describe, expect, test } from "bun:test";
import type { PasswordRecord, PasswordStore } from "../src/server/auth/password-store";
import {
  defaultNetworkSettings,
  type NetworkSettings,
  type NetworkStore,
} from "../src/server/network/network-store";
import {
  MAX_TUNNEL_RESTARTS,
  TUNNEL_BACKOFF_MS,
  TunnelError,
  TunnelManager,
  redactToken,
  type TunnelProcess,
} from "../src/server/network/tunnel-manager";
import type { TunnelTokenStore } from "../src/server/network/token-store";

const TOKEN = "token-rahasia-uji-123";
const HOST = "jejak.contoh.com";

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

interface FakeProcess extends TunnelProcess {
  killed: number;
  emit(line: string): void;
  exit(code?: number): void;
}

interface Harness {
  manager: TunnelManager;
  store: MemoryStore;
  tokens: MemoryTokenStore;
  processes: FakeProcess[];
  spawns: Array<{ cmd: string[]; env: Record<string, string> }>;
  delays: number[];
  /** Selesaikan penundaan backoff yang tertunda. */
  flush(): Promise<void>;
}

function makeHarness(
  options: {
    hasPassword?: boolean;
    listening?: boolean;
    installed?: boolean;
    token?: string;
    publicHost?: string;
    tunnelEnabled?: boolean;
  } = {},
): Harness {
  const store = new MemoryStore();
  store.settings = {
    ...defaultNetworkSettings(),
    ...(options.publicHost === undefined ? {} : { publicHost: options.publicHost }),
    tunnelEnabled: options.tunnelEnabled ?? false,
  };
  const tokens = new MemoryTokenStore();
  if (options.token !== undefined) tokens.token = options.token;
  const processes: FakeProcess[] = [];
  const spawns: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  const delays: number[] = [];
  const pending: Array<() => void> = [];

  const manager = new TunnelManager({
    spawn: (cmd, env) => {
      spawns.push({ cmd, env });
      let resolveExit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const listeners: Array<(line: string) => void> = [];
      const proc: FakeProcess = {
        exited,
        killed: 0,
        onLine(listener) {
          listeners.push(listener);
        },
        emit(line) {
          for (const listener of listeners) listener(line);
        },
        exit(code = 0) {
          resolveExit(code);
        },
        kill() {
          proc.killed += 1;
        },
      };
      processes.push(proc);
      return proc;
    },
    which: () => (options.installed === false ? undefined : "/usr/local/bin/cloudflared"),
    store,
    tokenStore: tokens,
    passwordStore: passwordStore(options.hasPassword ?? true),
    network: { status: () => ({ listening: options.listening ?? true }) },
    delay: (ms) => {
      delays.push(ms);
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    },
  });

  return {
    manager,
    store,
    tokens,
    processes,
    spawns,
    delays,
    async flush() {
      const waiting = pending.splice(0);
      for (const resolve of waiting) resolve();
      // Beri kesempatan rantai `.then` berjalan.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("manajer tunnel: syarat enable", () => {
  async function codeOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
      return "tidak-melempar";
    } catch (error) {
      return error instanceof TunnelError ? error.code : "galat-lain";
    }
  }

  test("jaringan mati ditolak", async () => {
    const h = makeHarness({ listening: false, token: TOKEN, publicHost: HOST });
    expect(await codeOf(() => h.manager.enable())).toBe("jaringan-mati");
    expect(h.spawns).toHaveLength(0);
  });

  test("sandi kurang ditolak", async () => {
    const h = makeHarness({ hasPassword: false, token: TOKEN, publicHost: HOST });
    expect(await codeOf(() => h.manager.enable())).toBe("sandi-kurang");
  });

  test("token kurang ditolak", async () => {
    const h = makeHarness({ publicHost: HOST });
    expect(await codeOf(() => h.manager.enable())).toBe("token-kurang");
  });

  test("host kurang ditolak", async () => {
    const h = makeHarness({ token: TOKEN });
    expect(await codeOf(() => h.manager.enable())).toBe("host-kurang");
  });

  test("host tak sah ditolak", async () => {
    const h = makeHarness({ token: TOKEN });
    expect(await codeOf(() => h.manager.enable({ publicHost: "https://x.com" }))).toBe(
      "host-tak-sah",
    );
    expect(await codeOf(() => h.manager.enable({ publicHost: "localhost" }))).toBe(
      "host-tak-sah",
    );
  });

  test("cloudflared tak ada ditolak", async () => {
    const h = makeHarness({ installed: false, token: TOKEN, publicHost: HOST });
    expect(await codeOf(() => h.manager.enable())).toBe("cloudflared-tak-ada");
    expect(h.spawns).toHaveLength(0);
  });
});

describe("manajer tunnel: proses", () => {
  test("enable menjalankan cloudflared dengan token di env, bukan argv", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    const status = await h.manager.enable();
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.hasToken).toBe(true);
    expect(status.url).toBe(`https://${HOST}`);
    expect(h.spawns).toHaveLength(1);
    const spawn = h.spawns[0]!;
    expect(spawn.cmd).toEqual(["cloudflared", "tunnel", "--no-autoupdate", "run"]);
    expect(spawn.cmd.join(" ")).not.toContain(TOKEN);
    expect(spawn.env.TUNNEL_TOKEN).toBe(TOKEN);
    expect(h.store.settings.tunnelEnabled).toBe(true);
    expect(h.store.settings.publicHost).toBe(HOST);
  });

  test("token baru disimpan; token tersimpan dipakai bila tak dikirim", async () => {
    const h = makeHarness({ publicHost: HOST });
    await h.manager.enable({ token: TOKEN });
    expect(h.tokens.token).toBe(TOKEN);
    await h.manager.disable();
    await h.manager.enable();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.env.TUNNEL_TOKEN).toBe(TOKEN);
  });

  test("status tak pernah memuat token", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    const teks = JSON.stringify(h.manager.status());
    expect(teks).not.toContain(TOKEN);
    expect(teks).toContain('"hasToken":true');
  });

  test("lastLine di-redact dan dipotong 200 karakter", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    h.processes[0]!.emit(`koneksi memakai ${TOKEN} ok`);
    expect(h.manager.status().lastLine).toBe("koneksi memakai *** ok");
    h.processes[0]!.emit("x".repeat(500));
    expect(h.manager.status().lastLine?.length).toBe(200);
  });

  test("disable menghentikan proses dan menyimpan tunnelEnabled false", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    const status = await h.manager.disable();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(h.processes[0]!.killed).toBe(1);
    expect(h.store.settings.tunnelEnabled).toBe(false);
  });

  test("stop membunuh proses anak", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    await h.manager.stop();
    expect(h.processes[0]!.killed).toBe(1);
    expect(h.manager.status().running).toBe(false);
  });

  test("proses mati sendiri: nyala ulang dengan backoff 5s, 15s, 60s", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    for (let i = 0; i < MAX_TUNNEL_RESTARTS; i += 1) {
      h.processes[i]!.exit(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await h.flush();
    }
    expect(h.delays).toEqual([...TUNNEL_BACKOFF_MS]);
    expect(h.spawns).toHaveLength(1 + MAX_TUNNEL_RESTARTS);
  });

  test("berhenti setelah tiga percobaan ulang dan mencatat galat", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    for (let i = 0; i < MAX_TUNNEL_RESTARTS; i += 1) {
      h.processes[i]!.exit(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await h.flush();
    }
    // Proses keempat (percobaan ulang terakhir) juga mati: menyerah.
    h.processes[MAX_TUNNEL_RESTARTS]!.exit(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const status = h.manager.status();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.error).toContain("berhenti berulang");
    expect(h.store.settings.tunnelEnabled).toBe(false);
  });

  test("disable saat menunggu backoff membatalkan nyala ulang", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.enable();
    h.processes[0]!.exit(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await h.manager.disable();
    await h.flush();
    expect(h.spawns).toHaveLength(1);
  });

  test("start memulihkan tunnel bila diizinkan dan syarat lengkap", async () => {
    const h = makeHarness({
      token: TOKEN,
      publicHost: HOST,
      tunnelEnabled: true,
    });
    await h.manager.start();
    expect(h.manager.status().running).toBe(true);
    expect(h.spawns).toHaveLength(1);
  });

  test("start tanpa syarat tak melempar dan mencatat galat", async () => {
    const h = makeHarness({ publicHost: HOST, tunnelEnabled: true });
    await h.manager.start();
    expect(h.manager.status().running).toBe(false);
    expect(h.manager.status().error).toContain("Token");
  });

  test("start saat tunnel mati tak menjalankan proses", async () => {
    const h = makeHarness({ token: TOKEN, publicHost: HOST });
    await h.manager.start();
    expect(h.spawns).toHaveLength(0);
  });

  test("redactToken mengganti semua kemunculan", () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a *** b ***");
    expect(redactToken("tanpa token", undefined)).toBe("tanpa token");
  });
});

describe("manajer tunnel: env anak", () => {
  test("hanya meneruskan env minimal ditambah token", async () => {
    process.env.JEJAK_RAHASIA_UJI = "jangan-bocor";
    try {
      const h = makeHarness({ token: TOKEN, publicHost: HOST });
      await h.manager.enable();
      const env = h.spawns[0]!.env;
      expect(env.TUNNEL_TOKEN).toBe(TOKEN);
      expect(env.JEJAK_RAHASIA_UJI).toBeUndefined();
    } finally {
      delete process.env.JEJAK_RAHASIA_UJI;
    }
  });
});
