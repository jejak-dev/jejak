import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { FileClaudeConfigStore } from "../src/server/claude-config/config-store";
import type {
  PluginCommandResult,
  PluginInstaller,
} from "../src/server/claude-config/plugin-installer";

let root: string;
let home: string;
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-market-rute-")));
  home = join(root, "rumah");
  await mkdir(join(home, ".claude", "plugins", "marketplaces", "valid", ".claude-plugin"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".claude", "plugins", "marketplaces", "valid", ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "valid",
      description: "Katalog contoh",
      plugins: [
        { name: "alpha", description: "Plugin alpha", category: "development", source: "./a" },
        { name: "beta", description: "Plugin beta", category: "security", source: { source: "url" } },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({
      valid: {
        source: { source: "github", repo: "contoh/valid" },
        installLocation: join(home, ".claude", "plugins", "marketplaces", "valid"),
        lastUpdated: "2026-01-02T03:04:05.000Z",
      },
    }),
    "utf8",
  );
});

afterEach(async () => {
  for (const store of audits) store.close();
  audits = [];
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

interface Opsi {
  installer?: PluginInstaller;
  audit?: AuditStore;
  tanpaStore?: boolean;
  matikan?: boolean;
}

function setup(options: Opsi = {}): App {
  const store = options.tanpaStore === true ? undefined : new FileClaudeConfigStore(":memory:");
  const env: Record<string, string | undefined> = {
    MOCK: "true",
    JEJAK_HOME: join(root, "jejak-home"),
  };
  if (options.matikan === true) env.JEJAK_CLAUDE_CONFIG = "0";
  return createApp({
    env,
    ...(store === undefined ? {} : { claudeConfig: store }),
    ...(options.installer === undefined ? {} : { pluginInstaller: options.installer }),
    home,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function entries(store: AuditStore): AuditEntry[] {
  return store.list({ kind: "pengaturan", limit: 200 });
}

/** Pemasang tiruan: mencatat panggilan dan menulis daftar plugin terpasang. */
function installerPalsu(
  hasil: PluginCommandResult,
  pasang: { id: string; nama: string } | null = null,
): PluginInstaller & { calls: string[] } {
  const calls: string[] = [];
  const tulis = async (id: string): Promise<void> => {
    if (pasang === null || pasang.id !== id) return;
    const installPath = join(home, ".claude", "plugins", "pasang", pasang.nama);
    await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(installPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: pasang.nama }),
      "utf8",
    );
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { [id]: [{ scope: "user", installPath }] },
      }),
      "utf8",
    );
  };
  return {
    calls,
    install: async (id) => {
      calls.push(`install:${id}`);
      if (hasil.ok) await tulis(id);
      return hasil;
    },
    uninstall: async (id) => {
      calls.push(`uninstall:${id}`);
      if (hasil.ok) await tulis(id);
      return hasil;
    },
  };
}

describe("rute marketplace dan pemasangan plugin", () => {
  test("GET daftar marketplace", async () => {
    const app = setup();
    const body = await json(await req(app, "GET", "/api/claude/marketplaces"));
    expect(body.marketplaces).toEqual([
      {
        name: "valid",
        description: "Katalog contoh",
        pluginCount: 2,
        lastUpdated: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });

  test("GET pencarian plugin dengan penyaring", async () => {
    const app = setup();
    const semua = await json(await req(app, "GET", "/api/claude/marketplace/plugins"));
    expect(semua.total).toBe(2);
    expect(semua.categories).toEqual(["development", "security"]);

    const query = await json(
      await req(app, "GET", "/api/claude/marketplace/plugins?query=beta"),
    );
    const items = query.items as Array<{ name: string }>;
    expect(items.map((item) => item.name)).toEqual(["beta"]);

    const kategori = await json(
      await req(app, "GET", "/api/claude/marketplace/plugins?category=development"),
    );
    expect((kategori.items as Array<{ name: string }>).map((item) => item.name)).toEqual(["alpha"]);

    const halaman = await json(
      await req(app, "GET", "/api/claude/marketplace/plugins?limit=1&offset=1"),
    );
    expect(halaman.total).toBe(2);
    expect((halaman.items as Array<{ name: string }>).map((item) => item.name)).toEqual(["beta"]);
  });

  test("GET 400 untuk parameter tak valid", async () => {
    const app = setup();
    for (const path of [
      "/api/claude/marketplace/plugins?limit=abc",
      "/api/claude/marketplace/plugins?offset=-1",
      "/api/claude/marketplace/plugins?query=" + "x".repeat(101),
      "/api/claude/marketplace/plugins?marketplace=nama!salah",
    ]) {
      expect((await req(app, "GET", path)).status).toBe(400);
    }
  });

  test("POST install berhasil dan plugin tercatat", async () => {
    const audit = auditStore();
    const installer = installerPalsu({ ok: true, message: "Terpasang." }, {
      id: "alpha@valid",
      nama: "alpha",
    });
    const app = setup({ installer, audit });

    const res = await req(app, "POST", "/api/claude/plugins/install", { id: "alpha@valid" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Terpasang.");
    expect(body.plugin).toMatchObject({ id: "alpha@valid", name: "alpha" });
    expect(installer.calls).toEqual(["install:alpha@valid"]);

    const auditEntries = entries(audit);
    expect(auditEntries.map((entry) => entry.summary)).toContain("Plugin dipasang");
    const catat = auditEntries.find((entry) => entry.summary === "Plugin dipasang");
    expect(catat?.meta).toMatchObject({ aksi: "pasang-plugin", plugin: "alpha@valid" });
  });

  test("POST install gagal dari CLI tetap 200 dengan ok false", async () => {
    const audit = auditStore();
    const installer = installerPalsu({ ok: false, message: "CLI gagal." });
    const app = setup({ installer, audit });

    const res = await req(app, "POST", "/api/claude/plugins/install", { id: "alpha@valid" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.message).toBe("CLI gagal.");
    expect(entries(audit).map((entry) => entry.summary)).toContain("Pemasangan plugin gagal");
  });

  test("POST install 400 untuk id buruk dan body asing", async () => {
    const installer = installerPalsu({ ok: true, message: "ok" });
    const app = setup({ installer });
    for (const body of [{ id: "tanpa-pasar" }, { id: 1 }, {}, { id: "alpha@valid", lain: 1 }]) {
      expect((await req(app, "POST", "/api/claude/plugins/install", body)).status).toBe(400);
    }
    expect(installer.calls).toEqual([]);
  });

  test("POST install 404 untuk id yang tak ada di katalog", async () => {
    const installer = installerPalsu({ ok: true, message: "ok" });
    const app = setup({ installer });
    const res = await req(app, "POST", "/api/claude/plugins/install", { id: "hantu@valid" });
    expect(res.status).toBe(404);
    expect(installer.calls).toEqual([]);
  });

  test("POST install 503 tanpa store atau tanpa installer", async () => {
    const tanpaStore = setup({ tanpaStore: true });
    const res = await tanpaStore.handle(
      new Request("http://127.0.0.1:3000/api/claude/plugins/install", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({ id: "alpha@valid" }),
      }),
    );
    expect(res.status).toBe(503);

    const matikan = setup({ matikan: true });
    const res2 = await req(matikan, "POST", "/api/claude/plugins/install", { id: "alpha@valid" });
    expect(res2.status).toBe(503);
    expect(await json(res2)).toEqual({ error: "Pemasangan plugin tidak tersedia." });
  });

  test("POST uninstall mematikan saklar plugin dan mencatat audit", async () => {
    const audit = auditStore();
    const store = new FileClaudeConfigStore(":memory:");
    const installer = installerPalsu({ ok: true, message: "Dicopot." }, {
      id: "alpha@valid",
      nama: "alpha",
    });
    const app = createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      claudeConfig: store,
      pluginInstaller: installer,
      home,
      audit,
    });

    // Pasang dulu plugin dan nyalakan saklarnya.
    await req(app, "POST", "/api/claude/plugins/install", { id: "alpha@valid" });
    await req(app, "PUT", "/api/claude/plugins/alpha@valid", { enabled: true });
    expect(store.get().enabledPlugins).toContain("alpha@valid");

    const res = await req(app, "POST", "/api/claude/plugins/uninstall", { id: "alpha@valid" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Dicopot.");
    expect(store.get().enabledPlugins).not.toContain("alpha@valid");
    expect(installer.calls).toContain("uninstall:alpha@valid");

    const auditEntries = entries(audit);
    expect(auditEntries.map((entry) => entry.summary)).toContain("Plugin dicopot");
    const catat = auditEntries.find((entry) => entry.summary === "Plugin dicopot");
    expect(catat?.meta).toMatchObject({ aksi: "copot-plugin", plugin: "alpha@valid" });
  });

  test("POST uninstall 404 untuk plugin yang tak terpasang", async () => {
    const installer = installerPalsu({ ok: true, message: "ok" });
    const app = setup({ installer });
    const res = await req(app, "POST", "/api/claude/plugins/uninstall", { id: "alpha@valid" });
    expect(res.status).toBe(404);
    expect(installer.calls).toEqual([]);
  });
});
