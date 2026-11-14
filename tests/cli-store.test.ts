import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCli } from "../src/server/sdk/cli-install";
import {
  cliExecutableName,
  cliPackageName,
  cliPlatform,
  readCliMeta,
  readCliStatus,
  removeCli,
  resolveManagedCli,
} from "../src/server/sdk/cli-store";
import { installFromTarball } from "../src/server/sdk/sdk-store";
import { computeIntegrity } from "../src/server/sdk/tarball";
import { buildTar, gzipOf, packageEntries } from "./helpers/tar-builder";

const NAMA_SDK = "@anthropic-ai/claude-agent-sdk";
const VERSI = "0.3.323";
const PLAT = "darwin-arm64";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-cli-store-"));
  root = join(dir, "sdk");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Pasang SDK terkelola untuk satu versi. */
async function pasangSdk(versi: string): Promise<void> {
  const gz = gzipOf(buildTar(packageEntries(NAMA_SDK, versi)));
  await installFromTarball(root, {
    gz,
    integrity: computeIntegrity(gz),
    expected: { name: NAMA_SDK, version: versi },
    now: "2026-11-14T00:00:00.000Z",
  });
}

/** Pasang CLI kecil untuk versi SDK yang sedang aktif. */
async function pasangCli(versi: string): Promise<void> {
  const gz = gzipOf(
    buildTar([
      { path: "package/", type: "dir" },
      { path: "package/claude", data: '#!/bin/sh\necho "2.1.0 (Claude Code)"\n' },
    ]),
  );
  const metadata = JSON.stringify({
    name: `@anthropic-ai/claude-agent-sdk-${PLAT}`,
    version: versi,
    os: ["darwin"],
    cpu: ["arm64"],
    dist: {
      integrity: computeIntegrity(gz),
      tarball: "https://registry.npmjs.org/x",
      unpackedSize: 100,
    },
  });
  const fetchPalsu = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/-/")) return new Response(gz, { status: 200 });
    return new Response(metadata, { status: 200 });
  }) as unknown as typeof fetch;

  await installCli({ root, version: versi, platform: PLAT, fetch: fetchPalsu });
}

describe("cliPlatform", () => {
  test("memetakan platform yang didukung", () => {
    expect(cliPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliPlatform("darwin", "x64")).toBe("darwin-x64");
    expect(cliPlatform("win32", "x64")).toBe("win32-x64");
  });

  test("platform lain tidak didukung", () => {
    expect(cliPlatform("linux", "x64")).toBeNull();
    expect(cliPlatform("win32", "arm64")).toBeNull();
    expect(cliPlatform("darwin", "ia32")).toBeNull();
  });
});

describe("cliExecutableName dan cliPackageName", () => {
  test("nama berkas mengikuti platform", () => {
    expect(cliExecutableName("darwin-arm64")).toBe("claude");
    expect(cliExecutableName("darwin-x64")).toBe("claude");
    expect(cliExecutableName("win32-x64")).toBe("claude.exe");
  });

  test("nama paket mengikuti platform", () => {
    expect(cliPackageName("darwin-arm64")).toBe(
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    );
  });
});

describe("resolveManagedCli", () => {
  test("menemukan CLI yang terpasang", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);

    const ditemukan = await resolveManagedCli(root);
    expect(ditemukan?.path).toBe(join(root, VERSI, "cli", "claude"));
    expect(ditemukan?.version).toBe(VERSI);
    expect(ditemukan?.platform).toBe(PLAT);
  });

  test("null bila SDK belum terpasang", async () => {
    expect(await resolveManagedCli(root)).toBeNull();
  });

  test("null bila metadata rusak", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    await writeFile(join(root, VERSI, "cli", "meta.json"), "{rusak", "utf8");
    expect(await resolveManagedCli(root)).toBeNull();
  });

  test("null bila metadata menyebut platform asing", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    const meta = JSON.parse(
      await readFile(join(root, VERSI, "cli", "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    meta.platform = "linux-x64";
    await writeFile(
      join(root, VERSI, "cli", "meta.json"),
      JSON.stringify(meta),
      "utf8",
    );
    expect(await resolveManagedCli(root)).toBeNull();
  });

  test("null bila binary tidak ada", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    await rm(join(root, VERSI, "cli", "claude"), { force: true });
    expect(await resolveManagedCli(root)).toBeNull();
  });

  test("null bila versi tidak cocok dengan versi aktif", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    await pasangSdk("0.3.322");
    expect(await resolveManagedCli(root)).toBeNull();
  });
});

describe("readCliStatus", () => {
  test("installed null bila belum ada CLI", async () => {
    await pasangSdk(VERSI);
    expect((await readCliStatus(root)).installed).toBeNull();
  });

  test("installed berisi versi, platform, tanggal, dan ukuran", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    const status = await readCliStatus(root);
    expect(status.installed?.version).toBe(VERSI);
    expect(status.installed?.platform).toBe(PLAT);
    expect(typeof status.installed?.installedAt).toBe("string");
    expect(status.installed?.size).toBeGreaterThan(0);
  });
});

describe("removeCli", () => {
  test("menghapus folder CLI dan melaporkannya sebagai tidak ada", async () => {
    await pasangSdk(VERSI);
    await pasangCli(VERSI);
    await removeCli(root, VERSI);
    expect(existsSync(join(root, VERSI, "cli"))).toBe(false);
    expect((await readCliStatus(root)).installed).toBeNull();
  });
});

describe("pemangkasan versi SDK", () => {
  test("versi lama yang dipangkas ikut membawa folder CLI-nya", async () => {
    await pasangSdk("0.3.321");
    await pasangCli("0.3.321");
    expect(existsSync(join(root, "0.3.321", "cli", "claude"))).toBe(true);

    await pasangSdk("0.3.322");
    await pasangSdk("0.3.323");

    expect(existsSync(join(root, "0.3.321"))).toBe(false);
    expect(existsSync(join(root, "0.3.321", "cli"))).toBe(false);
  });
});

describe("readCliMeta", () => {
  test("null untuk versi yang bukan semver", async () => {
    expect(await readCliMeta(root, "bukan-versi")).toBeNull();
  });
});
