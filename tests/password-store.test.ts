import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePasswordStore,
  MAX_PASSWORD_LENGTH,
  PasswordStoreError,
  authStorePath,
  createStoreVerifier,
  defaultPasswordStore,
  isStoreVerifier,
} from "../src/server/auth/password-store";
import { MIN_PASSWORD_LENGTH } from "../src/server/auth/password";

const SANDI = "sandi-uji-123";

let dir: string;
let file: string;
let store: FilePasswordStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-password-store-"));
  file = join(dir, "auth.json");
  store = new FilePasswordStore(file);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("penyimpanan sandi", () => {
  test("sandi disimpan lalu diverifikasi", () => {
    expect(store.has()).toBe(false);
    expect(store.load()).toBeUndefined();

    const record = store.set(SANDI);
    expect(record.version).toBe(1);
    expect(record.params).toEqual({ N: 32768, r: 8, p: 1 });
    expect(record.updatedAt).not.toBe("");

    expect(store.has()).toBe(true);
    expect(store.verify(SANDI)).toBe(true);
    expect(store.verify("sandi-salah")).toBe(false);
    expect(store.verify("")).toBe(false);
  });

  test("isi berkas tidak memuat sandi polos", async () => {
    store.set(SANDI);
    const isi = await readFile(file, "utf8");
    expect(isi).not.toContain(SANDI);
    const parsed = JSON.parse(isi) as Record<string, unknown>;
    expect(typeof parsed.salt).toBe("string");
    expect(typeof parsed.hash).toBe("string");
    expect(parsed.version).toBe(1);
  });

  test("berkas ditulis dengan izin 0600 dan tak ada berkas sementara tertinggal", async () => {
    store.set(SANDI);
    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
    const isi = await readdir(dir);
    expect(isi).toEqual(["auth.json"]);
  });

  test("ganti sandi menimpa yang lama", () => {
    store.set(SANDI);
    store.set("sandi-baru-456");
    expect(store.verify(SANDI)).toBe(false);
    expect(store.verify("sandi-baru-456")).toBe(true);
  });

  test("hapus sandi mengosongkan penyimpanan", () => {
    store.set(SANDI);
    expect(store.clear()).toBe(true);
    expect(store.has()).toBe(false);
    expect(store.verify(SANDI)).toBe(false);
    // Menghapus lagi tak melempar; hanya melaporkan tak ada yang dihapus.
    expect(store.clear()).toBe(false);
  });

  test("berkas rusak dianggap belum ada sandi dan tak melempar", async () => {
    await writeFile(file, "{bukan json", "utf8");
    expect(store.has()).toBe(false);
    expect(store.load()).toBeUndefined();
    expect(store.verify(SANDI)).toBe(false);

    // Menyetel sandi baru menimpa berkas rusak.
    store.set(SANDI);
    expect(store.verify(SANDI)).toBe(true);
  });

  test("versi tak dikenal dianggap belum ada sandi", async () => {
    await writeFile(file, JSON.stringify({ version: 99, salt: "x", hash: "y" }), "utf8");
    expect(store.has()).toBe(false);
  });

  test("hash dengan panjang salah dianggap belum ada sandi", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        salt: Buffer.alloc(16).toString("base64"),
        hash: Buffer.alloc(8).toString("base64"),
        params: { N: 32768, r: 8, p: 1 },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    expect(store.has()).toBe(false);
    expect(store.verify(SANDI)).toBe(false);
  });

  test("sandi terlalu pendek atau terlalu panjang ditolak", () => {
    expect(() => store.set("")).toThrow(PasswordStoreError);
    expect(() => store.set("a".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(PasswordStoreError);
    expect(() => store.set("a".repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(PasswordStoreError);
    // Panjang batas masih diterima.
    store.set("a".repeat(MAX_PASSWORD_LENGTH));
    expect(store.verify("a".repeat(MAX_PASSWORD_LENGTH))).toBe(true);
  });

  test("path mengikuti JEJAK_HOME", () => {
    expect(authStorePath({ JEJAK_HOME: "/tmp/jejak-uji" })).toBe("/tmp/jejak-uji/auth.json");
    expect(defaultPasswordStore({ JEJAK_HOME: "/tmp/jejak-uji" })).toBeInstanceOf(
      FilePasswordStore,
    );
  });

  test("verifier penyimpanan ditandai dan memverifikasi sandi", () => {
    store.set(SANDI);
    const verifier = createStoreVerifier(store);
    expect(isStoreVerifier(verifier)).toBe(true);
    expect(verifier.verify(SANDI)).toBe(true);
    expect(verifier.verify("sandi-salah")).toBe(false);
  });
});
