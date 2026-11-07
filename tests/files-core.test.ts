import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory } from "../src/server/files/list";
import { FileError, normalizeRelative, resolveInside } from "../src/server/files/path";
import { readTextFile, trimIncompleteUtf8 } from "../src/server/files/read";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-files-core-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveInside", () => {
  test("menerima path relatif dan akar cwd", async () => {
    await writeFile(join(dir, "a.txt"), "isi");

    const root = await resolveInside(dir, "");
    expect(root.path).toBe("");
    expect(root.target).toBe(root.root);

    const file = await resolveInside(dir, "a.txt");
    expect(file.path).toBe("a.txt");
    expect(file.target.endsWith("a.txt")).toBe(true);
  });

  test("menolak path absolut, NUL, dan segmen ..", async () => {
    for (const rel of ["/etc/passwd", "C:\\Windows", "a\0b", "..", "../etc/passwd", "a/../../x"]) {
      let caught: unknown;
      try {
        await resolveInside(dir, rel);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FileError);
      expect((caught as FileError).code).toBe("tidak-valid");
    }
  });

  test("menolak tipe bukan string", async () => {
    let caught: unknown;
    try {
      await resolveInside(dir, undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
  });

  test("pesan galat tidak memuat path absolut", async () => {
    try {
      await resolveInside(dir, "../rahasiaku");
      throw new Error("seharusnya ditolak");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(dir);
      expect(message).toBe("path di luar folder kerja");
    }
  });

  test("symlink ke luar cwd ditolak (berkas dan direktori)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jejak-files-outside-"));
    try {
      await writeFile(join(outside, "rahasia.txt"), "rahasia");
      await mkdir(join(outside, "sub"));
      await writeFile(join(outside, "sub", "apa.txt"), "isi");
      await symlink(join(outside, "rahasia.txt"), join(dir, "file-link"));
      await symlink(join(outside, "sub"), join(dir, "dir-link"));

      for (const rel of ["file-link", "dir-link", "dir-link/apa.txt"]) {
        let caught: unknown;
        try {
          await resolveInside(dir, rel);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(FileError);
        expect((caught as FileError).code).toBe("tidak-valid");
        expect((caught as FileError).message).toBe("path di luar folder kerja");
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("symlink di dalam cwd tetap boleh", async () => {
    await mkdir(join(dir, "real"));
    await writeFile(join(dir, "real", "isi.txt"), "halo");
    await symlink(join(dir, "real"), join(dir, "tautan"));

    const resolved = await resolveInside(dir, "tautan/isi.txt");
    expect(resolved.path).toBe("tautan/isi.txt");
    expect(resolved.target.endsWith("isi.txt")).toBe(true);
  });

  test("cwd yang berupa symlink tetap berfungsi", async () => {
    await writeFile(join(dir, "a.txt"), "isi");
    const link = join(await mkdtemp(join(tmpdir(), "jejak-files-cwdlink-")), "kerja");
    await symlink(dir, link);
    try {
      const resolved = await resolveInside(link, "a.txt");
      expect(resolved.path).toBe("a.txt");
      const listing = await listDirectory(link, "");
      expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    } finally {
      await rm(join(link, ".."), { recursive: true, force: true });
    }
  });

  test("normalizeRelative menormalkan pemisah", () => {
    expect(normalizeRelative("a\\b")).toBe("a/b");
    expect(normalizeRelative("./a//b/")).toBe("a/b");
    expect(() => normalizeRelative("../a")).toThrow("path di luar folder kerja");
  });
});

describe("listDirectory", () => {
  test("urut direktori dulu lalu berkas, .git tersembunyi, dotfile tampil", async () => {
    await mkdir(join(dir, "zdir"));
    await mkdir(join(dir, "adir"));
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "b.txt"), "bb");
    await writeFile(join(dir, "A.txt"), "a");
    await writeFile(join(dir, ".env"), "X=1");

    const listing = await listDirectory(dir, "");
    expect(listing.path).toBe("");
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "adir",
      "node_modules",
      "zdir",
      ".env",
      "A.txt",
      "b.txt",
    ]);
    expect(listing.entries.filter((entry) => entry.type === "dir")).toHaveLength(3);
    expect(listing.entries.find((entry) => entry.name === "A.txt")?.size).toBe(1);
    expect(listing.entries.some((entry) => entry.name === ".git")).toBe(false);
  });

  test("symlink dilaporkan link tanpa size, termasuk tautan ke direktori", async () => {
    await mkdir(join(dir, "asli"));
    await writeFile(join(dir, "berkas.txt"), "x");
    await symlink(join(dir, "asli"), join(dir, "ke-dir"));
    await symlink(join(dir, "berkas.txt"), join(dir, "ke-berkas"));

    const listing = await listDirectory(dir, ".");
    const dirLink = listing.entries.find((entry) => entry.name === "ke-dir");
    const fileLink = listing.entries.find((entry) => entry.name === "ke-berkas");
    expect(dirLink).toEqual({ name: "ke-dir", type: "link" });
    expect(fileLink).toEqual({ name: "ke-berkas", type: "link" });
  });

  test("memotong pada 2000 entri", async () => {
    const names = Array.from({ length: 2001 }, (_, index) => `f${String(index).padStart(4, "0")}.txt`);
    await Promise.all(names.map((name) => writeFile(join(dir, name), "")));

    const listing = await listDirectory(dir, "");
    expect(listing.truncated).toBe(true);
    expect(listing.entries).toHaveLength(2000);
    expect(listing.entries[0]?.name).toBe("f0000.txt");
  });

  test("path ke berkas atau tidak ada menghasilkan galat yang tepat", async () => {
    await writeFile(join(dir, "berkas.txt"), "x");

    let toFile: unknown;
    try {
      await listDirectory(dir, "berkas.txt");
    } catch (error) {
      toFile = error;
    }
    expect(toFile).toBeInstanceOf(FileError);
    expect((toFile as FileError).code).toBe("tidak-valid");

    let missing: unknown;
    try {
      await listDirectory(dir, "tidak-ada");
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(FileError);
    expect((missing as FileError).code).toBe("tidak-ditemukan");
  });
});

describe("readTextFile", () => {
  test("membaca teks biasa dan UTF-8 multibyte", async () => {
    await writeFile(join(dir, "biasa.txt"), "halo dunia\n");
    const biasa = await readTextFile(dir, "biasa.txt");
    expect(biasa).toEqual({
      path: "biasa.txt",
      size: 11,
      binary: false,
      truncated: false,
      content: "halo dunia\n",
    });

    const multibyte = "héllo — 日本語 🎉\n";
    await writeFile(join(dir, "utf8.txt"), multibyte);
    const utf8 = await readTextFile(dir, "utf8.txt");
    expect(utf8.binary).toBe(false);
    expect(utf8.content).toBe(multibyte);
  });

  test("memotong berkas > 256 KiB tanpa memecah karakter UTF-8", async () => {
    const filler = "a".repeat(256 * 1024 - 1);
    const content = filler + "€tail";
    await writeFile(join(dir, "besar.txt"), content);

    const read = await readTextFile(dir, "besar.txt");
    expect(read.truncated).toBe(true);
    expect(read.binary).toBe(false);
    expect(read.size).toBe(Buffer.byteLength(content));
    expect(read.content?.length).toBe(256 * 1024 - 1);
    expect(read.content).not.toContain("\uFFFD");
  });

  test("trimIncompleteUtf8 menjaga karakter utuh", () => {
    const full = new TextEncoder().encode("aé");
    expect(trimIncompleteUtf8(full)).toEqual(full);
    const cut = full.subarray(0, full.length - 1);
    expect(trimIncompleteUtf8(cut)).toEqual(full.subarray(0, 1));
  });

  test("menandai biner bila ada NUL atau UTF-8 tidak valid", async () => {
    await writeFile(join(dir, "nul.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const nul = await readTextFile(dir, "nul.bin");
    expect(nul.binary).toBe(true);
    expect(nul.content).toBeUndefined();

    await writeFile(join(dir, "rusak.bin"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const rusak = await readTextFile(dir, "rusak.bin");
    expect(rusak.binary).toBe(true);
    expect(rusak.content).toBeUndefined();
  });

  test("direktori ditolak dan berkas tidak ada 404-setara", async () => {
    await mkdir(join(dir, "folder"));

    let directory: unknown;
    try {
      await readTextFile(dir, "folder");
    } catch (error) {
      directory = error;
    }
    expect(directory).toBeInstanceOf(FileError);
    expect((directory as FileError).code).toBe("tidak-valid");

    let missing: unknown;
    try {
      await readTextFile(dir, "hilang.txt");
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(FileError);
    expect((missing as FileError).code).toBe("tidak-ditemukan");
  });
});

describe("berkas khusus", () => {
  test("FIFO ditolak tanpa menggantung", async () => {
    const fifo = join(dir, "pipa");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return;

    let caught: unknown;
    try {
      await readTextFile(dir, "pipa");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
    expect((caught as FileError).code).toBe("tidak-valid");
  });

  test("berkas device ditolak lewat baca", async () => {
    let caught: unknown;
    try {
      await readTextFile(dir, "/dev/null");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
  });
});
