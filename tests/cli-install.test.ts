import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliInstallError,
  buildCliTarballUrl,
  getCliInstallProgress,
  installCli,
  type CliInstallProgress,
} from "../src/server/sdk/cli-install";
import { readCliStatus, resolveManagedCli } from "../src/server/sdk/cli-store";
import { installFromTarball, isInstallBusy } from "../src/server/sdk/sdk-store";
import { computeIntegrity } from "../src/server/sdk/tarball";
import { buildTar, gzipOf, packageEntries, type TarInput } from "./helpers/tar-builder";

const NAMA_SDK = "@anthropic-ai/claude-agent-sdk";
const VERSI = "0.3.323";
const PLAT = "darwin-arm64";
const OS_PLAT = "darwin";
const CPU_PLAT = "arm64";
const SCRIPT = '#!/bin/sh\necho "2.1.0 (Claude Code)"\n';

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-cli-"));
  root = join(dir, "sdk");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helper */

/** Arsip CLI accompani: binary kecil, package.json, lisensi, dan readme. */
function arsipCli(extra: TarInput[] = [], isiExe: string = SCRIPT): Uint8Array {
  return gzipOf(
    buildTar([
      { path: "package/", type: "dir" },
      { path: "package/claude", data: isiExe, mode: 0o755 },
      {
        path: "package/package.json",
        data: `${JSON.stringify({ name: `@anthropic-ai/claude-agent-sdk-${PLAT}`, version: VERSI })}\n`,
      },
      { path: "package/LICENSE.md", data: "lisensi\n" },
      { path: "package/README.md", data: "readme\n" },
      ...extra,
    ]),
  );
}

/** Metadata registry untuk paket pendamping platform. */
function metadata(
  gz: Uint8Array,
  ubah: (isi: Record<string, unknown>) => void = () => {},
): string {
  const isi: Record<string, unknown> = {
    name: `@anthropic-ai/claude-agent-sdk-${PLAT}`,
    version: VERSI,
    os: [OS_PLAT],
    cpu: [CPU_PLAT],
    dist: {
      integrity: computeIntegrity(gz),
      tarball: buildCliTarballUrl(PLAT as "darwin-arm64", VERSI),
      unpackedSize: 4096,
    },
  };
  ubah(isi);
  return JSON.stringify(isi);
}

interface FakeOptions {
  metadata?: (url: string) => Response;
  tarball?: (url: string) => Response;
}

/** `fetch` palsu:metadata dan tarball dilayani dari arsip kecil buatan. */
function buatFetch(opsi: FakeOptions = {}): typeof fetch {
  const gz = arsipCli();
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/-/")) {
      return opsi.tarball?.(url) ?? new Response(gz, { status: 200 });
    }
    return opsi.metadata?.(url) ?? new Response(metadata(gz), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Pasang SDK terkelola supaya CLI punya versi aktif untuk dipakai. */
async function pasangSdk(versi: string = VERSI): Promise<void> {
  const gz = gzipOf(buildTar(packageEntries(NAMA_SDK, versi)));
  await installFromTarball(root, {
    gz,
    integrity: computeIntegrity(gz),
    expected: { name: NAMA_SDK, version: versi },
    now: "2026-11-14T00:00:00.000Z",
  });
}

/** Nama berkas sementara yang tersisa di folder versi. */
async function sisaTemp(): Promise<string[]> {
  try {
    return (await readdir(join(root, VERSI))).filter((name) => name.startsWith(".cli-"));
  } catch {
    return [];
  }
}

/** Jalankan pemasangan dan kembalikan galatnya. */
async function galatInstall(
  opsi: Parameters<typeof installCli>[0],
): Promise<CliInstallError> {
  try {
    await installCli(opsi);
  } catch (error) {
    if (error instanceof CliInstallError) return error;
    throw error;
  }
  throw new Error("pemasangan tidak melempar");
}

/* -------------------------------------------------------------------- tes */

describe("installCli", () => {
  test("memasang CLI dan menulis metadata", async () => {
    await pasangSdk();
    const hasil = await installCli({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      now: () => "2026-11-14T01:00:00.000Z",
    });

    expect(hasil.version).toBe(VERSI);
    expect(hasil.platform).toBe(PLAT);
    expect(hasil.size).toBeGreaterThan(0);

    const dirCli = join(root, VERSI, "cli");
    expect(existsSync(join(dirCli, "claude"))).toBe(true);
    const meta = JSON.parse(await readFile(join(dirCli, "meta.json"), "utf8")) as {
      version: string;
      platform: string;
      installedAt: string;
      size: number;
    };
    expect(meta.version).toBe(VERSI);
    expect(meta.platform).toBe(PLAT);
    expect(meta.installedAt).toBe("2026-11-14T01:00:00.000Z");
    expect(meta.size).toBe(hasil.size);

    const info = await stat(join(dirCli, "claude"));
    expect(info.mode & 0o777).toBe(0o700);
    expect(await sisaTemp()).toEqual([]);
  });

  test("CLI terpasang bisa ditemukan resolver terkelola", async () => {
    await pasangSdk();
    await installCli({ root, version: VERSI, platform: PLAT, fetch: buatFetch() });

    const ditemukan = await resolveManagedCli(root);
    expect(ditemukan?.path).toBe(join(root, VERSI, "cli", "claude"));
    expect(ditemukan?.version).toBe(VERSI);

    const status = await readCliStatus(root);
    expect(status.installed?.version).toBe(VERSI);
  });

  test("platform tak didukung ditolak tanpa unduhan", async () => {
    await pasangSdk();
    let dipanggil = 0;
    const fetchPalsu = (async (): Promise<Response> => {
      dipanggil += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: "linux-x64",
      fetch: fetchPalsu,
    });
    expect(galat.code).toBe("unsupported");
    expect(dipanggil).toBe(0);
  });

  test("SDK belum terpasang ditolak", async () => {
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
    });
    expect(galat.code).toBe("no-sdk");
  });

  test("versi berbeda dari versi SDK aktif ditolak", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: "0.3.322",
      platform: PLAT,
      fetch: buatFetch(),
    });
    expect(galat.code).toBe("mismatch");
  });

  test("metadata dengan nama salah ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () =>
          new Response(metadata(gz, (isi) => {
            isi.name = "@anthropic-ai/claude-agent-sdk-darwin-x64";
          }), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("metadata");
    expect(await sisaTemp()).toEqual([]);
  });

  test("metadata dengan versi salah ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () =>
          new Response(metadata(gz, (isi) => {
            isi.version = "9.9.9";
          }), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("metadata");
  });

  test("metadata dengan os salah ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () =>
          new Response(metadata(gz, (isi) => {
            isi.os = ["win32"];
          }), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("metadata");
  });

  test("metadata dengan cpu salah ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () =>
          new Response(metadata(gz, (isi) => {
            isi.cpu = ["x64"];
          }), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("metadata");
  });

  test("pengalihan registry ditolak", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () => new Response("", { status: 302, headers: { location: "https://lain.example" } }),
      }),
    });
    expect(galat.code).toBe("redirect");
    expect(await sisaTemp()).toEqual([]);
  });

  test("integritas tidak cocok ditolak dan berkas sementara dihapus", async () => {
    await pasangSdk();
    const gz = arsipCli();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        metadata: () =>
          new Response(metadata(gz, (isi) => {
            const dist = isi.dist as { integrity: string };
            dist.integrity = computeIntegrity(new TextEncoder().encode("beda"));
          }), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("integrity");
    expect(await sisaTemp()).toEqual([]);
    expect(existsSync(join(root, VERSI, "cli"))).toBe(false);
  });

  test("batas unduhan terlampaui berhenti dan berkas sementara dihapus", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      limits: { maxDownload: 16 },
    });
    expect(galat.code).toBe("too-large");
    expect(await sisaTemp()).toEqual([]);
  });

  test("batas ukuran executable terlampaui", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      limits: { maxExecutable: 8 },
    });
    expect(galat.code).toBe("too-large");
    expect(existsSync(join(root, VERSI, "cli"))).toBe(false);
  });

  test("ukuran arsip yang tak cocok dengan header ditolak", async () => {
    await pasangSdk();
    const gz = gzipOf(
      buildTar([
        { path: "package/", type: "dir" },
        { path: "package/claude", data: SCRIPT, headerSize: 999_999 },
      ]),
    );
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("bad-archive");
  });

  test("entri symlink ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli([{ path: "package/claude.exe", type: "symlink", linkname: "/bin/sh" }]);
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("unsafe-entry");
  });

  test("entri hardlink ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli([{ path: "package/claude2", type: "hardlink", linkname: "package/claude" }]);
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("unsafe-entry");
  });

  test("nama berkas asing ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli([{ path: "package/rahasia.txt", data: "x" }]);
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("unsafe-entry");
    expect(existsSync(join(root, VERSI, "cli"))).toBe(false);
  });

  test("nama berkas keluar folder ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli([{ path: "package/../../keluar", data: "x" }]);
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("unsafe-entry");
  });

  test("nama berkas mutlak ditolak", async () => {
    await pasangSdk();
    const gz = arsipCli([{ path: "/etc/passwd", data: "x" }]);
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch({
        tarball: () => new Response(gz, { status: 200 }),
        metadata: () => new Response(metadata(gz), { status: 200 }),
      }),
    });
    expect(galat.code).toBe("unsafe-entry");
  });

  test("terlalu banyak entri ditolak", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      limits: { maxEntries: 2 },
    });
    expect(galat.code).toBe("unsafe-entry");
  });

  test("binary yang gagal menjawab --version ditolak dan tak ada CLI", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      runVersion: async () => null,
    });
    expect(galat.code).toBe("verify");
    expect(existsSync(join(root, VERSI, "cli"))).toBe(false);
    expect(await sisaTemp()).toEqual([]);
  });

  test("kegagalan pemasangan tidak merusak CLI lama", async () => {
    await pasangSdk();
    await installCli({ root, version: VERSI, platform: PLAT, fetch: buatFetch() });
    const metaLama = await readFile(join(root, VERSI, "cli", "meta.json"), "utf8");

    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      runVersion: async () => null,
    });
    expect(galat.code).toBe("verify");
    expect(existsSync(join(root, VERSI, "cli", "claude"))).toBe(true);
    expect(await readFile(join(root, VERSI, "cli", "meta.json"), "utf8")).toBe(metaLama);
  });

  test("ruang disk penuh dilaporkan sebagai galat disk", async () => {
    await pasangSdk();
    const galat = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      openWriteStream: () => ({
        write(_chunk, callback) {
          const error = new Error("disk penuh") as Error & { code: string };
          error.code = "ENOSPC";
          callback(error);
          return false;
        },
        end(callback) {
          callback();
        },
        on(event: string, listener: () => void) {
          if (event === "close") queueMicrotask(() => listener());
        },
        destroy() {
          // Tidak dipakai pada stream palsu.
        },
      }),
    });
    expect(galat.code).toBe("disk");
    expect(galat.message).toContain("Ruang disk tidak cukup");
    expect(await sisaTemp()).toEqual([]);
  });

  test("kemajuan unduhan dilaporkan", async () => {
    await pasangSdk();
    const laporan: CliInstallProgress[] = [];
    await installCli({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
      onProgress: (progress) => laporan.push(progress),
    });
    expect(laporan.length).toBeGreaterThan(0);
    expect(laporan[laporan.length - 1]?.received).toBeGreaterThan(0);
  });

  test("sisa pemasangan basi dibersihkan", async () => {
    await pasangSdk();
    const basi = join(root, VERSI, ".cli-lama");
    await mkdir(basi, { recursive: true });
    await writeFile(join(basi, "sisa.txt"), "x", "utf8");
    const lama = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(basi, lama, lama);

    await installCli({ root, version: VERSI, platform: PLAT, fetch: buatFetch() });
    expect(existsSync(basi)).toBe(false);
  });

  test("pemasangan kedua saat yang pertama berjalan ditolak", async () => {
    await pasangSdk();
    let lepas: (() => void) | undefined;
    const tertahan = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    const fetchTahan = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/-/")) {
        await tertahan;
        return new Response(arsipCli(), { status: 200 });
      }
      return new Response(metadata(arsipCli()), { status: 200 });
    }) as unknown as typeof fetch;

    const berjalan = installCli({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: fetchTahan,
    });
    await Bun.sleep(50);
    const kedua = await galatInstall({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: buatFetch(),
    });
    expect(kedua.code).toBe("busy");
    lepas?.();
    await berjalan;
  });
});

describe("kemajuan pemasangan yang terlihat dari luar", () => {
  test("kemajuan unduhan terbaca selama pemasangan berjalan", async () => {
    await pasangSdk();
    let lepas: (() => void) | undefined;
    const tertahan = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    const fetchTahan = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/-/")) {
        await tertahan;
        return new Response(arsipCli(), { status: 200 });
      }
      return new Response(metadata(arsipCli()), { status: 200 });
    }) as unknown as typeof fetch;

    const berjalan = installCli({
      root,
      version: VERSI,
      platform: PLAT,
      fetch: fetchTahan,
    });
    await Bun.sleep(50);
    const progress = getCliInstallProgress();
    expect(progress).not.toBeNull();
    expect(progress?.received).toBeGreaterThanOrEqual(0);
    expect(isInstallBusy()).toBe(true);

    lepas?.();
    await berjalan;
    expect(getCliInstallProgress()).toBeNull();
    expect(isInstallBusy()).toBe(false);
  });
});
