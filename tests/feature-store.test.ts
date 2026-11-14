import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileFeatureStore,
  defaultFeatureSettings,
  featureSettingsPath,
  parseFeatureSettings,
  resolveFeature,
} from "../src/server/features/feature-store";

let dir: string;

async function tempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "jejak-features-"));
  return dir;
}

describe("penyimpanan fitur", () => {
  test("default: terminal dan browser mati", async () => {
    const home = await tempDir();
    const store = new FileFeatureStore(join(home, "features.json"));
    expect(store.get()).toEqual({ terminal: false, browser: false });
    expect(defaultFeatureSettings()).toEqual({ terminal: false, browser: false });
    await rm(home, { recursive: true, force: true });
  });

  test("berkas tak ada dibaca sebagai default", async () => {
    const home = await tempDir();
    const store = new FileFeatureStore(join(home, "features.json"));
    expect(store.get()).toEqual({ terminal: false, browser: false });
    await rm(home, { recursive: true, force: true });
  });

  test("berkas rusak dibaca sebagai default", async () => {
    const home = await tempDir();
    const path = join(home, "features.json");
    await writeFile(path, "{ ini bukan json");
    expect(new FileFeatureStore(path).get()).toEqual({ terminal: false, browser: false });
    await rm(home, { recursive: true, force: true });
  });

  test("berkas dengan kunci asing atau nilai salah dibaca sebagai default", async () => {
    const home = await tempDir();
    const asing = join(home, "asing.json");
    await writeFile(asing, JSON.stringify({ terminal: true, sandbox: true }));
    expect(new FileFeatureStore(asing).get()).toEqual({ terminal: false, browser: false });
    const salah = join(home, "salah.json");
    await writeFile(salah, JSON.stringify({ terminal: "ya" }));
    expect(new FileFeatureStore(salah).get()).toEqual({ terminal: false, browser: false });
    await rm(home, { recursive: true, force: true });
  });

  test("validasi ketat: kunci asing dan nilai bukan boolean ditolak", () => {
    expect(() => parseFeatureSettings({ terminal: true, browser: false })).not.toThrow();
    expect(() => parseFeatureSettings({ terminal: "true" })).toThrow(/boolean/);
    expect(() => parseFeatureSettings({ terminal: true, vault: true })).toThrow(/tidak dikenal/);
    expect(() => parseFeatureSettings([1, 2])).toThrow();
    expect(() => parseFeatureSettings(null)).toThrow();
  });

  test("penulisan ditolak bila nilai bukan boolean atau kunci asing", async () => {
    const home = await tempDir();
    const store = new FileFeatureStore(join(home, "features.json"));
    expect(() => store.set({ terminal: "ya" as unknown as boolean })).toThrow(/boolean/);
    expect(() =>
      store.set({ vault: true } as unknown as Partial<{ terminal: boolean }>),
    ).toThrow(/tidak dikenal/);
    expect(store.get()).toEqual({ terminal: false, browser: false });
    await rm(home, { recursive: true, force: true });
  });

  test("tulis atomik: berkas berisi dua fitur, izin 0600, tanpa berkas sisa", async () => {
    const home = await tempDir();
    const path = join(home, "features.json");
    const store = new FileFeatureStore(path);
    store.set({ terminal: true });
    const isi = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(isi).toEqual({ terminal: true, browser: false });
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    const isiDir = await readdir(home);
    expect(isiDir.filter((nama) => nama.endsWith(".tmp"))).toEqual([]);
    // Nilai lama ditimpa, bukan digabung.
    store.set({ browser: true });
    const isi2 = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(isi2).toEqual({ terminal: true, browser: true });
    await rm(home, { recursive: true, force: true });
  });

  test("berkas features.json ada di JEJAK_HOME", () => {
    const path = featureSettingsPath({ JEJAK_HOME: "/tmp/jejak-uji" });
    expect(path).toBe("/tmp/jejak-uji/features.json");
  });
});

describe("resolveFeature", () => {
  const stored = { terminal: true, browser: false };

  test("env kosong memakai nilai tersimpan dan tidak mengunci", () => {
    expect(resolveFeature("terminal", {}, stored)).toEqual({ enabled: true, locked: false });
    expect(resolveFeature("browser", {}, stored)).toEqual({ enabled: false, locked: false });
  });

  test("env 1 memaksa menyala dan mengunci", () => {
    expect(resolveFeature("terminal", { JEJAK_TERMINAL: "1" }, stored)).toEqual({
      enabled: true,
      locked: true,
    });
    expect(resolveFeature("browser", { JEJAK_BROWSER: "1" }, stored)).toEqual({
      enabled: true,
      locked: true,
    });
  });

  test("env 0 memaksa mati dan mengunci", () => {
    expect(resolveFeature("terminal", { JEJAK_TERMINAL: "0" }, stored)).toEqual({
      enabled: false,
      locked: true,
    });
    expect(resolveFeature("browser", { JEJAK_BROWSER: "0" }, stored)).toEqual({
      enabled: false,
      locked: true,
    });
  });

  test("env lain (mis. 2) tidak mengunci dan memakai nilai tersimpan", () => {
    expect(resolveFeature("terminal", { JEJAK_TERMINAL: "2" }, stored)).toEqual({
      enabled: true,
      locked: false,
    });
    expect(resolveFeature("terminal", { JEJAK_TERMINAL: " " }, stored)).toEqual({
      enabled: true,
      locked: false,
    });
  });

  test("env fitur lain tidak memengaruhi fitur ini", () => {
    expect(resolveFeature("browser", { JEJAK_TERMINAL: "1" }, stored)).toEqual({
      enabled: false,
      locked: false,
    });
  });
});
