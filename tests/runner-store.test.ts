import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRunnerStore,
  hashCommand,
  hasControlChar,
  newCustomId,
  runnerPath,
} from "../src/server/runner/runner-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-runner-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("store runner", () => {
  test("folder tak dikenal dibaca kosong", () => {
    const store = new FileRunnerStore(join(dir, "runner.json"));
    expect(store.read("/proyek/uji")).toEqual({ custom: [], confirmed: {} });
  });

  test("isi folder tersimpan dan dibaca ulang oleh instance lain", async () => {
    const path = join(dir, "runner.json");
    const store = new FileRunnerStore(path);
    store.write("/proyek/uji", {
      custom: [{ id: "c_12345678", label: "Uji", command: "bun test" }],
      confirmed: { c_12345678: "a".repeat(64) },
    });

    const lain = new FileRunnerStore(path);
    const folder = lain.read("/proyek/uji");
    expect(folder.custom).toEqual([
      { id: "c_12345678", label: "Uji", command: "bun test" },
    ]);
    expect(folder.confirmed["c_12345678"]).toBe("a".repeat(64));

    const isi = await readFile(path, "utf8");
    expect(JSON.parse(isi)).toEqual({
      folders: {
        "/proyek/uji": {
          custom: [{ id: "c_12345678", label: "Uji", command: "bun test" }],
          confirmed: { c_12345678: "a".repeat(64) },
        },
      },
    });
  });

  test("berkas rusak dipulihkan kosong tanpa melempar", async () => {
    const path = join(dir, "runner.json");
    await writeFile(path, "{bukan json", "utf8");
    const store = new FileRunnerStore(path);
    expect(store.read("/proyek/uji")).toEqual({ custom: [], confirmed: {} });
    // Simpan berikutnya menulis ulang berkas yang rusak.
    store.write("/proyek/uji", {
      custom: [{ id: "c_aaaaaaaa", label: "Uji", command: "bun test" }],
      confirmed: {},
    });
    const isi = await readFile(path, "utf8");
    expect(JSON.parse(isi).folders["/proyek/uji"].custom).toHaveLength(1);
  });

  test("berkas tak ada tidak melempar", () => {
    const store = new FileRunnerStore(join(dir, "tidak-ada.json"));
    expect(store.read("/proyek/uji").custom).toEqual([]);
  });

  test("entri rusak dibuang saat dibaca", async () => {
    const path = join(dir, "runner.json");
    await writeFile(
      path,
      JSON.stringify({
        folders: {
          "/proyek/uji": {
            custom: [
              { id: "c_1", label: "Uji", command: "bun test" },
              { id: "", label: "Tanpa id", command: "bun test" },
              { label: "Tanpa id", command: "bun test" },
            ],
            confirmed: { c_1: "bukan-hash" },
          },
        },
      }),
      "utf8",
    );
    const folder = new FileRunnerStore(path).read("/proyek/uji");
    expect(folder.custom).toHaveLength(1);
    expect(folder.confirmed).toEqual({});
  });

  test("lokasi berkas mengikuti JEJAK_HOME", () => {
    expect(runnerPath({ JEJAK_HOME: "/tmp/jejak-uji" })).toBe("/tmp/jejak-uji/runner.json");
  });
});

describe("bantu runner", () => {
  test("hash perintah adalah SHA-256 hex yang stabil", () => {
    const hash = hashCommand("bun test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCommand("bun test")).toBe(hash);
    expect(hashCommand("bun test --watch")).not.toBe(hash);
  });

  test("id kustom acak dengan awalan c_", () => {
    const id = newCustomId();
    expect(id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(newCustomId()).not.toBe(id);
  });

  test("karakter kontrol dikenali", () => {
    expect(hasControlChar("bun test")).toBe(false);
    expect(hasControlChar("bun\ntest")).toBe(true);
    expect(hasControlChar("bun\ttest")).toBe(true);
  });
});
