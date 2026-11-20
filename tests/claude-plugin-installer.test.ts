import { describe, expect, test } from "bun:test";
import {
  createPluginInstaller,
  parseMarketplaceSource,
  pluginEnv,
  type PluginSpawn,
  type PluginSpawnOptions,
} from "../src/server/claude-config/plugin-installer";

interface Catatan {
  cmd: string[];
  opts: PluginSpawnOptions;
}

function spawnPalsu(
  hasil: { code?: number; stdout?: string; stderr?: string } = {},
  catatan: Catatan[] = [],
): PluginSpawn {
  return async (cmd, opts) => {
    catatan.push({ cmd, opts });
    return {
      code: hasil.code ?? 0,
      stdout: hasil.stdout ?? "",
      stderr: hasil.stderr ?? "",
    };
  };
}

describe("pemasang plugin", () => {
  test("argumen persis array yang benar untuk install dan uninstall", async () => {
    const catatan: Catatan[] = [];
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({}, catatan),
    });

    const pasang = await installer.install("alpha@pasar");
    expect(pasang.ok).toBe(true);
    const copot = await installer.uninstall("alpha@pasar");
    expect(copot.ok).toBe(true);

    expect(catatan[0]?.cmd).toEqual([
      "/bin/claude",
      "plugin",
      "install",
      "alpha@pasar",
      "--scope",
      "user",
    ]);
    expect(catatan[1]?.cmd).toEqual([
      "/bin/claude",
      "plugin",
      "uninstall",
      "alpha@pasar",
      "--scope",
      "user",
    ]);
  });

  test("id buruk tak pernah memanggil spawn", async () => {
    const catatan: Catatan[] = [];
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({}, catatan),
    });
    for (const id of ["tanpa-pasar", "@pasar", "a b@pasar", "salah@pas@ar"]) {
      const hasil = await installer.install(id);
      expect(hasil.ok).toBe(false);
    }
    expect(catatan).toHaveLength(0);
  });

  test("tanpa CLI claude hasilnya gagal tanpa menjalankan apa pun", async () => {
    const catatan: Catatan[] = [];
    const installer = createPluginInstaller({
      locate: async () => null,
      spawn: spawnPalsu({}, catatan),
    });
    const hasil = await installer.install("alpha@pasar");
    expect(hasil.ok).toBe(false);
    expect(hasil.message).toContain("CLI claude tidak ditemukan");
    expect(catatan).toHaveLength(0);
  });

  test("kode keluar bukan nol Produksi pesan gagal", async () => {
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({ code: 1, stderr: "marketplace tidak ditemukan" }),
    });
    const hasil = await installer.install("alpha@pasar");
    expect(hasil.ok).toBe(false);
    expect(hasil.message).toContain("marketplace tidak ditemukan");
  });

  test("keluaran dipotong ke 2000 karakter", async () => {
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({ stdout: "y".repeat(5000) }),
    });
    const hasil = await installer.install("alpha@pasar");
    expect(hasil.ok).toBe(true);
    expect(hasil.message.length).toBe(2000);
  });

  test("karakter kontrol dibuang dari keluaran", async () => {
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({ stdout: "halo\u0007 dunia" }),
    });
    const hasil = await installer.install("alpha@pasar");
    expect(hasil.message).toBe("halo  dunia");
  });

  test("timeout: proses yang tak selesai dibatalkan", async () => {
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: async () => new Promise(() => {}),
      timeoutMs: 50,
    });
    const hasil = await installer.install("alpha@pasar");
    expect(hasil.ok).toBe(false);
    expect(hasil.message).toContain("batas waktu");
  });

  test("env anak tanpa kunci Jejak dan penyedia", async () => {
    const catatan: Catatan[] = [];
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: spawnPalsu({}, catatan),
      env: {
        PATH: "/usr/bin",
        JEJAK_HOME: "/jejak",
        JEJAK_API_KEY: "rahasia",
        ANTHROPIC_API_KEY: "rahasia",
        OPENAI_API_KEY: "rahasia",
        DEEPSEEK_API_KEY: "rahasia",
        DEEPSEEK_BASE_URL: "https://contoh.test",
        TOKEN_PUBLIK: "rahasia",
      },
    });
    await installer.install("alpha@pasar");
    const env = catatan[0]?.opts.env ?? {};
    expect(env.PATH).toBe("/usr/bin");
    for (const nama of [
      "JEJAK_HOME",
      "JEJAK_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "TOKEN_PUBLIK",
    ]) {
      expect(env[nama]).toBeUndefined();
    }
  });

  test("home pengguna dipakai sebagai HOME proses", () => {
    const env = pluginEnv({ PATH: "/usr/bin" }, "/rumah/pengguna");
    expect(env.HOME).toBe("/rumah/pengguna");
  });

  test("permintaan serentak ditolak", async () => {
    const installer = createPluginInstaller({
      locate: async () => ({ path: "/bin/claude" }),
      spawn: async () => new Promise(() => {}),
      timeoutMs: 50,
    });
    const pertama = installer.install("alpha@pasar");
    const kedua = await installer.install("beta@pasar");
    expect(kedua.ok).toBe(false);
    expect(kedua.message).toBe("Masih ada pemasangan lain berjalan.");
    void pertama;
  });
});

describe("pembacaan sumber marketplace", () => {
  test("bentuk URL GitHub dan owner/repo dinormalkan", () => {
    for (const [masukan, harapan] of [
      ["https://github.com/pemilik/repo", "https://github.com/pemilik/repo"],
      ["https://github.com/pemilik/repo.git", "https://github.com/pemilik/repo"],
      ["https://github.com/pemilik/repo/", "https://github.com/pemilik/repo"],
      ["pemilik/repo", "https://github.com/pemilik/repo"],
      ["Pemilik.1-x/repo_2.y", "https://github.com/Pemilik.1-x/repo_2.y"],
      [" a/b ".trim(), "https://github.com/a/b"],
    ] as Array<[string, string]>) {
      expect(parseMarketplaceSource(masukan)).toEqual({ ok: true, source: harapan });
    }
  });

  test("sumber buruk ditolak", () => {
    for (const masukan of [
      "",
      "a/b/c",
      "http://github.com/owner/repo",
      "https://github.com/owner",
      "https://github.com//repo",
      "ssh://git@github.com/owner/repo",
      "git@github.com:owner/repo",
      "file:///tmp/repo",
      "/tmp/owner/repo",
      "owner/",
      "/owner/repo",
      "-owner/repo",
      "owner/repo extra",
      "a\tb",
      "https://github.com/buruk panjang/repo",
      "https://github.com/own\rer/repo",
    ]) {
      expect(parseMarketplaceSource(masukan).ok).toBe(false);
    }
  });

  test("bukan string ditolak", () => {
    expect(parseMarketplaceSource("").ok).toBe(false);
  });
});
