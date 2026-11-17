import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandEnvError,
  FileCommandEnvStore,
  MAX_ENV_BYTES,
  defaultCommandEnvStore,
  readCommandEnv,
} from "../src/server/security/command-env-store";

let root: string;
let project: string;
let storePath: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "jejak-command-env-")));
  project = join(root, "proyek");
  storePath = join(root, "home", "command-env.json");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".env"), "DB_HOST=localhost\nDB_PASSWORD=rahasia-panjang\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(): FileCommandEnvStore {
  return new FileCommandEnvStore(storePath);
}

describe("FileCommandEnvStore", () => {
  test("set, get, clear", () => {
    const s = store();
    const file = join(project, ".env");
    expect(s.get(project)).toBeUndefined();
    expect(s.set(project, file)).toBe(file);
    expect(s.get(project)).toBe(file);
    expect(s.clear(project)).toBe(true);
    expect(s.get(project)).toBeUndefined();
    expect(s.clear(project)).toBe(false);
  });

  test("bertahan setelah store dibuat ulang", () => {
    store().set(project, join(project, ".env"));
    expect(store().get(project)).toBe(join(project, ".env"));
  });

  test("berkas tersimpan bermode 0600", async () => {
    store().set(project, join(project, ".env"));
    const info = await stat(storePath);
    expect(info.mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(storePath, "utf8")) as { version: number };
    expect(body.version).toBe(1);
  });

  test("validasi jalur", async () => {
    const s = store();
    expect(() => s.set(project, ".env")).toThrow(CommandEnvError);
    expect(() => s.set(project, "")).toThrow(CommandEnvError);
    expect(() => s.set(project, join(root, "tidak-ada.env"))).toThrow(CommandEnvError);
    expect(() => s.set(project, project)).toThrow(CommandEnvError);
    await writeFile(join(root, "besar.env"), "A=" + "x".repeat(MAX_ENV_BYTES));
    expect(() => s.set(project, join(root, "besar.env"))).toThrow(CommandEnvError);
  });

  test("menerima jalur ~/", () => {
    const s = store();
    // `~` diperluas ke home nyata; berkas di home mungkin tak ada, jadi cukup
    // pastikan galatnya "tidak ditemukan", bukan "harus absolut".
    try {
      s.set(project, "~/jejak-tidak-ada.env");
      throw new Error("seharusnya melempar");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandEnvError);
      expect((error as Error).message).toContain("tidak ditemukan");
    }
  });

  test("defaultCommandEnvStore mati saat JEJAK_PERSIST=0", () => {
    expect(defaultCommandEnvStore({ JEJAK_PERSIST: "0" })).toBeUndefined();
    expect(defaultCommandEnvStore({ JEJAK_SECRET_BLOCK: "0" })).toBeUndefined();
    expect(defaultCommandEnvStore({ JEJAK_HOME: join(root, "home") })).toBeDefined();
  });
});

describe("readCommandEnv", () => {
  test("membaca kunci, export, komentar, dan tanda petik", async () => {
    const file = join(root, "contoh.env");
    await writeFile(
      file,
      [
        "# komentar",
        "DB_HOST=localhost",
        "export DB_PASSWORD='rahasia dengan spasi'",
        'API_TOKEN="token-panjang-123"',
        "PENDEK=abc",
        "KOSONG=",
        "ANGKA=12345",
        "DB_HOST=localhost",
      ].join("\n"),
    );
    const parsed = readCommandEnv(file);
    expect(parsed.keys).toEqual([
      "DB_HOST",
      "DB_PASSWORD",
      "API_TOKEN",
      "PENDEK",
      "KOSONG",
      "ANGKA",
    ]);
    expect(parsed.values).toEqual([
      "localhost",
      "rahasia dengan spasi",
      "token-panjang-123",
    ]);
    expect(parsed.env).toEqual({
      DB_HOST: "localhost",
      DB_PASSWORD: "rahasia dengan spasi",
      API_TOKEN: "token-panjang-123",
      PENDEK: "abc",
      ANGKA: "12345",
    });
  });

  test("kunci tak valid dibuang, nilai kosong dilewati", async () => {
    const file = join(root, "campur.env");
    await writeFile(
      file,
      ["1BAD=satu", "BAD KEY=dua", "OK=satu", "KOSONG=", "OK=lain"].join("\n"),
    );
    const parsed = readCommandEnv(file);
    expect(parsed.keys).toEqual(["OK", "KOSONG"]);
    expect(parsed.env).toEqual({ OK: "satu" });
  });

  test("galat baca dilempar", () => {
    expect(() => readCommandEnv(join(root, "tidak-ada.env"))).toThrow();
  });
});
