import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { SqliteAuditStore, type AuditEntry } from "../src/server/audit/audit-store";
import { claudeSettingPath, type LocateOptions } from "../src/server/sdk/claude-locator";
import { buildCliTarballUrl } from "../src/server/sdk/cli-install";
import { cliExecutableName, cliPlatform } from "../src/server/sdk/cli-store";
import { PACKUMENT_URL, buildTarballUrl } from "../src/server/sdk/registry";
import { computeIntegrity } from "../src/server/sdk/tarball";
import { buildTar, gzipOf, packageEntries, type TarInput } from "./helpers/tar-builder";

const NAMA = "@anthropic-ai/claude-agent-sdk";
const HOST = { host: "127.0.0.1:3000" };
const SANDI = "sandi-uji-123";

type App = ReturnType<typeof createApp>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let dir: string;
let home: string;
let root: string;
let providersFile: string;
let audit: SqliteAuditStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sdk-rute-"));
  home = join(dir, "home");
  root = join(dir, "sdk");
  providersFile = join(dir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({ profiles: [], activeProfileId: null }),
    "utf8",
  );
  audit = new SqliteAuditStore(":memory:");
});

afterEach(async () => {
  audit.close();
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helper */

function tarball(versi: string): Uint8Array {
  return gzipOf(buildTar(packageEntries(NAMA, versi)));
}

/** Tarball bermuatan symlink; integritas tetap cocok supaya penolakan datang dari ekstraksi. */
function tarballJahat(versi: string): Uint8Array {
  const gz = gzipOf(
    buildTar([
      ...packageEntries(NAMA, versi),
      { path: "package/jahat", type: "symlink", linkname: "/etc/passwd" },
    ]),
  );
  return gz;
}

function packument(
  versiList: string[],
  tag: string | null,
  sumber: (versi: string) => Uint8Array = tarball,
): string {
  const versions: Record<string, unknown> = {};
  for (const versi of versiList) {
    versions[versi] = {
      dist: {
        integrity: computeIntegrity(sumber(versi)),
        tarball: buildTarballUrl(versi),
        unpackedSize: 1234,
      },
    };
  }
  return JSON.stringify({
    "dist-tags": tag === null ? {} : { latest: tag },
    versions,
  });
}

type Handler = (call: FetchCall) => Response | Promise<Response>;

interface Harness {
  app: App;
  calls: FetchCall[];
}

/** Platform paket pendamping; null bila platform ini tidak didukung. */
const PLATFORM = cliPlatform();

/** Tarball CLI kecil: binary shell yang menjawab `--version`. */
function tarballCli(extra: TarInput[] = []): Uint8Array {
  const exe = PLATFORM === null ? "claude" : cliExecutableName(PLATFORM);
  return gzipOf(
    buildTar([
      { path: "package/", type: "dir" },
      { path: `package/${exe}`, data: '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', mode: 0o755 },
      { path: "package/package.json", data: "{}\n" },
      ...extra,
    ]),
  );
}

/** Metadata paket pendamping platform untuk satu versi. */
function metadataCli(versi: string): string {
  const plat = PLATFORM ?? "darwin-arm64";
  const os = plat.startsWith("win32") ? "win32" : "darwin";
  const cpu = plat === "darwin-arm64" ? "arm64" : "x64";
  return JSON.stringify({
    name: `@anthropic-ai/claude-agent-sdk-${plat}`,
    version: versi,
    os: [os],
    cpu: [cpu],
    dist: {
      integrity: computeIntegrity(tarballCli()),
      tarball: buildCliTarballUrl(plat as "darwin-arm64", versi),
      unpackedSize: 4321,
    },
  });
}

/** Aplikasi dengan `fetch` palsu; handler bawaan melayani packument dan tarball. */
function makeApp(
  options: {
    handler?: Handler;
    auth?: boolean;
    tanpaRoot?: boolean;
    locate?: Partial<LocateOptions>;
  } = {},
): Harness {
  const calls: FetchCall[] = [];
  const bawaan: Handler = (call) => {
    if (call.url === PACKUMENT_URL) {
      return new Response(packument(["0.3.1", "0.3.2"], "0.3.2"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const nama = call.url.split("/").pop() ?? "";
    if (nama.endsWith(".tgz")) {
      const tanpaTgz = nama.replace(/\.tgz$/, "");
      const versi = tanpaTgz.slice(tanpaTgz.lastIndexOf("-") + 1);
      if (PLATFORM !== null && nama.includes(`claude-agent-sdk-${PLATFORM}`)) {
        return new Response(tarballCli(), { status: 200 });
      }
      return new Response(tarball(versi), { status: 200 });
    }
    // Metadata paket pendamping platform.
    return new Response(metadataCli(nama), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const handler = options.handler ?? bawaan;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return await handler(call);
  }) as unknown as typeof fetch;

  // Pencarian CLI claude selalu palsu supaya tes tak menjalankan claude sungguhan.
  const locate: LocateOptions = {
    which: () => null,
    exists: async () => false,
    runVersion: async () => null,
    ...(options.locate ?? {}),
  };

  const base: CreateAppOptions = {
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    fetch: fake,
    audit,
    ...(options.tanpaRoot === true
      ? { sdk: { locate } }
      : { sdk: { root, locate } }),
    ...(options.auth === true ? { auth: { password: SANDI, port: 3000 } } : {}),
  };
  return { app: createApp(base), calls };
}

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }));
}

function post(
  app: App,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { ...HOST, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function isi(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function entriAudit(): Promise<AuditEntry[]> {
  return audit.list({ kind: "pengaturan" });
}

/** Daftar isi folder; folder yang belum ada berarti kosong. */
async function isiFolder(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------- tes */

describe("GET /api/sdk", () => {
  test("status kosong tanpa jaringan", async () => {
    const { app, calls } = makeApp();
    const res = await get(app, "/api/sdk");
    expect(res.status).toBe(200);
    const body = await isi(res);
    expect(body.installed).toBeNull();
    expect(body.previous).toBeNull();
    expect(body.supportedRange).toBe(">=0.3.0 <1");
    expect(body.lastCheck).toBeNull();
    expect(body.busy).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("menyertakan status CLI claude", async () => {
    const { app } = makeApp();
    const body = await isi(await get(app, "/api/sdk"));
    const claude = body.claude as {
      found: boolean;
      path: string | null;
      version: string | null;
      source: string | null;
      configuredPath: string | null;
    };
    expect(claude.found).toBe(false);
    expect(claude.path).toBeNull();
    expect(claude.version).toBeNull();
    expect(claude.source).toBeNull();
    expect(claude.configuredPath).toBeNull();
  });

  test("melaporkan CLI claude yang ditemukan beserta sumbernya", async () => {
    const { app } = makeApp({
      locate: { which: () => "/which/claude", exists: async () => true, runVersion: async () => "2.1.0" },
    });
    const body = await isi(await get(app, "/api/sdk"));
    const claude = body.claude as { found: boolean; path: string; source: string };
    expect(claude.found).toBe(true);
    expect(claude.path).toBe("/which/claude");
    expect(claude.source).toBe("path");
  });

  test("folder penyimpanan mengikuti JEJAK_HOME bila root tidak diberi", async () => {
    const { app } = makeApp({ tanpaRoot: true });
    const res = await post(app, "/api/sdk/install");
    expect(res.status).toBe(200);
    expect(existsSync(join(home, "sdk", "0.3.2", "package", "sdk.mjs"))).toBe(true);
  });
});

describe("POST /api/sdk/check", () => {
  test("menyimpan hasil pemeriksaan dan menjawab kandidat", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/check");
    expect(res.status).toBe(200);
    const body = await isi(res);
    expect(body.latest).toBe("0.3.2");
    expect(body.candidate).toBe("0.3.2");
    expect(body.installedVersion).toBeNull();
    expect(body.updateAvailable).toBe(false);
    expect(body.unpackedSize).toBe(1234);

    const status = await isi(await get(app, "/api/sdk"));
    const lastCheck = status.lastCheck as { latest: string; checkedAt: string };
    expect(lastCheck.latest).toBe("0.3.2");
    expect(typeof lastCheck.checkedAt).toBe("string");
  });

  test("versi terbaru di luar rentang menghasilkan catatan", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.1", "1.4.0"], "1.4.0"), { status: 200 });
      }
      return new Response(tarball("0.3.1"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    const body = await isi(await post(app, "/api/sdk/check"));
    expect(body.candidate).toBe("0.3.1");
    expect(String(body.note)).toContain("1.4.0");
  });

  test("registry mati dijawab 502", async () => {
    const handler: Handler = () => {
      throw new TypeError("jaringan mati");
    };
    const { app } = makeApp({ handler });
    const res = await post(app, "/api/sdk/check");
    expect(res.status).toBe(502);
    expect(String((await isi(res)).error)).toContain("registry npm");
  });
});

describe("POST /api/sdk/install", () => {
  test("pasang SDK dan menulis active.json", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/install");
    expect(res.status).toBe(200);
    const body = await isi(res);
    const installed = body.installed as { version: string; installedAt: string };
    expect(installed.version).toBe("0.3.2");
    expect(typeof installed.installedAt).toBe("string");
    expect(existsSync(join(root, "active.json"))).toBe(true);
    expect(existsSync(join(root, "0.3.2", "package", "sdk.mjs"))).toBe(true);

    const status = await isi(await get(app, "/api/sdk"));
    expect((status.installed as { version: string }).version).toBe("0.3.2");
  });

  test("pasang versi tertentu yang diminta", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/install", { version: "0.3.1" });
    expect(res.status).toBe(200);
    expect(((await isi(res)).installed as { version: string }).version).toBe("0.3.1");
  });

  test("integritas salah ditolak 422 dan tidak ada sisa berkas", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        // Integritas merujuk isi lain, jadi unduhan tidak cocok.
        return new Response(
          JSON.stringify({
            "dist-tags": { latest: "0.3.2" },
            versions: {
              "0.3.2": {
                dist: {
                  integrity: computeIntegrity(new TextEncoder().encode("beda")),
                  tarball: buildTarballUrl("0.3.2"),
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(tarball("0.3.2"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    const res = await post(app, "/api/sdk/install");
    expect(res.status).toBe(422);
    expect(String((await isi(res)).error)).toContain("Integritas");
    const isiRoot = await isiFolder(root);
    expect(isiRoot.filter((nama) => nama.startsWith(".tmp-"))).toEqual([]);
    expect(isiRoot.filter((nama) => nama === "0.3.2")).toEqual([]);
  });

  test("tarball bermuatan symlink ditolak 422", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(
          packument(["0.3.2"], "0.3.2", tarballJahat),
          { status: 200 },
        );
      }
      return new Response(tarballJahat("0.3.2"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    const res = await post(app, "/api/sdk/install");
    expect(res.status).toBe(422);
    const isiRoot = await isiFolder(root);
    expect(isiRoot.filter((nama) => nama.startsWith(".tmp-"))).toEqual([]);
    expect(isiRoot.filter((nama) => nama === "0.3.2")).toEqual([]);
  });

  test("field asing pada body ditolak 400", async () => {
    const { app, calls } = makeApp();
    const res = await post(app, "/api/sdk/install", { version: "0.3.2", url: "https://lain" });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("versi di luar rentang ditolak 400", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2", "1.0.0"], "0.3.2"), { status: 200 });
      }
      return new Response(tarball("0.3.2"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    const res = await post(app, "/api/sdk/install", { version: "1.0.0" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("rentang");
  });

  test("versi yang tidak ada di registry dijawab 404", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/install", { version: "0.9.9" });
    expect(res.status).toBe(404);
    expect(String((await isi(res)).error)).toContain("0.9.9");
  });

  test("registry mati dijawab 502", async () => {
    const handler: Handler = () => {
      throw new TypeError("jaringan mati");
    };
    const { app } = makeApp({ handler });
    const res = await post(app, "/api/sdk/install");
    expect(res.status).toBe(502);
  });

  test("dua pemasangan bersamaan: satu 409", async () => {
    let lepas: (() => void) | undefined;
    const tunggu = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    const handler: Handler = async (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2"], "0.3.2"), { status: 200 });
      }
      await tunggu;
      return new Response(tarball("0.3.2"), { status: 200 });
    };
    const { app, calls } = makeApp({ handler });

    const pertama = post(app, "/api/sdk/install");
    // Tunggu sampai unduhan tarball benar-benar dimulai.
    for (let i = 0; i < 200 && calls.length < 2; i += 1) {
      await Bun.sleep(5);
    }
    const kedua = await post(app, "/api/sdk/install");
    expect(kedua.status).toBe(409);
    expect(String((await isi(kedua)).error)).toContain("sedang berjalan");

    lepas?.();
    const hasil = await pertama;
    expect(hasil.status).toBe(200);
  });
});

describe("POST /api/sdk/rollback", () => {
  test("mengembalikan versi sebelumnya", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install", { version: "0.3.1" });
    await post(app, "/api/sdk/install", { version: "0.3.2" });

    const res = await post(app, "/api/sdk/rollback");
    expect(res.status).toBe(200);
    const installed = (await isi(res)).installed as { version: string };
    expect(installed.version).toBe("0.3.1");
  });

  test("tanpa versi sebelumnya dijawab 404", async () => {
    const { app } = makeApp();
    const kosong = await post(app, "/api/sdk/rollback");
    expect(kosong.status).toBe(404);

    await post(app, "/api/sdk/install");
    const kedua = await post(app, "/api/sdk/rollback");
    expect(kedua.status).toBe(404);
  });
});

describe("POST /api/sdk/claude-path", () => {
  test("menyimpan jalur absolut yang valid", async () => {
    const { app } = makeApp({
      locate: { exists: async () => true, runVersion: async () => "2.1.0 (Claude Code)" },
    });
    const res = await post(app, "/api/sdk/claude-path", { path: "/opt/claude" });
    expect(res.status).toBe(200);
    const claude = (await isi(res)) as {
      found: boolean;
      path: string | null;
      source: string | null;
      configuredPath: string | null;
    };
    expect(claude.found).toBe(true);
    expect(claude.path).toBe("/opt/claude");
    expect(claude.source).toBe("setting");
    expect(claude.configuredPath).toBe("/opt/claude");
    expect(existsSync(claudeSettingPath({ JEJAK_HOME: home }))).toBe(true);
  });

  test("null menghapus pengaturan", async () => {
    const { app } = makeApp({
      locate: { exists: async () => true, runVersion: async () => "2.1.0" },
    });
    await post(app, "/api/sdk/claude-path", { path: "/opt/claude" });
    const res = await post(app, "/api/sdk/claude-path", { path: null });
    expect(res.status).toBe(200);
    const claude = (await isi(res)) as { configuredPath: string | null };
    expect(claude.configuredPath).toBeNull();
    expect(existsSync(claudeSettingPath({ JEJAK_HOME: home }))).toBe(false);
  });

  test("string kosong menghapus pengaturan", async () => {
    const { app } = makeApp({
      locate: { exists: async () => true, runVersion: async () => "2.1.0" },
    });
    await post(app, "/api/sdk/claude-path", { path: "/opt/claude" });
    const res = await post(app, "/api/sdk/claude-path", { path: "  " });
    expect(res.status).toBe(200);
    expect(existsSync(claudeSettingPath({ JEJAK_HOME: home }))).toBe(false);
  });

  test("jalur relatif ditolak 400", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/claude-path", { path: "bin/claude" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("Jalur harus absolut");
  });

  test("berkas yang tidak ada ditolak 400", async () => {
    const { app } = makeApp({ locate: { exists: async () => false } });
    const res = await post(app, "/api/sdk/claude-path", { path: "/opt/claude" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("Berkas tidak ditemukan");
  });

  test("berkas yang tidak menjawab --version ditolak 400", async () => {
    const { app } = makeApp({
      locate: { exists: async () => true, runVersion: async () => null },
    });
    const res = await post(app, "/api/sdk/claude-path", { path: "/opt/claude" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("--version");
  });

  test("field asing ditolak 400", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/claude-path", { path: "/opt/claude", url: "https://lain" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("tidak dikenal");
  });

  test("audit mencatat aksi tanpa menyimpan jalur penuh", async () => {
    const { app } = makeApp({
      locate: { exists: async () => true, runVersion: async () => "2.1.0" },
    });
    await post(app, "/api/sdk/claude-path", { path: "/opt/claude-rahasia" });
    const entries = await entriAudit();
    const aksi = entries.find((entry) => entry.meta["aksi"] === "claude-jalur");
    expect(aksi?.meta["ok"]).toBe(true);
    expect(aksi?.meta["hasil"]).toBe("simpan");
    expect(JSON.stringify(entries)).not.toContain("/opt/claude-rahasia");
  });

  test("audit mencatat kegagalan dengan kode galat singkat", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/claude-path", { path: "bin/claude" });
    const entries = await entriAudit();
    const gagal = entries.find((entry) => entry.meta["aksi"] === "claude-jalur");
    expect(gagal?.meta["ok"]).toBe(false);
    expect(gagal?.meta["galat"]).toBe("invalid");
  });
});

describe("audit SDK", () => {
  test("mencatat aksi pemasangan tanpa isi unduhan atau SRI penuh", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    await post(app, "/api/sdk/check");
    await post(app, "/api/sdk/rollback");

    const entries = await entriAudit();
    const aksi = entries.map((entry) => entry.meta["aksi"]);
    expect(aksi).toContain("sdk-pasang");
    expect(aksi).toContain("sdk-periksa");
    expect(aksi).toContain("sdk-rollback");

    const pasang = entries.find((entry) => entry.meta["aksi"] === "sdk-pasang");
    expect(pasang?.meta["versi"]).toBe("0.3.2");
    expect(pasang?.meta["ok"]).toBe(true);
    expect(pasang?.meta["integritas"]).toBe(true);

    const mentah = JSON.stringify(entries);
    expect(mentah).not.toContain("sha512-");
    expect(mentah).not.toContain("export const query");
  });

  test("mencatat kegagalan pemasangan dengan kode galat singkat", async () => {
    const handler: Handler = () => {
      throw new TypeError("jaringan mati");
    };
    const { app } = makeApp({ handler });
    await post(app, "/api/sdk/install");
    const entries = await entriAudit();
    const gagal = entries.find((entry) => entry.meta["aksi"] === "sdk-pasang");
    expect(gagal?.meta["ok"]).toBe(false);
    expect(gagal?.meta["galat"]).toBe("network");
  });
});

describe("penjaga autentikasi", () => {
  test("tanpa cookie dijawab 401", async () => {
    const { app } = makeApp({ auth: true });
    expect((await get(app, "/api/sdk")).status).toBe(401);
    expect((await post(app, "/api/sdk/install")).status).toBe(401);
    expect((await post(app, "/api/sdk/check")).status).toBe(401);
  });
});

describe("GET /api/sdk dengan status CLI bawaan", () => {
  test("menyertakan platform, status terpasang, dan kemajuan", async () => {
    const { app } = makeApp();
    const body = await isi(await get(app, "/api/sdk"));
    const cli = body.cli as {
      platform: string | null;
      supported: boolean;
      installed: unknown;
      progress: unknown;
    };
    expect(cli.platform).toBe(PLATFORM);
    expect(cli.supported).toBe(PLATFORM !== null);
    expect(cli.installed).toBeNull();
    expect(cli.progress).toBeNull();
  });
});

describe("POST /api/sdk/check-cli", () => {
  test("ditolak 409 saat SDK belum terpasang", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/check-cli", {});
    expect(res.status).toBe(409);
    expect(String((await isi(res)).error)).toContain("Pasang SDK dulu");
  });

  test("field asing ditolak 400", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/check-cli", { version: "0.3.2" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("tidak dikenal");
  });

  test("berhasil mengembalikan metadata paket pendamping", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/check-cli", {});
    if (PLATFORM === null) {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status).toBe(200);
    const body = await isi(res);
    expect(body.version).toBe("0.3.2");
    expect(body.platform).toBe(PLATFORM);
    expect(body.unpackedSize).toBe(4321);
    expect(body.downloadSizeEstimate).toBeNull();
  });

  test("registry mati dijawab 502", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2"], "0.3.2"), { status: 200 });
      }
      if (call.url.endsWith(".tgz")) {
        return new Response(tarball("0.3.2"), { status: 200 });
      }
      throw new TypeError("jaringan mati");
    };
    const { app } = makeApp({ handler });
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/check-cli", {});
    expect(res.status).toBe(502);
  });

  test("paket/platform tak ada dijawab 404", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2"], "0.3.2"), { status: 200 });
      }
      if (call.url.endsWith(".tgz")) {
        return new Response(tarball("0.3.2"), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    const { app } = makeApp({ handler });
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/check-cli", {});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sdk/install-cli", () => {
  test("ditolak 409 saat SDK belum terpasang", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/install-cli", {});
    expect(res.status).toBe(409);
    expect(String((await isi(res)).error)).toContain("Pasang SDK dulu");
  });

  test("field asing ditolak 400", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/sdk/install-cli", { version: "0.3.2" });
    expect(res.status).toBe(400);
    expect(String((await isi(res)).error)).toContain("tidak dikenal");
  });

  test("memasang CLI dan melaporkan statusnya", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/install-cli", {});
    if (PLATFORM === null) {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status).toBe(200);
    const body = await isi(res);
    expect(body.ok).toBe(true);
    const cli = body.cli as { installed: { version: string; size: number } | null };
    expect(cli.installed?.version).toBe("0.3.2");
    expect(cli.installed?.size).toBeGreaterThan(0);
    const exe = PLATFORM === null ? "claude" : cliExecutableName(PLATFORM);
    expect(existsSync(join(root, "0.3.2", "cli", exe))).toBe(true);
  });

  test("arsip tidak aman ditolak 422 dan tak ada CLI terpasang", async () => {
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2"], "0.3.2"), { status: 200 });
      }
      if (call.url.endsWith(".tgz")) {
        if (PLATFORM !== null && call.url.includes(`claude-agent-sdk-${PLATFORM}`)) {
          return new Response(
            tarballCli([{ path: "package/aneh", type: "symlink", linkname: "/bin/sh" }]),
            { status: 200 },
          );
        }
        return new Response(tarball("0.3.2"), { status: 200 });
      }
      return new Response(metadataCli("0.3.2"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/install-cli", {});
    if (PLATFORM === null) {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status).toBe(422);
    expect(existsSync(join(root, "0.3.2", "cli"))).toBe(false);
  });

  test("pemasangan yang sedang berjalan dijawab 409", async () => {
    let lepas: (() => void) | undefined;
    const tertahan = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    const handler: Handler = (call) => {
      if (call.url === PACKUMENT_URL) {
        return new Response(packument(["0.3.2"], "0.3.2"), { status: 200 });
      }
      if (call.url.endsWith(".tgz")) {
        if (PLATFORM !== null && call.url.includes(`claude-agent-sdk-${PLATFORM}`)) {
          return tertahan.then(() => new Response(tarballCli(), { status: 200 }));
        }
        return new Response(tarball("0.3.2"), { status: 200 });
      }
      return new Response(metadataCli("0.3.2"), { status: 200 });
    };
    const { app } = makeApp({ handler });
    await post(app, "/api/sdk/install");

    const pertama = post(app, "/api/sdk/install-cli", {});
    await Bun.sleep(50);
    const kedua = await post(app, "/api/sdk/install-cli", {});
    expect(kedua.status).toBe(409);
    lepas?.();
    await pertama;
  });

  test("audit mencatat aksi cli-pasang tanpa jalur penuh", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    await post(app, "/api/sdk/install-cli", {});
    const entries = await entriAudit();
    const aksi = entries.find((entry) => entry.meta["aksi"] === "cli-pasang");
    expect(aksi?.meta["ok"]).toBe(true);
    expect(aksi?.meta["hasil"]).toBe("pasang");
    expect(aksi?.meta["versi"]).toBe("0.3.2");
    const mentah = JSON.stringify(entries);
    expect(mentah).not.toContain(root);
    expect(mentah).not.toContain("sha512-");
  });
});

describe("POST /api/sdk/remove-cli", () => {
  test("ditolak 404 saat belum ada CLI", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    const res = await post(app, "/api/sdk/remove-cli", {});
    expect(res.status).toBe(404);
  });

  test("menghapus CLI yang terpasang dan mencatat audit", async () => {
    const { app } = makeApp();
    await post(app, "/api/sdk/install");
    await post(app, "/api/sdk/install-cli", {});
    const res = await post(app, "/api/sdk/remove-cli", {});
    expect(res.status).toBe(200);
    const body = await isi(res);
    expect(body.ok).toBe(true);
    const cli = body.cli as { installed: unknown };
    expect(cli.installed).toBeNull();

    const entries = await entriAudit();
    const aksi = entries.find((entry) => entry.meta["aksi"] === "cli-hapus");
    expect(aksi?.meta["ok"]).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(root);
  });
});
