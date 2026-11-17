import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NETWORK_PORT,
  FileNetworkStore,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  defaultNetworkSettings,
  isValidNetworkPort,
  networkStorePath,
  parseNetworkSettings,
} from "../src/server/network/network-store";

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "jejak-network-store-"));
}

describe("penyimpanan pengaturan jaringan", () => {
  test("bawaan: akses mati dan port bawaan", async () => {
    const dir = await makeDir();
    try {
      const store = new FileNetworkStore(join(dir, "network.json"));
      expect(store.load()).toEqual({
        version: 1,
        enabled: false,
        port: DEFAULT_NETWORK_PORT,
        tunnelEnabled: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("simpan lalu baca kembali", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "network.json");
      const store = new FileNetworkStore(path);
      store.save({ version: 1, enabled: true, port: 5000, tunnelEnabled: false });
      expect(store.load()).toEqual({ version: 1, enabled: true, port: 5000, tunnelEnabled: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("berkas rusak dibaca sebagai bawaan", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "network.json");
      await writeFile(path, "{bukan json", "utf8");
      const store = new FileNetworkStore(path);
      expect(store.load()).toEqual(defaultNetworkSettings());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("port tak sah membuat berkas dianggap rusak", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "network.json");
      await writeFile(
        path,
        JSON.stringify({ version: 1, enabled: true, port: 80, tunnelEnabled: false }),
        "utf8",
      );
      const store = new FileNetworkStore(path);
      expect(store.load()).toEqual(defaultNetworkSettings());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("berkas ditulis dengan mode 0600", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "network.json");
      const store = new FileNetworkStore(path);
      store.save({ version: 1, enabled: true, port: DEFAULT_NETWORK_PORT, tunnelEnabled: false });
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validasi port: 1024-65535 sah, sisanya tidak", () => {
    expect(isValidNetworkPort(MIN_NETWORK_PORT)).toBe(true);
    expect(isValidNetworkPort(MAX_NETWORK_PORT)).toBe(true);
    expect(isValidNetworkPort(1023)).toBe(false);
    expect(isValidNetworkPort(65536)).toBe(false);
    expect(isValidNetworkPort(4747.5)).toBe(false);
    expect(isValidNetworkPort("4747")).toBe(false);
    expect(isValidNetworkPort(undefined)).toBe(false);
  });

  test("parse menerima bentuk sah dan menolak sisanya", () => {
    expect(
      parseNetworkSettings({ version: 1, enabled: false, port: 4747, tunnelEnabled: false }),
    ).toEqual({ version: 1, enabled: false, port: 4747, tunnelEnabled: false });
    expect(parseNetworkSettings({ version: 2, enabled: false, port: 4747 })).toBeUndefined();
    expect(parseNetworkSettings({ version: 1, enabled: "ya", port: 4747 })).toBeUndefined();
    expect(parseNetworkSettings({ version: 1, enabled: false, port: 70, tunnelEnabled: false })).toBeUndefined();
    expect(parseNetworkSettings([])).toBeUndefined();
  });

  test("jalur berkas berada di JEJAK_HOME", () => {
    const path = networkStorePath({ JEJAK_HOME: "/tmp/jejak-uji" });
    expect(path).toBe("/tmp/jejak-uji/network.json");
  });
});
