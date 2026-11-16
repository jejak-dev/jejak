import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PLUGINS,
  enabledPluginPaths,
  listInstalledPlugins,
} from "../src/server/claude-config/plugins";

let root: string;
let home: string;
let pluginsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-plugin-"));
  home = join(root, "rumah");
  pluginsDir = join(home, ".claude", "plugins");
  await mkdir(pluginsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tulisBerkas(path: string, isi: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, isi, "utf8");
}

async function tulisInstalled(
  plugins: Record<string, unknown>,
  version: unknown = 2,
): Promise<void> {
  await tulisBerkas(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version, plugins }),
  );
}

async function buatPlugin(nama: string): Promise<string> {
  const installPath = join(pluginsDir, "pasang", nama);
  await mkdir(installPath, { recursive: true });
  return installPath;
}

describe("listInstalledPlugins", () => {
  test("berkas hilang menghasilkan daftar kosong", () => {
    expect(listInstalledPlugins(home)).toEqual([]);
  });

  test("JSON rusak menghasilkan daftar kosong", async () => {
    await tulisBerkas(join(pluginsDir, "installed_plugins.json"), "{ bukan json");
    expect(listInstalledPlugins(home)).toEqual([]);
  });

  test("versi tak dikenal menghasilkan daftar kosong", async () => {
    const installPath = await buatPlugin("alpha");
    await tulisInstalled({ "alpha@pasar": [{ scope: "user", installPath }] }, 99);
    expect(listInstalledPlugins(home)).toEqual([]);
  });

  test("metadata dibaca dan isi dihitung", async () => {
    const installPath = await buatPlugin("alpha");
    await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
    await tulisBerkas(
      join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "alpha",
        description: "Plugin contoh",
        version: "1.2.3",
        author: { name: "Penulis" },
      }),
    );
    await mkdir(join(installPath, "skills", "satu"), { recursive: true });
    await mkdir(join(installPath, "skills", "dua"), { recursive: true });
    await tulisBerkas(join(installPath, "skills", "satu", "SKILL.md"), "---\n---\n");
    // Folder skill tanpa SKILL.md tak dihitung.
    await mkdir(join(installPath, "skills", "tiga"), { recursive: true });
    await mkdir(join(installPath, "commands"), { recursive: true });
    await tulisBerkas(join(installPath, "commands", "satu.md"), "# satu\n");
    await tulisBerkas(join(installPath, "commands", "dua.txt"), "bukan md\n");
    await mkdir(join(installPath, "agents"), { recursive: true });
    await tulisBerkas(join(installPath, "agents", "satu.md"), "# satu\n");
    await mkdir(join(installPath, "hooks"), { recursive: true });

    await tulisInstalled({
      "alpha@pasar": [{ scope: "user", installPath, version: "1.2.3" }],
    });

    expect(listInstalledPlugins(home)).toEqual([
      {
        id: "alpha@pasar",
        name: "alpha",
        marketplace: "pasar",
        description: "Plugin contoh",
        version: "1.2.3",
        author: "Penulis",
        path: installPath,
        skills: 1,
        commands: 1,
        agents: 1,
        hasHooks: false,
      },
    ]);
  });

  test("hooks.json ada dibaca sebagai hasHooks", async () => {
    const installPath = await buatPlugin("beta");
    await mkdir(join(installPath, "hooks"), { recursive: true });
    await tulisBerkas(join(installPath, "hooks", "hooks.json"), "{}");
    await tulisInstalled({
      "beta@pasar": [{ scope: "user", installPath }],
    });
    expect(listInstalledPlugins(home)[0]?.hasHooks).toBe(true);
  });

  test("plugin tanpa plugin.json memakai nama dari kunci", async () => {
    const installPath = await buatPlugin("gamma");
    await tulisInstalled({
      "gamma@pasar": [{ scope: "user", installPath }],
    });
    const daftar = listInstalledPlugins(home);
    expect(daftar).toHaveLength(1);
    expect(daftar[0]).toMatchObject({
      id: "gamma@pasar",
      name: "gamma",
      marketplace: "pasar",
      description: "",
      version: "",
      author: "",
    });
  });

  test("scope project dilewati", async () => {
    const installPath = await buatPlugin("delta");
    await tulisInstalled({
      "delta@pasar": [{ scope: "project", installPath }],
    });
    expect(listInstalledPlugins(home)).toEqual([]);
  });

  test("installPath yang tak ada dilewati", async () => {
    const installPath = await buatPlugin("epsilon");
    await tulisInstalled({
      "epsilon@pasar": [{ scope: "user", installPath: join(root, "hilang") }],
      "zeta@pasar": [{ scope: "user", installPath }],
    });
    const daftar = listInstalledPlugins(home);
    expect(daftar.map((item) => item.id)).toEqual(["zeta@pasar"]);
  });

  test("entri pertama yang ada dipakai", async () => {
    const pertama = await buatPlugin("eta");
    const kedua = join(pluginsDir, "pasang", "eta-salin");
    await mkdir(kedua, { recursive: true });
    await tulisInstalled({
      "eta@pasar": [
        { scope: "user", installPath: join(root, "hilang") },
        { scope: "user", installPath: pertama },
        { scope: "user", installPath: kedua },
      ],
    });
    expect(listInstalledPlugins(home)[0]?.path).toBe(pertama);
  });

  test("daftar terurut menurut id dan dibatasi 100 plugin", async () => {
    const plugins: Record<string, unknown> = {};
    for (let index = 0; index < MAX_PLUGINS + 5; index += 1) {
      const installPath = await buatPlugin(`p${index}`);
      plugins[`p${index}@pasar`] = [{ scope: "user", installPath }];
    }
    await tulisInstalled(plugins);
    const daftar = listInstalledPlugins(home);
    expect(daftar).toHaveLength(MAX_PLUGINS);
    expect(daftar[0]?.id).toBe("p0@pasar");
  });
});

describe("enabledPluginPaths", () => {
  test("hanya plugin yang masih terpasang", async () => {
    const installPath = await buatPlugin("theta");
    await tulisInstalled({
      "theta@pasar": [{ scope: "user", installPath }],
    });

    expect(enabledPluginPaths(home, ["theta@pasar"])).toEqual([
      { id: "theta@pasar", path: installPath },
    ]);
    expect(enabledPluginPaths(home, ["hantu@pasar"])).toEqual([]);
    expect(enabledPluginPaths(home, [])).toEqual([]);
  });

  test("daftar kosong bila id tak diberikan", () => {
    expect(enabledPluginPaths(home, undefined)).toEqual([]);
  });
});
