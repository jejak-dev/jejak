import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  compareSemver,
  DATA_VERSION_FILE,
  DataVersionError,
  parseSemver,
  prepareDataDir,
} from "../src/server/data-version";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jejak-data-version-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const APP = "1.2.3";

function tetap(): () => Date {
  return () => new Date("2026-11-14T00:00:00.000Z");
}

async function tulisVersi(appVersion: string): Promise<void> {
  await writeFile(
    join(home, DATA_VERSION_FILE),
    `${JSON.stringify({ appVersion, updatedAt: "2026-11-01T00:00:00.000Z" }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function tulisDb(nama: string, isi: string): Promise<void> {
  const db = new Database(join(home, nama));
  db.run("CREATE TABLE t (a TEXT)");
  db.run("INSERT INTO t VALUES (?)", [isi]);
  db.close();
}

async function bacaVersi(): Promise<{ appVersion: string; updatedAt: string }> {
  const raw = await readFile(join(home, DATA_VERSION_FILE), "utf8");
  return JSON.parse(raw) as { appVersion: string; updatedAt: string };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("semver", () => {
  test("parseSemver mengurai mayor.minor.patch dan pra-rilis", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver("1.2.3-beta.1")?.prerelease).toEqual(["beta", "1"]);
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("bukan-versi")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });

  test("compareSemver membandingkan mayor.minor.patch", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  test("pra-rilis lebih tua daripada rilis", () => {
    expect(compareSemver("1.0.0-alpha.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareSemver("1.0.0+build", "1.0.0")).toBe(0);
  });

  test("versi tak valid melempar galat", () => {
    expect(() => compareSemver("x", "1.0.0")).toThrow();
  });
});

describe("prepareDataDir", () => {
  test("folder kosong menghasilkan fresh dan menulis berkas versi", async () => {
    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("fresh");
    expect(hasil.from).toBeUndefined();
    expect(await bacaVersi()).toEqual({
      appVersion: APP,
      updatedAt: "2026-11-14T00:00:00.000Z",
    });
    expect(await mode(join(home, DATA_VERSION_FILE))).toBe(0o600);
    expect(await mode(home)).toBe(0o700);
  });

  test("versi sama tidak menulis apa pun", async () => {
    await tulisVersi(APP);
    const sebelum = await readFile(join(home, DATA_VERSION_FILE), "utf8");

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("same");
    expect(await readFile(join(home, DATA_VERSION_FILE), "utf8")).toBe(sebelum);
    expect(await readdir(join(home, "backup")).catch(() => [])).toEqual([]);
  });

  test("versi lama memicu cadangan lalu berkas versi diperbarui", async () => {
    await tulisVersi("1.0.0");
    await tulisDb("sessions.db", "halo");

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("upgraded");
    expect(hasil.from).toBe("1.0.0");
    expect(hasil.backupDir).toBe(join(home, "backup", "1.0.0"));
    expect(await bacaVersi()).toEqual({
      appVersion: APP,
      updatedAt: "2026-11-14T00:00:00.000Z",
    });
    const salinan = join(hasil.backupDir ?? "", "sessions.db");
    expect(await stat(salinan)).toBeDefined();
  });

  test("data tanpa berkas versi diperlakukan sebagai legacy", async () => {
    await tulisDb("sessions.db", "halo");

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("legacy");
    expect(hasil.from).toBe("0.0.0");
    expect(hasil.backupDir).toBe(join(home, "backup", "0.0.0"));
    expect(await bacaVersi()).toEqual({
      appVersion: APP,
      updatedAt: "2026-11-14T00:00:00.000Z",
    });
  });

  test("data lebih baru ditolak tanpa perubahan apa pun", async () => {
    await tulisVersi("9.9.9");
    await tulisDb("sessions.db", "halo");
    const sebelum = await readFile(join(home, DATA_VERSION_FILE), "utf8");

    const galat = await prepareDataDir({
      home,
      appVersion: APP,
      now: tetap(),
    }).catch((error: unknown) => error);

    expect(galat).toBeInstanceOf(DataVersionError);
    expect((galat as DataVersionError).code).toBe("newer");
    expect((galat as DataVersionError).message).toContain("lebih baru");
    expect((galat as DataVersionError).message).toContain("9.9.9");
    expect((galat as DataVersionError).message).toContain(APP);
    expect((galat as DataVersionError).message).toContain("JEJAK_HOME");
    expect(await readFile(join(home, DATA_VERSION_FILE), "utf8")).toBe(sebelum);
    expect(await readdir(join(home, "backup")).catch(() => [])).toEqual([]);
  });

  test("data pra-rilis lebih baru dari rilis ditolak", async () => {
    await tulisVersi("1.0.0");

    const galat = await prepareDataDir({
      home,
      appVersion: "1.0.0-alpha.1",
      now: tetap(),
    }).catch((error: unknown) => error);

    expect(galat).toBeInstanceOf(DataVersionError);
    expect((galat as DataVersionError).code).toBe("newer");
  });

  test("data pra-rilis lebih tua diperlakukan sebagai naik versi", async () => {
    await tulisVersi("1.0.0-alpha.1");
    await tulisDb("sessions.db", "halo");

    const hasil = await prepareDataDir({ home, appVersion: "1.0.0", now: tetap() });

    expect(hasil.action).toBe("upgraded");
    expect(hasil.from).toBe("1.0.0-alpha.1");
  });

  test("berkas versi rusak: ada data -> cadangan dulu lalu ditulis ulang", async () => {
    await writeFile(join(home, DATA_VERSION_FILE), "{ bukan json", { mode: 0o600 });
    await tulisDb("sessions.db", "halo");
    const peringatan: string[] = [];

    const hasil = await prepareDataDir({
      home,
      appVersion: APP,
      now: tetap(),
      warn: (line) => peringatan.push(line),
    });

    expect(hasil.action).toBe("legacy");
    expect(hasil.backupDir).toBe(join(home, "backup", "0.0.0"));
    expect(peringatan.join("\n")).toContain("rusak");
    expect((await bacaVersi()).appVersion).toBe(APP);
  });

  test("berkas versi rusak tanpa data lain ditulis ulang sebagai fresh", async () => {
    await writeFile(join(home, DATA_VERSION_FILE), "bukan json", { mode: 0o600 });

    const hasil = await prepareDataDir({
      home,
      appVersion: APP,
      now: tetap(),
      warn: () => {},
    });

    expect(hasil.action).toBe("fresh");
    expect((await bacaVersi()).appVersion).toBe(APP);
  });

  test("berkas versi dengan semver tak valid diperlakukan sebagai rusak", async () => {
    await writeFile(
      join(home, DATA_VERSION_FILE),
      `${JSON.stringify({ appVersion: "versi-salah" })}\n`,
      { mode: 0o600 },
    );
    await tulisDb("sessions.db", "halo");

    const hasil = await prepareDataDir({
      home,
      appVersion: APP,
      now: tetap(),
      warn: () => {},
    });

    expect(hasil.action).toBe("legacy");
    expect((await bacaVersi()).appVersion).toBe(APP);
  });

  test("isi cadangan: json identik, db bisa dibuka, tanpa subfolder", async () => {
    await tulisVersi("1.0.0");
    await tulisDb("sessions.db", "halo");
    await writeFile(join(home, "providers.json"), '{"a":1}\n', { mode: 0o600 });
    await mkdir(join(home, "worktrees", "w1"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "worktrees", "w1", "data.txt"), "jangan ikut", {
      mode: 0o600,
    });
    await mkdir(join(home, "memory"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "memory", "catatan.md"), "jangan ikut", { mode: 0o600 });

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });
    const backupDir = hasil.backupDir ?? "";

    const isi = await readdir(backupDir);
    // Berkas versi data ikut tersalin: ia pun berkas `*.json` tingkat atas.
    expect(isi.sort()).toEqual([DATA_VERSION_FILE, "providers.json", "sessions.db"]);

    expect(await readFile(join(backupDir, "providers.json"), "utf8")).toBe('{"a":1}\n');

    const db = new Database(join(backupDir, "sessions.db"), { readonly: true });
    const baris = db.query("SELECT a FROM t").all() as { a: string }[];
    db.close();
    expect(baris).toEqual([{ a: "halo" }]);
  });

  test("izin cadangan: direktori 700 dan berkas 600", async () => {
    await tulisVersi("1.0.0");
    await tulisDb("sessions.db", "halo");
    await writeFile(join(home, "providers.json"), "{}\n", { mode: 0o600 });

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });
    const backupDir = hasil.backupDir ?? "";

    expect(await mode(join(home, "backup"))).toBe(0o700);
    expect(await mode(backupDir)).toBe(0o700);
    expect(await mode(join(backupDir, "sessions.db"))).toBe(0o600);
    expect(await mode(join(backupDir, "providers.json"))).toBe(0o600);
  });

  test("paling banyak tiga cadangan versi terbaru disimpan", async () => {
    for (const versi of ["1.0.0", "2.0.0"]) {
      await mkdir(join(home, "backup", versi), { recursive: true, mode: 0o700 });
    }
    await mkdir(join(home, "backup", "catatan"), { recursive: true, mode: 0o700 });

    await tulisVersi("3.0.0");
    await tulisDb("sessions.db", "halo");
    const hasil = await prepareDataDir({ home, appVersion: "4.0.0", now: tetap() });
    expect(hasil.backupDir).toBe(join(home, "backup", "3.0.0"));

    await tulisVersi("4.0.0");
    await prepareDataDir({ home, appVersion: "5.0.0", now: tetap() });

    const isi = (await readdir(join(home, "backup"))).sort();
    expect(isi).toEqual(["2.0.0", "3.0.0", "4.0.0", "catatan"]);
  });

  test("JEJAK_SKIP_BACKUP=1 melewati cadangan tapi berkas versi diperbarui", async () => {
    await tulisVersi("1.0.0");
    await tulisDb("sessions.db", "halo");

    const hasil = await prepareDataDir({
      home,
      appVersion: APP,
      now: tetap(),
      env: { JEJAK_SKIP_BACKUP: "1" },
    });

    expect(hasil.action).toBe("upgraded");
    expect(hasil.backupDir).toBeUndefined();
    expect(await readdir(join(home, "backup")).catch(() => [])).toEqual([]);
    expect((await bacaVersi()).appVersion).toBe(APP);
  });

  test("kegagalan cadangan memberi galat backup dan berkas versi tak berubah", async () => {
    await tulisVersi("1.0.0");
    await tulisDb("sessions.db", "halo");
    // `backup` berisi berkas biasa, jadi folder cadangan tak bisa dibuat.
    await writeFile(join(home, "backup"), "bukan folder", { mode: 0o600 });
    const sebelum = await readFile(join(home, DATA_VERSION_FILE), "utf8");

    const galat = await prepareDataDir({ home, appVersion: APP, now: tetap() }).catch(
      (error: unknown) => error,
    );

    expect(galat).toBeInstanceOf(DataVersionError);
    expect((galat as DataVersionError).code).toBe("backup");
    expect((galat as DataVersionError).message).toContain("tidak diubah");
    expect(await readFile(join(home, DATA_VERSION_FILE), "utf8")).toBe(sebelum);
  });

  test("menjalankan dua kali bersifat idempoten", async () => {
    const pertama = await prepareDataDir({ home, appVersion: APP, now: tetap() });
    expect(pertama.action).toBe("fresh");

    const kedua = await prepareDataDir({
      home,
      appVersion: APP,
      now: () => new Date("2026-12-25T00:00:00.000Z"),
    });
    expect(kedua.action).toBe("same");
    expect((await bacaVersi()).updatedAt).toBe("2026-11-14T00:00:00.000Z");
    expect(await readdir(join(home, "backup")).catch(() => [])).toEqual([]);
  });

  test("folder home tak ada dibuat dengan izin 700", async () => {
    const baru = join(home, "baru");
    const hasil = await prepareDataDir({ home: baru, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("fresh");
    expect(await mode(baru)).toBe(0o700);
    expect(await mode(join(baru, DATA_VERSION_FILE))).toBe(0o600);
  });

  test("versi sama tak menulis berkas versi sehingga izin tak berubah", async () => {
    await tulisVersi(APP);
    await chmod(join(home, DATA_VERSION_FILE), 0o644);

    const hasil = await prepareDataDir({ home, appVersion: APP, now: tetap() });

    expect(hasil.action).toBe("same");
    expect(await mode(join(home, DATA_VERSION_FILE))).toBe(0o644);
  });
});
