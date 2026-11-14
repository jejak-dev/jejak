import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelForVersion,
  checkVersions,
  parseArgs,
  readVersions,
  ROOT,
} from "../scripts/check-version";

/** Membuat repo semu berisi tiga berkas manifest. */
async function buatRepo(
  versi: { package?: string; tauri?: string; cargo?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jejak-versi-"));
  await mkdir(join(root, "src-tauri"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "jejak", version: versi.package ?? "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({ productName: "Jejak", version: versi.tauri ?? "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "src-tauri", "Cargo.toml"),
    ['[package]', 'name = "jejak-desktop"', `version = "${versi.cargo ?? "1.0.0"}"`, "", "[dependencies]", 'serde = "1"', ""].join(
      "\n",
    ),
  );
  return root;
}

test("readVersions membaca versi dari tiga berkas manifest", async () => {
  const root = await buatRepo({ package: "1.2.3", tauri: "1.2.3", cargo: "1.2.3" });
  try {
    expect(readVersions(root)).toEqual({
      package: "1.2.3",
      tauri: "1.2.3",
      cargo: "1.2.3",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVersions gagal bila berkas manifest tidak ada", async () => {
  const root = await mkdtemp(join(tmpdir(), "jejak-versi-kosong-"));
  try {
    expect(() => readVersions(root)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVersions pada repo sekarang membaca versi yang sama", () => {
  const hasil = checkVersions(readVersions(ROOT));
  expect(hasil.errors).toEqual([]);
  expect(hasil.ok).toBe(true);
});

test("checkVersions lulus bila semua versi sama", () => {
  const hasil = checkVersions({ package: "1.0.0", tauri: "1.0.0", cargo: "1.0.0" });
  expect(hasil.ok).toBe(true);
  expect(hasil.errors).toEqual([]);
  expect(hasil.version).toBe("1.0.0");
  expect(hasil.channel).toBe("stable");
});

test("checkVersions gagal bila versi berbeda", () => {
  const hasil = checkVersions({ package: "1.0.0", tauri: "1.0.1", cargo: "1.0.0" });
  expect(hasil.ok).toBe(false);
  expect(hasil.errors.length).toBe(1);
  expect(hasil.errors[0]).toContain("Versi tidak sama");
  expect(hasil.version).toBeNull();
});

test("checkVersions gagal bila versi bukan semver sah", () => {
  const hasil = checkVersions({ package: "1.0", tauri: "1.0", cargo: "1.0" });
  expect(hasil.ok).toBe(false);
  expect(hasil.errors.length).toBe(3);
  expect(hasil.channel).toBeNull();
});

test("checkVersions menuntut tag cocok dengan versi", () => {
  const versi = { package: "1.0.0", tauri: "1.0.0", cargo: "1.0.0" };
  expect(checkVersions(versi, "v1.0.0").ok).toBe(true);
  const salah = checkVersions(versi, "v1.0.1");
  expect(salah.ok).toBe(false);
  expect(salah.errors[0]).toContain("tidak cocok");
});

test("checkVersions menolak tag tanpa awalan v", () => {
  const hasil = checkVersions(
    { package: "1.0.0", tauri: "1.0.0", cargo: "1.0.0" },
    "1.0.0",
  );
  expect(hasil.ok).toBe(false);
});

test("checkVersions menerima tag prarilis yang cocok", () => {
  const versi = { package: "1.0.0-beta.1", tauri: "1.0.0-beta.1", cargo: "1.0.0-beta.1" };
  const hasil = checkVersions(versi, "v1.0.0-beta.1");
  expect(hasil.ok).toBe(true);
  expect(hasil.channel).toBe("beta");
});

test("channelForVersion memetakan versi ke kanal", () => {
  expect(channelForVersion("1.0.0")).toBe("stable");
  expect(channelForVersion("0.0.1")).toBe("stable");
  expect(channelForVersion("1.0.0+build.7")).toBe("stable");
  expect(channelForVersion("1.0.0-beta.1")).toBe("beta");
  expect(channelForVersion("1.0.0-rc.2")).toBe("beta");
});

test("channelForVersion menolak versi tidak valid", () => {
  expect(() => channelForVersion("1.0")).toThrow();
  expect(() => channelForVersion("v1.0.0")).toThrow();
});

test("parseArgs membaca tag dan print-channel", () => {
  expect(parseArgs([])).toEqual({ tag: undefined, printChannel: false });
  expect(parseArgs(["--tag", "v1.0.0"])).toEqual({
    tag: "v1.0.0",
    printChannel: false,
  });
  expect(parseArgs(["--tag=v1.0.0"])).toEqual({
    tag: "v1.0.0",
    printChannel: false,
  });
  expect(parseArgs(["--print-channel"])).toEqual({
    tag: undefined,
    printChannel: true,
  });
});

test("parseArgs menolak argumen tidak dikenal", () => {
  expect(parseArgs(["--salah"]).error).toContain("tidak dikenal");
  expect(parseArgs(["--tag"]).error).toContain("--tag");
  expect(parseArgs(["--tag", "--print-channel"]).error).toContain("--tag");
});
