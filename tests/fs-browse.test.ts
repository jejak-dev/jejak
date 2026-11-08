import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirs, BrowseError } from "../src/server/files/browse";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-fs-browse-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectBrowseError(promise: Promise<unknown>, status: 400 | 404, message: string) {
  try {
    await promise;
    throw new Error("seharusnya melempar BrowseError");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowseError);
    expect((error as BrowseError).status).toBe(status);
    expect((error as BrowseError).message).toBe(message);
  }
}

describe("browseDirs", () => {
  test("path kosong memakai home, hanya folder, urut, tanpa dotfolder dan berkas", async () => {
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "Alpha"));
    await mkdir(join(root, ".rahasia"));
    await writeFile(join(root, "catatan.txt"), "isi");
    await writeFile(join(root, ".dotfile"), "isi");

    const result = await browseDirs(undefined, { home: root });
    expect(result.home).toBe(root);
    expect(result.path).toBe(await realpath(root));
    expect(result.entries.map((entry) => entry.name)).toEqual(["Alpha", "beta"]);
    expect(result.entries.every((entry) => !entry.name.includes("."))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("git true bila ada .git, path entri absolut", async () => {
    await mkdir(join(root, "repo"));
    await writeFile(join(root, "repo", ".git"), "gitdir: x");
    await mkdir(join(root, "biasa"));

    const result = await browseDirs(root);
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("repo")?.git).toBe(true);
    expect(byName.get("biasa")?.git).toBe(false);
    expect(byName.get("repo")?.path).toBe(join(await realpath(root), "repo"));
  });

  test("symlink ke folder tampil dengan realpath, symlink berkas dan rusak dilewati", async () => {
    const target = await mkdtemp(join(tmpdir(), "jejak-fs-browse-target-"));
    try {
      await mkdir(join(target, "tujuan"));
      await writeFile(join(target, "berkas.txt"), "x");
      await symlink(join(target, "tujuan"), join(root, "tampil"));
      await symlink(join(target, "berkas.txt"), join(root, "ke-berkas"));
      await symlink(join(target, "hilang"), join(root, "rusak"));

      const result = await browseDirs(root);
      expect(result.entries.map((entry) => entry.name)).toEqual(["tampil"]);
      expect(result.entries[0]?.path).toBe(await realpath(join(target, "tujuan")));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("parent benar dan null di akar", async () => {
    await mkdir(join(root, "dalam", "lagi"), { recursive: true });
    const sub = await browseDirs(join(root, "dalam", "lagi"));
    expect(sub.parent).toBe(await realpath(join(root, "dalam")));

    const rootResult = await browseDirs("/");
    expect(rootResult.parent).toBeNull();
  });

  test("limit memotong daftar dan menandai truncated", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await mkdir(join(root, name));
    }
    const result = await browseDirs(root, { limit: 3 });
    expect(result.entries.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    expect(result.truncated).toBe(true);
  });

  test("path tidak valid 400: relatif, NUL, bukan string", async () => {
    await expectBrowseError(browseDirs("relatif"), 400, "Path tidak valid.");
    await expectBrowseError(browseDirs("a\0b"), 400, "Path tidak valid.");
    await expectBrowseError(browseDirs(["a", "b"]), 400, "Path tidak valid.");
    await expectBrowseError(browseDirs(42), 400, "Path tidak valid.");
  });

  test("tidak ada 404 dan berkas 400", async () => {
    await expectBrowseError(browseDirs(join(root, "hilang")), 404, "Folder tidak ditemukan.");
    await writeFile(join(root, "berkas.txt"), "x");
    await expectBrowseError(browseDirs(join(root, "berkas.txt")), 400, "Bukan folder.");
  });
});