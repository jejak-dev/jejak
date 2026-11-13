import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TarballError,
  computeIntegrity,
  extractTarball,
  parseTarEntries,
  validateEntries,
  verifyIntegrity,
} from "../src/server/sdk/tarball";
import {
  buildTar,
  gzipOf,
  packageEntries,
  packageJsonContent,
  paxRecord,
  type TarInput,
} from "./helpers/tar-builder";

const NAMA = "@anthropic-ai/claude-agent-sdk";
const VERSI = "1.2.3";
const EXPECTED = { name: NAMA, version: VERSI };

let dir: string;
let dest: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-tarball-"));
  dest = join(dir, "hasil");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function grabError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(TarballError);
  return (error as TarballError).code;
}

async function extract(
  entries: TarInput[],
  limits?: Parameters<typeof extractTarball>[3],
): Promise<{ error: unknown }> {
  const gz = gzipOf(buildTar(entries));
  const error = await grabError(() => extractTarball(gz, dest, EXPECTED, limits));
  return { error };
}

describe("verifyIntegrity", () => {
  test("menerima SRI sha512 yang cocok", () => {
    const bytes = new TextEncoder().encode("isi tarball");
    const sri = computeIntegrity(bytes);

    expect(sri.startsWith("sha512-")).toBe(true);
    expect(verifyIntegrity(bytes, sri)).toBe(true);
  });

  test("menolak SRI yang tidak cocok", () => {
    const bytes = new TextEncoder().encode("isi tarball");
    const lain = computeIntegrity(new TextEncoder().encode("isi lain"));

    expect(verifyIntegrity(bytes, lain)).toBe(false);
  });

  test("menolak format SRI yang rusak", () => {
    const bytes = new TextEncoder().encode("isi tarball");

    expect(verifyIntegrity(bytes, "")).toBe(false);
    expect(verifyIntegrity(bytes, "sha512")).toBe(false);
    expect(verifyIntegrity(bytes, "sha512-")).toBe(false);
    expect(verifyIntegrity(bytes, "bukan-sri")).toBe(false);
    expect(verifyIntegrity(bytes, "sha512-@@@")).toBe(false);
    expect(verifyIntegrity(bytes, "sha512-YWJj")).toBe(false);
  });

  test("hanya sha512 yang diterima", () => {
    const bytes = new TextEncoder().encode("isi tarball");
    const sha384 = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

    expect(verifyIntegrity(bytes, sha384)).toBe(false);
  });

  test("menerima beberapa token dipisah spasi", () => {
    const bytes = new TextEncoder().encode("isi tarball");
    const sri = computeIntegrity(bytes);

    expect(verifyIntegrity(bytes, `sha384-abc ${sri}`)).toBe(true);
    expect(verifyIntegrity(bytes, `${sri} sha384-abc`)).toBe(true);
    expect(verifyIntegrity(bytes, "sha384-abc sha384-def")).toBe(false);
  });
});

describe("parseTarEntries", () => {
  test("membaca berkas dan direktori", () => {
    const entries = parseTarEntries(buildTar(packageEntries(NAMA, VERSI)));

    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain("package/package.json");
    expect(paths).toContain("package/sdk.mjs");
    const json = entries.find((entry) => entry.path === "package/package.json");
    expect(json?.type).toBe("file");
    expect(json?.data).toBeDefined();
    expect(json?.size).toBeGreaterThan(0);
  });

  test("menolak arsip terpotong", () => {
    const tar = buildTar(packageEntries(NAMA, VERSI));
    const terpotong = tar.subarray(0, tar.length - 1024);

    const error = (() => {
      try {
        parseTarEntries(terpotong);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(codeOf(error)).toBe("truncated");
  });

  test("menolak isi entri yang terpotong", () => {
    const tar = buildTar([{ path: "package/besar.bin", data: "0123456789" }]);
    const terpotong = tar.subarray(0, 512 + 5);

    const error = (() => {
      try {
        parseTarEntries(terpotong);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(codeOf(error)).toBe("truncated");
  });

  test("menolak checksum header yang rusak", () => {
    const tar = buildTar(packageEntries(NAMA, VERSI));
    const rusak = Uint8Array.from(tar);
    rusak[10] = (rusak[10] ?? 0) ^ 0xff;

    const error = (() => {
      try {
        parseTarEntries(rusak);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(codeOf(error)).toBe("bad-checksum");
  });

  test("membaca path panjang dari header pax", () => {
    const panjang = `package/${"a".repeat(150)}.mjs`;
    const tar = buildTar([
      { path: "package/header-pax", type: "pax", data: paxRecord("path", panjang) },
      { path: "package/pendek.mjs", data: "isi" },
    ]);

    const entries = parseTarEntries(tar);
    expect(entries.map((entry) => entry.path)).toContain(panjang);
  });

  test("menolak ukuran pax yang berbeda dari ukuran header", () => {
    const tar = buildTar([
      { path: "package/header-pax", type: "pax", data: paxRecord("size", "1") },
      { path: "package/besar.mjs", data: "isi lebih dari satu byte" },
    ]);

    expect(() => parseTarEntries(tar)).toThrow(TarballError);
    try {
      parseTarEntries(tar);
    } catch (error) {
      expect(codeOf(error)).toBe("bad-header");
    }
  });
});

describe("validateEntries", () => {
  test("menolak symlink", () => {
    const entries = parseTarEntries(
      buildTar([
        ...packageEntries(NAMA, VERSI),
        { path: "package/jahat", type: "symlink", linkname: "/etc/passwd" },
      ]),
    );

    expect(() => validateEntries(entries, undefined, EXPECTED)).toThrow(TarballError);
    try {
      validateEntries(entries, undefined, EXPECTED);
    } catch (error) {
      expect(codeOf(error)).toBe("symlink");
    }
  });

  test("menolak hardlink", () => {
    const entries = parseTarEntries(
      buildTar([
        ...packageEntries(NAMA, VERSI),
        { path: "package/jahat", type: "hardlink", linkname: "package/sdk.mjs" },
      ]),
    );

    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("hardlink");
    }
  });

  test("menolak device dan fifo", () => {
    const entries = parseTarEntries(
      buildTar([
        ...packageEntries(NAMA, VERSI),
        { path: "package/perangkat", type: "other" },
      ]),
    );

    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("bad-type");
    }
  });

  test("menolak jalur keluar folder", () => {
    const entries = parseTarEntries(buildTar([{ path: "../x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("path-traversal");
    }
  });

  test("menolak keluar folder dari dalam awalan package", () => {
    const entries = parseTarEntries(buildTar([{ path: "package/../../x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("path-traversal");
    }
  });

  test("menolak jalur absolut", () => {
    const entries = parseTarEntries(buildTar([{ path: "/etc/x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("absolute-path");
    }
  });

  test("menolak gaya drive", () => {
    const entries = parseTarEntries(buildTar([{ path: "C:/x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("absolute-path");
    }
  });

  test("menolak backslash", () => {
    const entries = parseTarEntries(buildTar([{ path: "package/a\\b", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("bad-name");
    }
  });

  test("menolak NUL dan karakter kontrol", () => {
    const entries = parseTarEntries(buildTar([{ path: "package/a\u0001b", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("bad-name");
    }
  });

  test("menolak segmen kosong ganda", () => {
    const entries = parseTarEntries(buildTar([{ path: "package//x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("bad-name");
    }
  });

  test("menolak entri di luar awalan package", () => {
    const entries = parseTarEntries(buildTar([{ path: "lain/x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("outside-prefix");
    }
  });

  test("menolak entri yang mirip awalan package", () => {
    const entries = parseTarEntries(buildTar([{ path: "package-evil/x", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("outside-prefix");
    }
  });

  test("menolak jumlah entri berlebihan", () => {
    const entries = parseTarEntries(
      buildTar([
        { path: "package/a", data: "1" },
        { path: "package/b", data: "2" },
        { path: "package/c", data: "3" },
      ]),
    );

    try {
      validateEntries(entries, { maxEntries: 2 });
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("too-many-entries");
    }
  });

  test("menolak total ukuran berlebihan", () => {
    const entries = parseTarEntries(
      buildTar([
        { path: "package/a", data: "012345" },
        { path: "package/b", data: "012345" },
      ]),
    );

    try {
      validateEntries(entries, { maxTotalBytes: 10 });
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("too-large");
    }
  });

  test("menolak berkas yang terlalu besar", () => {
    const entries = parseTarEntries(buildTar([{ path: "package/besar.bin", data: "0123456789" }]));

    try {
      validateEntries(entries, { maxFileBytes: 5 });
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("file-too-large");
    }
  });

  test("menolak paket tanpa package.json", () => {
    const entries = parseTarEntries(buildTar([{ path: "package/sdk.mjs", data: "isi" }]));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("missing-package-json");
    }
  });

  test("menolak nama paket yang salah", () => {
    const entries = parseTarEntries(buildTar(packageEntries("paket-lain", VERSI)));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("name-mismatch");
    }
  });

  test("menolak versi paket yang salah", () => {
    const entries = parseTarEntries(buildTar(packageEntries(NAMA, "9.9.9")));
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("version-mismatch");
    }
  });

  test("menolak paket tanpa sdk.mjs", () => {
    const entries = parseTarEntries(
      buildTar([{ path: "package/package.json", data: packageJsonContent(NAMA, VERSI) }]),
    );
    try {
      validateEntries(entries, undefined, EXPECTED);
      throw new Error("harus gagal");
    } catch (error) {
      expect(codeOf(error)).toBe("missing-sdk");
    }
  });
});

describe("extractTarball", () => {
  test("mengekstrak paket dan memberi izin ketat", async () => {
    const gz = gzipOf(
      buildTar(
        packageEntries(NAMA, VERSI, [{ path: "package/lib/utility.js", data: "export const a = 1;\n" }]),
      ),
    );

    const hasil = await extractTarball(gz, dest, EXPECTED);

    expect(hasil.entries).toBeGreaterThan(0);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, "sdk.mjs"))).toBe(true);
    expect(existsSync(join(dest, "lib", "utility.js"))).toBe(true);

    const isiJson = readFileSync(join(dest, "package.json"), "utf8");
    expect(isiJson).toContain(NAMA);
    expect(isiJson).toContain(VERSI);
    expect(readFileSync(join(dest, "lib", "utility.js"), "utf8")).toContain("export const a = 1;");

    expect(statSync(join(dest, "package.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dest, "sdk.mjs")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dest, "lib")).mode & 0o777).toBe(0o700);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
  });

  test("menolak symlink saat ekstraksi", async () => {
    const { error } = await extract([
      ...packageEntries(NAMA, VERSI),
      { path: "package/jahat", type: "symlink", linkname: "/etc/passwd" },
    ]);

    expect(codeOf(error)).toBe("symlink");
    expect(existsSync(join(dest, "sdk.mjs"))).toBe(false);
  });

  test("tidak menulis apa pun bila validasi gagal", async () => {
    const { error } = await extract([
      { path: "package/package.json", data: packageJsonContent(NAMA, VERSI) },
      { path: "package/sdk.mjs", data: "isi" },
      { path: "package/jahat", type: "symlink", linkname: "/etc/passwd" },
    ]);

    expect(codeOf(error)).toBe("symlink");
    const isi = existsSync(dest) ? await readdir(dest) : [];
    expect(isi).toEqual([]);
  });

  test("menolak gzip bomb sebelum dekompresi penuh", async () => {
    const bomb = gzipOf(new Uint8Array(200_000));
    const error = await grabError(() =>
      extractTarball(bomb, dest, EXPECTED, { maxUncompressedBytes: 1000 }),
    );

    expect(codeOf(error)).toBe("too-large");
    expect(existsSync(join(dest, "package.json"))).toBe(false);
  });

  test("menolak masukan terkompresi yang terlalu besar", async () => {
    const gz = gzipOf(buildTar(packageEntries(NAMA, VERSI)));
    const error = await grabError(() =>
      extractTarball(gz, dest, EXPECTED, { maxCompressedBytes: 10 }),
    );

    expect(codeOf(error)).toBe("too-large");
  });

  test("menolak gzip yang rusak", async () => {
    const error = await grabError(() =>
      extractTarball(new TextEncoder().encode("bukan gzip"), dest, EXPECTED),
    );

    expect(codeOf(error)).toBe("gzip");
  });

  test("menolak arsip terpotong", async () => {
    const tar = buildTar(packageEntries(NAMA, VERSI));
    const gz = gzipOf(tar.subarray(0, tar.length - 1024));
    const error = await grabError(() => extractTarball(gz, dest, EXPECTED));

    expect(codeOf(error)).toBe("truncated");
  });
});
