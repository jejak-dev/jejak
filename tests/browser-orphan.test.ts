import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserManager,
  type BrowserProcess,
  type KillProcess,
  type ReadCommandLine,
} from "../src/server/browser/browser-manager";
import type { CdpConnection } from "../src/server/browser/cdp-client";

/** Koneksi CDP palsu: mencatat urutan kejadian. */
class KoneksiPalsu implements CdpConnection {
  constructor(private readonly kejadian: string[]) {}

  async send(method: string): Promise<unknown> {
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "T1", type: "page" }] };
    if (method === "Target.attachToTarget") return { sessionId: "S1" };
    if (method === "Target.getTargetInfo") return { targetInfo: { url: "about:blank", title: "" } };
    return {};
  }

  on(): () => void {
    return () => undefined;
  }

  close(): void {
    this.kejadian.push("koneksi-tutup");
  }
}

/** Proses Chrome palsu: mencatat sinyal yang diterima. */
function prosesPalsu(
  kejadian: string[],
  pid = 4242,
): BrowserProcess & { jumlahKill: number } {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  const proses = {
    pid,
    exited,
    jumlahKill: 0,
    kill: (signal?: number | NodeJS.Signals): void => {
      proses.jumlahKill += 1;
      kejadian.push(`kill:${String(signal ?? "SIGTERM")}`);
      selesai(0);
    },
  };
  return proses;
}

interface Opsi {
  /** PID proses yatim masih hidup? */
  hidup?: boolean;
  /** Baris perintah proses yatim. */
  baris?: string;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-orphan-"));
  mkdirSync(join(dir, "browser-profile"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Buat manajer dengan fungsi eksternal yang dipalsukan. */
function buatManajer(
  kejadian: string[],
  opsi: Opsi = {},
): {
  manager: BrowserManager;
  proses: ReturnType<typeof prosesPalsu>;
  dibunuh: Array<{ pid: number; signal?: number | NodeJS.Signals }>;
} {
  const proses = prosesPalsu(kejadian);
  const dibunuh: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
  const sudahMati = new Set<number>();
  const readCommandLine: ReadCommandLine = () =>
    opsi.baris === undefined ? undefined : opsi.baris;
  const killProcess: KillProcess = (pid, signal) => {
    dibunuh.push({ pid, signal });
    sudahMati.add(pid);
  };
  const manager = new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => proses,
    connect: async () => new KoneksiPalsu(kejadian),
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
    readCommandLine,
    killProcess,
    isProcessAlive: (pid) => (opsi.hidup ?? true) && !sudahMati.has(pid),
  });
  return { manager, proses, dibunuh };
}

/** Tulis berkas pid dan port DevTools usang di dalam profil. */
function tulisBerkasUsang(pid: number): void {
  const profil = join(dir, "browser-profile");
  writeFileSync(join(profil, "jejak-chrome.pid"), `${pid}\n`, "utf8");
  writeFileSync(join(profil, "DevToolsActivePort"), "1234\n/devtools/browser/lama\n", "utf8");
}

describe("killSync", () => {
  test("mematikan proses Chrome seketika dan aman dipanggil berulang", async () => {
    const kejadian: string[] = [];
    const { manager, proses } = buatManajer(kejadian);
    await manager.ensure();
    manager.killSync();
    expect(proses.jumlahKill).toBe(1);
    expect(kejadian).toContain("kill:SIGTERM");
    // Panggilan kedua tak melempar galat.
    manager.killSync();
    expect(proses.jumlahKill).toBe(2);
  });

  test("aman dipanggil saat tak ada proses", () => {
    const kejadian: string[] = [];
    const { manager } = buatManajer(kejadian);
    expect(() => manager.killSync()).not.toThrow();
  });

  test("close() memanggil killSync lebih dulu sebelum langkah lain", async () => {
    const kejadian: string[] = [];
    const { manager } = buatManajer(kejadian);
    await manager.ensure();
    kejadian.length = 0;
    await manager.close();
    expect(kejadian[0]).toBe("kill:SIGTERM");
    expect(kejadian.indexOf("kill:SIGTERM")).toBeLessThan(
      kejadian.indexOf("koneksi-tutup"),
    );
  });
});

describe("Chrome yatim", () => {
  test("proses yatim dengan path profil cocok dibunuh", async () => {
    const kejadian: string[] = [];
    const profil = join(dir, "browser-profile");
    const { manager, dibunuh } = buatManajer(kejadian, {
      hidup: true,
      baris: `/Applications/Chrome --user-data-dir=${profil} --headless=new`,
    });
    tulisBerkasUsang(9999);
    await manager.ensure();
    expect(dibunuh.length).toBe(1);
    expect(dibunuh[0]?.pid).toBe(9999);
    // Port DevTools usang dihapus sebelum Chrome baru dijalankan.
    expect(existsSync(join(profil, "DevToolsActivePort"))).toBe(false);
  });

  test("pid hidup tapi baris perintah tak cocok tidak dibunuh", async () => {
    const kejadian: string[] = [];
    const { manager, dibunuh } = buatManajer(kejadian, {
      hidup: true,
      baris: "/usr/bin/some-other-program --user-data-dir=/tmp/lain",
    });
    tulisBerkasUsang(9999);
    await manager.ensure();
    expect(dibunuh.length).toBe(0);
  });

  test("berkas pid usang (proses mati) dihapus", async () => {
    const kejadian: string[] = [];
    const profil = join(dir, "browser-profile");
    const { manager, dibunuh } = buatManajer(kejadian, { hidup: false });
    tulisBerkasUsang(9999);
    await manager.ensure();
    expect(dibunuh.length).toBe(0);
    expect(existsSync(join(profil, "DevToolsActivePort"))).toBe(false);
    // Berkas pid menunjuk proses baru, bukan pid usang.
    const isi = readFileSync(join(profil, "jejak-chrome.pid"), "utf8").trim();
    expect(isi).toBe("4242");
  });

  test("berkas pid ditulis saat Chrome dijalankan dan dihapus saat ditutup", async () => {
    const kejadian: string[] = [];
    const profil = join(dir, "browser-profile");
    const { manager } = buatManajer(kejadian);
    await manager.ensure();
    expect(readFileSync(join(profil, "jejak-chrome.pid"), "utf8").trim()).toBe("4242");
    await manager.close();
    expect(existsSync(join(profil, "jejak-chrome.pid"))).toBe(false);
  });
});
