import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMarketplacePlugin,
  listMarketplaces,
  searchMarketplacePlugins,
} from "../src/server/claude-config/marketplace";

let root: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-marketplace-")));
  home = join(root, "rumah");
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pluginsDir(): string {
  return join(home, ".claude", "plugins");
}

async function tulisKatalog(
  marketplace: string,
  isi: unknown,
  opts: { rusak?: boolean; luar?: boolean } = {},
): Promise<string> {
  const dir = opts.luar === true
    ? join(root, "luar", marketplace)
    : join(pluginsDir(), "marketplaces", marketplace);
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  const path = join(dir, ".claude-plugin", "marketplace.json");
  const body = opts.rusak === true ? "{ ini bukan json" : JSON.stringify(isi);
  await writeFile(path, body, "utf8");
  return dir;
}

async function tulisKnown(
  entries: Record<string, { installLocation: string; lastUpdated?: string }>,
): Promise<void> {
  const known: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    known[name] = {
      source: { source: "github", repo: `contoh/${name}` },
      installLocation: value.installLocation,
      lastUpdated: value.lastUpdated ?? "2026-01-02T03:04:05.000Z",
    };
  }
  await writeFile(
    join(pluginsDir(), "known_marketplaces.json"),
    JSON.stringify(known),
    "utf8",
  );
}

const KATALOG_VALID = {
  name: "valid",
  description: "Katalog contoh",
  plugins: [
    {
      name: "alpha",
      displayName: "Alfa Tool",
      description: "x".repeat(600),
      author: { name: "Anthropic" },
      category: "development",
      homepage: "https://contoh.test/alpha",
      version: "1.2.3",
      tags: ["koding", "tool"],
      source: "./plugins/alpha",
    },
    {
      name: "beta",
      description: "Plugin beta",
      author: "Tim Beta",
      category: "security",
      source: { source: "git-subdir", url: "https://github.test/x.git", path: "b" },
    },
    {
      name: "gamma",
      description: "Plugin gamma",
      category: "development",
      source: { source: "url", url: "https://contoh.test/gamma.zip" },
    },
    {
      name: "delta",
      description: "Plugin delta",
      source: { source: "command", command: "./pasang.sh" },
    },
    { description: "Tanpa nama" },
    { name: "salah/nama", description: "Nama tak valid" },
    { name: "", description: "Nama kosong" },
  ],
};

async function siapkanSkenario(): Promise<void> {
  const validDir = await tulisKatalog("valid", KATALOG_VALID);
  const luarDir = await tulisKatalog("luar", { name: "luar", plugins: [] }, { luar: true });
  await tulisKatalog("rusak", { name: "rusak" }, { rusak: true });
  await tulisKnown({
    valid: { installLocation: validDir },
    luar: { installLocation: luarDir },
    rusak: { installLocation: join(pluginsDir(), "marketplaces", "rusak") },
    "nama!salah": { installLocation: validDir },
  });
}

async function pasangPlugin(id: string, nama: string): Promise<void> {
  const installPath = join(pluginsDir(), "pasang", nama);
  await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(installPath, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: nama }),
    "utf8",
  );
  const path = join(pluginsDir(), "installed_plugins.json");
  await writeFile(
    path,
    JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", installPath }] } }),
    "utf8",
  );
}

describe("katalog marketplace", () => {
  test("marketplace di luar folder plugin dan berkas rusak diabaikan", async () => {
    await siapkanSkenario();
    const daftar = listMarketplaces(home);
    expect(daftar.map((item) => item.name)).toEqual(["valid"]);
    expect(daftar[0]).toMatchObject({
      name: "valid",
      description: "Katalog contoh",
      pluginCount: 4,
      lastUpdated: "2026-01-02T03:04:05.000Z",
    });
  });

  test("nama marketplace tak valid diabaikan", async () => {
    await siapkanSkenario();
    expect(listMarketplaces(home).map((item) => item.name)).not.toContain("nama!salah");
  });

  test("pencarian: query, kategori, limit/offset, dan total", async () => {
    await siapkanSkenario();
    const semua = searchMarketplacePlugins(home);
    expect(semua.total).toBe(4);
    expect(semua.items.map((item) => item.name)).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(semua.categories).toEqual(["development", "security"]);

    const query = searchMarketplacePlugins(home, { query: "ALFA" });
    expect(query.items.map((item) => item.name)).toEqual(["alpha"]);

    const tag = searchMarketplacePlugins(home, { query: "koding" });
    expect(tag.items.map((item) => item.name)).toEqual(["alpha"]);

    const kategori = searchMarketplacePlugins(home, { category: "security" });
    expect(kategori.items.map((item) => item.name)).toEqual(["beta"]);

    const halaman = searchMarketplacePlugins(home, { limit: 2, offset: 1 });
    expect(halaman.total).toBe(4);
    expect(halaman.items.map((item) => item.name)).toEqual(["beta", "delta"]);
  });

  test("batas limit dan offset", async () => {
    await siapkanSkenario();
    expect(searchMarketplacePlugins(home, { limit: 1 }).items).toHaveLength(1);
    expect(searchMarketplacePlugins(home, { offset: 99 }).items).toHaveLength(0);
    expect(searchMarketplacePlugins(home, { limit: 1 }).total).toBe(4);
  });

  test("pencarian per marketplace", async () => {
    await siapkanSkenario();
    const hasil = searchMarketplacePlugins(home, { marketplace: "valid" });
    expect(hasil.total).toBe(4);
    const lain = searchMarketplacePlugins(home, { marketplace: "tidak-ada" });
    expect(lain.total).toBe(0);
  });

  test("deskripsi dipotong ke 500 karakter dan entri nama buruk dilewati", async () => {
    await siapkanSkenario();
    const hasil = searchMarketplacePlugins(home, { query: "alpha" });
    const alpha = hasil.items[0];
    expect(alpha?.description).toHaveLength(500);
    const semua = searchMarketplacePlugins(home);
    expect(semua.items.map((item) => item.name)).not.toContain("salah/nama");
    expect(semua.total).toBe(4);
  });

  test("sumber plugin diklasifikasi menurut jenisnya", async () => {
    await siapkanSkenario();
    const semua = searchMarketplacePlugins(home);
    const jenis = new Map(semua.items.map((item) => [item.name, item.sourceKind]));
    expect(jenis.get("alpha")).toBe("marketplace");
    expect(jenis.get("beta")).toBe("git");
    expect(jenis.get("gamma")).toBe("url");
    expect(jenis.get("delta")).toBe("command");
  });

  test("status terpasang mengikuti daftar plugin terpasang", async () => {
    await siapkanSkenario();
    await pasangPlugin("alpha@valid", "alpha");
    const semua = searchMarketplacePlugins(home);
    const alpha = semua.items.find((item) => item.name === "alpha");
    expect(alpha?.installed).toBe(true);
    expect(alpha?.id).toBe("alpha@valid");
    const beta = semua.items.find((item) => item.name === "beta");
    expect(beta?.installed).toBe(false);
  });

  test("cari plugin di katalog", async () => {
    await siapkanSkenario();
    expect(findMarketplacePlugin(home, "alpha@valid")?.name).toBe("alpha");
    expect(findMarketplacePlugin(home, "alpha@lain")).toBeUndefined();
    expect(findMarketplacePlugin(home, "hantu@valid")).toBeUndefined();
  });

  test("cache: berkas dengan isi sama tak di-parse ulang, berkas berubah dibaca ulang", async () => {
    await siapkanSkenario();
    const path = join(pluginsDir(), "marketplaces", "valid", ".claude-plugin", "marketplace.json");
    const sebelum = await stat(path);

    const pertama = searchMarketplacePlugins(home);
    expect(pertama.total).toBe(4);

    // Isi sama panjang dan mtime sama: cache lama harus dipakai.
    const isi = JSON.stringify(KATALOG_VALID);
    await writeFile(path, isi.replace("Plugin beta", "Plugin BETA"), "utf8");
    await utimes(path, sebelum.atimeMs / 1000, sebelum.mtimeMs / 1000);
    const kedua = searchMarketplacePlugins(home);
    expect(kedua.items.find((item) => item.name === "beta")?.description).toBe("Plugin beta");

    // Ukuran berbeda: berkas dibaca ulang.
    await writeFile(
      path,
      JSON.stringify({ ...KATALOG_VALID, plugins: [{ name: "zeta", description: "Zeta" }] }),
      "utf8",
    );
    const ketiga = searchMarketplacePlugins(home);
    expect(ketiga.total).toBe(1);
    expect(ketiga.items[0]?.name).toBe("zeta");
  });
});
