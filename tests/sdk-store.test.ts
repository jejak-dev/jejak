import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SdkStoreError,
  getStatus,
  installFromTarball,
  readActive,
  resolveActiveSdkEntry,
  rollback,
  sdkRoot,
  withInstallLock,
} from "../src/server/sdk/sdk-store";
import { TarballError, computeIntegrity } from "../src/server/sdk/tarball";
import { buildTar, gzipOf, packageEntries } from "./helpers/tar-builder";

const NAMA = "@anthropic-ai/claude-agent-sdk";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sdk-store-"));
  root = join(dir, "sdk");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tarball(versi: string): Uint8Array {
  return gzipOf(buildTar(packageEntries(NAMA, versi)));
}

async function pasang(versi: string, now?: string): Promise<Uint8Array> {
  const gz = tarball(versi);
  await installFromTarball(root, {
    gz,
    integrity: computeIntegrity(gz),
    expected: { name: NAMA, version: versi },
    now,
  });
  return gz;
}

async function grabError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("sdkRoot", () => {
  test("berada di bawah JEJAK_HOME", () => {
    expect(sdkRoot({ JEJAK_HOME: "/tmp/jejak-rumah" })).toBe("/tmp/jejak-rumah/sdk");
  });
});

describe("installFromTarball", () => {
  test("menyimpan paket dan menulis active.json", async () => {
    await pasang("1.0.0", "2026-01-01T00:00:00.000Z");

    expect(existsSync(join(root, "1.0.0", "package", "package.json"))).toBe(true);
    expect(existsSync(join(root, "1.0.0", "package", "sdk.mjs"))).toBe(true);
    expect(existsSync(join(root, "1.0.0", "meta.json"))).toBe(true);

    const active = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
    expect(active.version).toBe("1.0.0");
    expect(active.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(active.integrity.startsWith("sha512-")).toBe(true);
    expect(active.previous).toBeUndefined();
    expect(statSync(join(root, "active.json")).mode & 0o777).toBe(0o600);
  });

  test("menolak integritas yang tidak cocok dan tidak meninggalkan sisa", async () => {
    const gz = tarball("1.0.0");
    const error = await grabError(() =>
      installFromTarball(root, {
        gz,
        integrity: computeIntegrity(tarball("2.0.0")),
        expected: { name: NAMA, version: "1.0.0" },
      }),
    );

    expect(error).toBeInstanceOf(TarballError);
    expect((error as TarballError).code).toBe("integrity");
    const isi = existsSync(root) ? await readdir(root) : [];
    expect(isi.filter((nama) => nama.startsWith(".tmp-"))).toEqual([]);
  });

  test("menolak versi yang triesakan keluar folder", async () => {
    const gz = tarball("1.0.0");
    const error = await grabError(() =>
      installFromTarball(root, {
        gz,
        integrity: computeIntegrity(gz),
        expected: { name: NAMA, version: "../1.0.0" },
      }),
    );

    expect(error).toBeInstanceOf(SdkStoreError);
    expect((error as SdkStoreError).code).toBe("bad-version");
    const isi = existsSync(root) ? await readdir(root) : [];
    expect(isi.filter((nama) => nama.startsWith(".tmp-"))).toEqual([]);
  });

  test("menyimpan hanya versi aktif dan sebelumnya", async () => {
    await pasang("1.0.0");
    await pasang("2.0.0");
    await pasang("3.0.0");

    const isi = (await readdir(root)).filter((nama) => !nama.startsWith("."));
    expect(isi.sort()).toEqual(["2.0.0", "3.0.0", "active.json"]);

    const status = await getStatus(root);
    expect(status.installed?.version).toBe("3.0.0");
    expect(status.previous).toBe("2.0.0");
    expect(existsSync(join(root, "2.0.0", "package", "sdk.mjs"))).toBe(true);
    expect(existsSync(join(root, "1.0.0"))).toBe(false);
  });

  test("memasang ulang versi yang sama diizinkan", async () => {
    await pasang("1.0.0");
    await pasang("1.0.0");

    const status = await getStatus(root);
    expect(status.installed?.version).toBe("1.0.0");
    expect(existsSync(join(root, "1.0.0", "package", "sdk.mjs"))).toBe(true);
  });

  test("membersihkan folder sementara saat ekstraksi gagal", async () => {
    const gz = gzipOf(buildTar([{ path: "package/sdk.mjs", data: "isi" }]));
    const error = await grabError(() =>
      installFromTarball(root, {
        gz,
        integrity: computeIntegrity(gz),
        expected: { name: NAMA, version: "1.0.0" },
      }),
    );

    expect(error).toBeInstanceOf(TarballError);
    expect((error as TarballError).code).toBe("missing-package-json");
    const isi = existsSync(root) ? await readdir(root) : [];
    expect(isi.filter((nama) => nama.startsWith(".tmp-"))).toEqual([]);
  });
});

describe("getStatus", () => {
  test("null bila belum ada yang terpasang", async () => {
    expect(await getStatus(root)).toEqual({ installed: null, previous: null });
  });

  test("null bila sdk.mjs tidak ada", async () => {
    await pasang("1.0.0");
    await rm(join(root, "1.0.0", "package", "sdk.mjs"));

    const status = await getStatus(root);
    expect(status.installed).toBeNull();
  });

  test("null bila active.json rusak", async () => {
    await pasang("1.0.0");
    await writeFile(join(root, "active.json"), "{ bukan json", "utf8");

    expect(await readActive(root)).toBeNull();
    expect((await getStatus(root)).installed).toBeNull();
  });
});

describe("rollback", () => {
  test("mengaktifkan versi sebelumnya", async () => {
    await pasang("1.0.0");
    await pasang("2.0.0");

    const hasil = await rollback(root);
    expect(hasil.version).toBe("1.0.0");

    const status = await getStatus(root);
    expect(status.installed?.version).toBe("1.0.0");
    expect(status.previous).toBe("2.0.0");
  });

  test("gagal tanpa versi sebelumnya", async () => {
    await pasang("1.0.0");

    const error = await grabError(() => rollback(root));
    expect(error).toBeInstanceOf(SdkStoreError);
    expect((error as SdkStoreError).code).toBe("no-previous");
  });

  test("gagal bila folder versi sebelumnya hilang", async () => {
    await pasang("1.0.0");
    await pasang("2.0.0");
    await rm(join(root, "1.0.0"), { recursive: true, force: true });

    const error = await grabError(() => rollback(root));
    expect(error).toBeInstanceOf(SdkStoreError);
    expect((error as SdkStoreError).code).toBe("no-previous");
  });
});

describe("resolveActiveSdkEntry", () => {
  test("mengembalikan path sdk.mjs versi aktif", async () => {
    await pasang("1.0.0");

    const entry = await resolveActiveSdkEntry(root);
    expect(entry).not.toBeNull();
    expect(entry?.endsWith(join("1.0.0", "package", "sdk.mjs"))).toBe(true);
  });

  test("null bila belum ada yang terpasang", async () => {
    expect(await resolveActiveSdkEntry(root)).toBeNull();
  });

  test("menolak symlink yang keluar dari folder versi", async () => {
    await pasang("1.0.0");
    const luar = join(dir, "luar.mjs");
    await writeFile(luar, "export const a = 1;\n", "utf8");
    await rm(join(root, "1.0.0", "package", "sdk.mjs"));
    await symlink(luar, join(root, "1.0.0", "package", "sdk.mjs"));

    expect(await resolveActiveSdkEntry(root)).toBeNull();
  });
});

describe("withInstallLock", () => {
  test("menolak pemasangan kedua saat kunci dipakai", async () => {
    const error = await grabError(() =>
      withInstallLock(async () =>
        withInstallLock(async () => {
          throw new Error("tidak boleh reached");
        }),
      ),
    );

    expect(error).toBeInstanceOf(SdkStoreError);
    expect((error as SdkStoreError).code).toBe("busy");
  });

  test("kunci dilepas setelah selesai", async () => {
    const nilai = await withInstallLock(async () => "selesai");
    expect(nilai).toBe("selesai");
    const lagi = await withInstallLock(async () => "selesai lagi");
    expect(lagi).toBe("selesai lagi");
  });
});
