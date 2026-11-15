import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserError,
  BrowserManager,
  type BrowserProcess,
  type DevToolsEndpoint,
  type KillProcess,
  type ReadCommandLine,
} from "../src/server/browser/browser-manager";
import type { CdpConnection } from "../src/server/browser/cdp-client";

/** Koneksi CDP palsu: cukup untuk attaching tab. */
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

/** Proses Chrome palsu yang tetap hidup sampai dibunuh. */
function prosesHidup(kejadian: string[], pid: number): BrowserProcess {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  return {
    pid,
    exited,
    kill: (signal?: number | NodeJS.Signals): void => {
      kejadian.push(`kill:${String(signal ?? "SIGTERM")}`);
      selesai(0);
    },
  };
}

/**
 * Proses Chrome palsu yang keluar seketika.
 *
 * `saatKeluar` dijalankan saat proses keluar (sebelum manajer memproses
 * keluarannya), dipakai untuk menyimulasikan proses lain yang menulis berkas
 * pid di saat yang sama.
 */
function prosesKeluar(
  kejadian: string[],
  pid: number,
  saatKeluar?: () => void,
): BrowserProcess {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  if (saatKeluar !== undefined) void exited.then(() => saatKeluar());
  queueMicrotask(() => selesai(0));
  return {
    pid,
    exited,
    kill: (signal?: number | NodeJS.Signals): void => {
      kejadian.push(`kill:${String(signal ?? "SIGTERM")}`);
      selesai(0);
    },
  };
}

interface Opsi {
  /** Pemeriksa proses hidup. */
  hidup?: (pid: number) => boolean;
  /** Pembaca baris perintah proses. */
  baris?: (pid: number) => string | undefined;
  /** Pembuat proses Chrome per percobaan (1 = pertama). */
  spawn?: (percobaan: number) => BrowserProcess;
  /** Pembaca port DevTools per percobaan. */
  port?: (percobaan: number) => DevToolsEndpoint | undefined;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-singleton-"));
  mkdirSync(join(dir, "browser-profile"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Folder profil browser Jejak di dalam folder sementara. */
function profilDir(): string {
  return join(dir, "browser-profile");
}

/** Buat symlink `SingletonLock` seperti yang dibuat Chrome. */
function tulisSingletonLock(pid: number): void {
  symlinkSync(`host-${pid}`, join(profilDir(), "SingletonLock"));
}

/** Buat manajer dengan fungsi eksternal yang dipalsukan. */
function buatManajer(
  kejadian: string[],
  opsi: Opsi = {},
): {
  manager: BrowserManager;
  dibunuh: Array<{ pid: number; signal?: number | NodeJS.Signals }>;
} {
  const dibunuh: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
  const sudahMati = new Set<number>();
  const hidup = opsi.hidup ?? (() => true);
  const baris = opsi.baris ?? (() => undefined);
  const readCommandLine: ReadCommandLine = (pid) => baris(pid);
  const killProcess: KillProcess = (pid, signal) => {
    dibunuh.push({ pid, signal });
    sudahMati.add(pid);
  };
  let percobaan = 0;
  const manager = new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => {
      percobaan += 1;
      if (opsi.spawn !== undefined) return opsi.spawn(percobaan);
      return prosesHidup(kejadian, 4200 + percobaan);
    },
    connect: async () => new KoneksiPalsu(kejadian),
    readDevToolsPort: () =>
      opsi.port === undefined
        ? { port: 9222, path: "/devtools/browser/abc" }
        : opsi.port(percobaan),
    readCommandLine,
    killProcess,
    isProcessAlive: (pid) => hidup(pid) && !sudahMati.has(pid),
  });
  return { manager, dibunuh };
}

describe("Chrome pemegang profil (SingletonLock)", () => {
  test("pemegang profil hidup yang baris perintahnya cocok dibunuh lalu browser menyala", async () => {
    const kejadian: string[] = [];
    const profil = profilDir();
    const { manager, dibunuh } = buatManajer(kejadian, {
      baris: (pid) =>
        pid === 9999 ? `/Applications/Chrome --user-data-dir=${profil} --headless=new` : undefined,
    });
    tulisSingletonLock(9999);
    await manager.ensure();
    expect(dibunuh.some((item) => item.pid === 9999)).toBe(true);
    // Berkas singleton usang dibersihkan.
    expect(existsSync(join(profil, "SingletonLock"))).toBe(false);
    expect(manager.state().status).toBe("menyala");
  });

  test("proses hidup yang bukan Chrome profil ini tidak dibunuh", async () => {
    const kejadian: string[] = [];
    const { manager, dibunuh } = buatManajer(kejadian, {
      baris: (pid) => (pid === 9999 ? "/usr/bin/program-lain --user-data-dir=/tmp/lain" : undefined),
    });
    tulisSingletonLock(9999);
    await manager.ensure();
    expect(dibunuh.some((item) => item.pid === 9999)).toBe(false);
  });

  test("singleton usang (pid mati) dibersihkan tanpa membunuh apa pun", async () => {
    const kejadian: string[] = [];
    const profil = profilDir();
    const { manager, dibunuh } = buatManajer(kejadian, {
      hidup: (pid) => pid !== 9999,
    });
    tulisSingletonLock(9999);
    writeFileSync(join(profil, "SingletonSocket"), "", "utf8");
    writeFileSync(join(profil, "SingletonCookie"), "", "utf8");
    await manager.ensure();
    expect(dibunuh.length).toBe(0);
    expect(existsSync(join(profil, "SingletonLock"))).toBe(false);
    expect(existsSync(join(profil, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(profil, "SingletonCookie"))).toBe(false);
  });
});

describe("Chrome berhenti sebelum siap", () => {
  test("percobaan pertama keluar sebelum port, percobaan kedua berhasil", async () => {
    const kejadian: string[] = [];
    const { manager } = buatManajer(kejadian, {
      spawn: (percobaan) =>
        percobaan === 1
          ? prosesKeluar(kejadian, 4242)
          : prosesHidup(kejadian, 4343),
      port: (percobaan) =>
        percobaan >= 2 ? { port: 9222, path: "/devtools/browser/abc" } : undefined,
    });
    await manager.ensure();
    expect(manager.state().status).toBe("menyala");
  });

  test("dua kali keluar lalu muncul galat yang jelas", async () => {
    const kejadian: string[] = [];
    const { manager } = buatManajer(kejadian, {
      spawn: (percobaan) => prosesKeluar(kejadian, 4200 + percobaan),
      port: () => undefined,
    });
    let galat: unknown;
    try {
      await manager.ensure();
    } catch (error) {
      galat = error;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).message).toBe("Chrome berhenti sebelum siap; coba lagi.");
  });

  test("berkas pid milik proses lain tak dihapus pada jalur keluar", async () => {
    const kejadian: string[] = [];
    const pidFile = join(profilDir(), "jejak-chrome.pid");
    const { manager } = buatManajer(kejadian, {
      hidup: (pid) => pid === 9999 || pid === 4242 || pid === 4343,
      spawn: (percobaan) =>
        prosesKeluar(kejadian, 4200 + percobaan, () => {
          // Proses lain menulis catatannya sendiri di saat yang sama.
          writeFileSync(pidFile, "9999\n", "utf8");
        }),
      port: () => undefined,
    });
    await expect(manager.ensure()).rejects.toThrow(BrowserError);
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf8").trim()).toBe("9999");
  });
});
