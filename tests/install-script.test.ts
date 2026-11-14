/**
 * Tes untuk `install.sh` (pemasang Jejak untuk macOS).
 *
 * Tes hanya berjalan di macOS karena skrip memakai `osascript`, `xattr`, dan
 * `uname`. Bundle Jejak dan manifest `latest.json` dibuat palsu di folder
 * sementara; `JEJAK_INSTALL_TEST=1` mengizinkan URL `file://`.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKRIP = join(import.meta.dir, "..", "install.sh");

interface Hasil {
  kode: number;
  keluar: string;
  galat: string;
}

/** Jalankan `sh install.sh` dengan lingkungan uji. */
async function jalankan(
  argumen: string[],
  env: Record<string, string>,
): Promise<Hasil> {
  const proses = Bun.spawn(["sh", SKRIP, ...argumen], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [keluar, galat] = await Promise.all([
    new Response(proses.stdout).text(),
    new Response(proses.stderr).text(),
  ]);
  const kode = await proses.exited;
  return { kode, keluar, galat };
}

/** Buat bundle Jejak palsu lalu arkipkan jadi `.app.tar.gz`. */
async function buatArsip(
  folder: string,
  isiBerkas: string,
  namaArsip = "jejak.app.tar.gz",
): Promise<string> {
  const panggung = join(folder, "panggung");
  const isiBundle = join(panggung, "Jejak.app", "Contents", "MacOS");
  await mkdir(isiBundle, { recursive: true });
  await writeFile(join(isiBundle, "jejak"), isiBerkas, "utf8");
  const arsip = join(folder, namaArsip);
  const proses = Bun.spawn(["tar", "-czf", arsip, "-C", panggung, "Jejak.app"]);
  expect(await proses.exited).toBe(0);
  return arsip;
}

/** Tulis manifest `latest.json` palsu; kunci platform bisa `-app` atau polos. */
async function buatManifest(
  folder: string,
  urlArsip: string,
  versi = "9.9.9",
  kunciPlatform = "darwin-aarch64-app",
): Promise<string> {
  const manifest = join(folder, "latest.json");
  const isi = {
    version: versi,
    platforms: {
      [kunciPlatform]: { signature: "pretend", url: urlArsip },
    },
  };
  await writeFile(manifest, JSON.stringify(isi), "utf8");
  return manifest;
}

/** Siapkan folder uji: HOME dan folder tujuan terpisah. */
async function siapFolder(): Promise<{
  akar: string;
  home: string;
  tujuan: string;
}> {
  const akar = await mkdtemp(join(tmpdir(), "jejak-install-"));
  const home = join(akar, "home");
  const tujuan = join(akar, "Applications");
  await mkdir(home, { recursive: true });
  await mkdir(tujuan, { recursive: true });
  return { akar, home, tujuan };
}

describe.skipIf(process.platform !== "darwin")("install.sh", () => {
  test("sintaks POSIX sh valid", async () => {
    const proses = Bun.spawn(["sh", "-n", SKRIP]);
    expect(await proses.exited).toBe(0);
  });

  test("memasang Jejak.app dan tak menyentuh ~/.jejak", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const arsip = await buatArsip(akar, "#!/bin/sh\necho stub\n");
      const manifest = await buatManifest(akar, `file://${arsip}`);
      const hasil = await jalankan([], {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      });
      expect(hasil.kode).toBe(0);
      expect(hasil.keluar).toContain("9.9.9");
      expect(hasil.keluar).toContain(tujuan);
      expect(hasil.keluar).toContain(".jejak");

      const biner = join(tujuan, "Jejak.app", "Contents", "MacOS", "jejak");
      expect(await Bun.file(biner).exists()).toBe(true);
      // Data Jejak tak boleh dibuat atau diubah oleh pemasang.
      expect(await Bun.file(join(home, ".jejak")).exists()).toBe(false);
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("pemasangan ulang mengganti versi lama", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const arsipLama = await buatArsip(akar, "versi-lama\n");
      const manifest = await buatManifest(akar, `file://${arsipLama}`);
      const env = {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      };
      expect((await jalankan([], env)).kode).toBe(0);

      const biner = join(tujuan, "Jejak.app", "Contents", "MacOS", "jejak");
      expect(await readFile(biner, "utf8")).toBe("versi-lama\n");

      const arsipBaru = await buatArsip(akar, "versi-baru\n", "jejak-baru.app.tar.gz");
      const manifestBaru = await buatManifest(akar, `file://${arsipBaru}`);
      const hasil = await jalankan([], {
        ...env,
        JEJAK_LATEST_JSON_URL: `file://${manifestBaru}`,
      });
      expect(hasil.kode).toBe(0);
      expect(await readFile(biner, "utf8")).toBe("versi-baru\n");
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("kunci platform polos dipakai bila kunci -app tak ada", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const arsip = await buatArsip(akar, "polos\n");
      const manifest = await buatManifest(
        akar,
        `file://${arsip}`,
        "1.2.3",
        "darwin-aarch64",
      );
      const hasil = await jalankan([], {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      });
      expect(hasil.kode).toBe(0);
      expect(hasil.keluar).toContain("1.2.3");
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("URL http ditolak", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const manifest = await buatManifest(akar, "http://example.com/jejak.app.tar.gz");
      const hasil = await jalankan([], {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      });
      expect(hasil.kode).not.toBe(0);
      expect(hasil.galat).toContain("https://");
      expect(
        await Bun.file(join(tujuan, "Jejak.app", "Contents", "MacOS", "jejak")).exists(),
      ).toBe(false);
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("manifest http ditolak", async () => {
    const { home, tujuan } = await siapFolder();
    const hasil = await jalankan([], {
      HOME: home,
      JEJAK_LATEST_JSON_URL: "http://example.com/latest.json",
      JEJAK_INSTALL_DIR: tujuan,
    });
    expect(hasil.kode).not.toBe(0);
    expect(hasil.galat).toContain("https://");
  });

  test("--uninstall menghapus aplikasi dan menyisakan data", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const arsip = await buatArsip(akar, "stub\n");
      const manifest = await buatManifest(akar, `file://${arsip}`);
      const env = {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      };
      expect((await jalankan([], env)).kode).toBe(0);
      await mkdir(join(home, ".jejak"), { recursive: true });
      await writeFile(join(home, ".jejak", "data.json"), "{}", "utf8");

      const hasil = await jalankan(["--uninstall"], env);
      expect(hasil.kode).toBe(0);
      expect(await Bun.file(join(tujuan, "Jejak.app")).exists()).toBe(false);
      // Data Jejak tak boleh ikut terhapus.
      expect(await Bun.file(join(home, ".jejak", "data.json")).exists()).toBe(true);
      expect(hasil.keluar).toContain("tidak dihapus");
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("--purge-data tanpa konfirmasi terminal tak menghapus data", async () => {
    const { akar, home, tujuan } = await siapFolder();
    try {
      const arsip = await buatArsip(akar, "stub\n");
      const manifest = await buatManifest(akar, `file://${arsip}`);
      const env = {
        HOME: home,
        JEJAK_INSTALL_TEST: "1",
        JEJAK_LATEST_JSON_URL: `file://${manifest}`,
        JEJAK_INSTALL_DIR: tujuan,
      };
      expect((await jalankan([], env)).kode).toBe(0);
      await mkdir(join(home, ".jejak"), { recursive: true });
      await writeFile(join(home, ".jejak", "data.json"), "{}", "utf8");

      const hasil = await jalankan(["--uninstall", "--purge-data"], env);
      expect(hasil.kode).not.toBe(0);
      expect(await Bun.file(join(home, ".jejak", "data.json")).exists()).toBe(true);
    } finally {
      await rm(akar, { recursive: true, force: true });
    }
  });

  test("--help menampilkan pemakaian", async () => {
    const hasil = await jalankan(["--help"], { HOME: tmpdir() });
    expect(hasil.kode).toBe(0);
    expect(hasil.keluar).toContain("--uninstall");
    expect(hasil.keluar).toContain("JEJAK_INSTALL_DIR");
  });

  test("argumen tak dikenal ditolak", async () => {
    const hasil = await jalankan(["--entah"], { HOME: tmpdir() });
    expect(hasil.kode).toBe(2);
  });
});
