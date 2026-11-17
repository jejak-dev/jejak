import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTunnelTokenStore,
  MAX_TUNNEL_TOKEN_LENGTH,
  TunnelTokenError,
  defaultTunnelTokenStore,
  isValidTunnelToken,
  tunnelTokenPath,
} from "../src/server/network/token-store";

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "jejak-tunnel-token-"));
}

describe("penyimpanan token tunnel", () => {
  test("belum ada token: has false dan get undefined", async () => {
    const dir = await makeDir();
    try {
      const store = new FileTunnelTokenStore(join(dir, "tunnel-token"));
      expect(store.has()).toBe(false);
      expect(store.get()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("simpan lalu baca kembali", async () => {
    const dir = await makeDir();
    try {
      const store = new FileTunnelTokenStore(join(dir, "tunnel-token"));
      store.set("token-uji-abc123");
      expect(store.has()).toBe(true);
      expect(store.get()).toBe("token-uji-abc123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("berkas ditulis dengan mode 0600", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "tunnel-token");
      const store = new FileTunnelTokenStore(path);
      store.set("token-uji-abc123");
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear menghapus token; kedua kali false", async () => {
    const dir = await makeDir();
    try {
      const store = new FileTunnelTokenStore(join(dir, "tunnel-token"));
      store.set("token-uji-abc123");
      expect(store.clear()).toBe(true);
      expect(store.has()).toBe(false);
      expect(store.clear()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("berkas kosong atau berisi spasi dianggap belum ada", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "tunnel-token");
      await writeFile(path, "   \n", "utf8");
      const store = new FileTunnelTokenStore(path);
      expect(store.has()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("token tak sah ditolak saat disimpan", async () => {
    const dir = await makeDir();
    try {
      const store = new FileTunnelTokenStore(join(dir, "tunnel-token"));
      expect(() => store.set("")).toThrow(TunnelTokenError);
      expect(() => store.set("ada spasi")).toThrow(TunnelTokenError);
      expect(() => store.set("ada\nbaris")).toThrow(TunnelTokenError);
      expect(() => store.set("x".repeat(MAX_TUNNEL_TOKEN_LENGTH + 1))).toThrow(
        TunnelTokenError,
      );
      expect(store.has()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validasi token", () => {
    expect(isValidTunnelToken("abc")).toBe(true);
    expect(isValidTunnelToken("a".repeat(MAX_TUNNEL_TOKEN_LENGTH))).toBe(true);
    expect(isValidTunnelToken("")).toBe(false);
    expect(isValidTunnelToken("a b")).toBe(false);
    expect(isValidTunnelToken("a\tb")).toBe(false);
    expect(isValidTunnelToken(undefined)).toBe(false);
    expect(isValidTunnelToken(42)).toBe(false);
  });

  test("jalur berkas berada di JEJAK_HOME", () => {
    expect(tunnelTokenPath({ JEJAK_HOME: "/tmp/jejak-uji" })).toBe(
      "/tmp/jejak-uji/tunnel-token",
    );
    const store = defaultTunnelTokenStore({ JEJAK_HOME: "/tmp/jejak-uji" });
    expect(store).toBeInstanceOf(FileTunnelTokenStore);
  });
});
