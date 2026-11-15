import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserError,
  BrowserManager,
  type BrowserProcess,
} from "../src/server/browser/browser-manager";
import type { CdpConnection, CdpEventHandler } from "../src/server/browser/cdp-client";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-screenshot-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Proses Chrome palsu: tak pernah keluar sendiri. */
function prosesPalsu(): BrowserProcess {
  return {
    pid: 4242,
    exited: new Promise<number>(() => undefined),
    kill: (): void => undefined,
  };
}

/**
 * Koneksi CDP palsu yang mengatur hasil `Page.captureScreenshot`.
 *
 * Sifat data per mutu: `dataPerMutu` consulted dulu; bila tidak ada, pakai
 * `data` (bila ada) atau hasil bawaan yang kecil.
 */
class KoneksiScreenshot implements CdpConnection {
  readonly panggilan: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  /** Data per mutu JPEG; kunci adalah nilai `quality`. */
  dataPerMutu = new Map<number, string>();
  /** Data untuk semua mutu (bila `dataPerMutu` kosong). */
  data: string | undefined = "YmFzZTY0";
  /** Bila true, `Target.attachToTarget` gagal sehingga tak ada tab aktif. */
  tanpaTab = false;
  private readonly pendengar = new Map<string, Set<CdpEventHandler>>();

  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.panggilan.push({ method, params, sessionId });
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "T1", type: "page" }] };
      case "Target.attachToTarget":
        if (this.tanpaTab) throw new Error("tab tak bisa dipasang");
        return { sessionId: "S1" };
      case "Target.getTargetInfo":
        return { targetInfo: { url: "https://contoh.test/halaman", title: "Judul Halaman" } };
      case "Page.captureScreenshot": {
        const quality = (params as { quality?: number } | undefined)?.quality ?? 0;
        const perMutu = this.dataPerMutu.get(quality);
        const data = perMutu ?? this.data;
        if (data === undefined) return {};
        return { data };
      }
      default:
        return {};
    }
  }

  on(event: string, handler: CdpEventHandler, sessionId?: string): () => void {
    const key = sessionId === undefined ? event : `${event}@${sessionId}`;
    const set = this.pendengar.get(key) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.pendengar.set(key, set);
    return () => {
      set.delete(handler);
    };
  }

  close(): void {
    // Tak ada soket sungguhan.
  }

  /** Semua panggilan dengan metode tertentu. */
  calls(method: string): Array<{ method: string; params?: unknown; sessionId?: string }> {
    return this.panggilan.filter((call) => call.method === method);
  }

  /** Mutu JPEG pada setiap permintaan screenshot. */
  mutuScreenshot(): number[] {
    return this.calls("Page.captureScreenshot").map(
      (call) => (call.params as { quality?: number } | undefined)?.quality ?? 0,
    );
  }
}

/** Manajer browser dengan koneksi CDP palsu. */
function buatManager(koneksi: KoneksiScreenshot): BrowserManager {
  return new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => prosesPalsu(),
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
  });
}

describe("screenshot untuk agent", () => {
  test("mengirim Page.captureScreenshot dan mengembalikan gambar base64", async () => {
    const koneksi = new KoneksiScreenshot();
    const manager = buatManager(koneksi);
    try {
      const hasil = await manager.screenshotForAgent();
      expect(hasil.data).toBe("YmFzZTY0");
      expect(hasil.mimeType).toBe("image/jpeg");
      expect(hasil.width).toBe(1280);
      expect(hasil.height).toBe(800);
      expect(hasil.url).toBe("https://contoh.test/halaman");
      expect(hasil.title).toBe("Judul Halaman");
      expect(koneksi.mutuScreenshot()).toEqual([70]);
      const params = koneksi.calls("Page.captureScreenshot")[0]?.params as
        | { format?: string }
        | undefined;
      expect(params?.format).toBe("jpeg");
    } finally {
      await manager.close();
    }
  });

  test("gambar agent tetap ukuran logis: clip berskala 1/2", async () => {
    const koneksi = new KoneksiScreenshot();
    const manager = buatManager(koneksi);
    try {
      await manager.screenshotForAgent();
      const params = koneksi.calls("Page.captureScreenshot")[0]?.params as
        | { format?: string; quality?: number; clip?: Record<string, unknown> }
        | undefined;
      expect(params?.format).toBe("jpeg");
      // Mutu awal tetap 70 (bukan mutu screencast panel).
      expect(params?.quality).toBe(70);
      expect(params?.clip).toEqual({
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        scale: 0.5,
      });
    } finally {
      await manager.close();
    }
  });

  test("tak ada tab aktif: galat berbahasa Indonesia", async () => {
    const koneksi = new KoneksiScreenshot();
    koneksi.tanpaTab = true;
    const manager = buatManager(koneksi);
    try {
      await expect(manager.screenshotForAgent()).rejects.toBeInstanceOf(BrowserError);
      await expect(manager.screenshotForAgent()).rejects.toThrow(/tab browser aktif/);
    } finally {
      await manager.close();
    }
  });

  test("gambar terlalu besar: mutu diturunkan lalu berhasil", async () => {
    const koneksi = new KoneksiScreenshot();
    koneksi.dataPerMutu.set(70, "A".repeat(1_600_000));
    koneksi.dataPerMutu.set(45, "kecil");
    const manager = buatManager(koneksi);
    try {
      const hasil = await manager.screenshotForAgent();
      expect(hasil.data).toBe("kecil");
      expect(koneksi.mutuScreenshot()).toEqual([70, 45]);
    } finally {
      await manager.close();
    }
  });

  test("gambar tetap terlalu besar: galat setelah dua percobaan ulang", async () => {
    const koneksi = new KoneksiScreenshot();
    koneksi.data = "A".repeat(1_600_000);
    const manager = buatManager(koneksi);
    try {
      await expect(manager.screenshotForAgent()).rejects.toThrow(/terlalu besar/);
      expect(koneksi.mutuScreenshot()).toEqual([70, 45, 30]);
    } finally {
      await manager.close();
    }
  });

  test("jalur sendiri: alur screencast panel tak dijalankan", async () => {
    const koneksi = new KoneksiScreenshot();
    const manager = buatManager(koneksi);
    try {
      await manager.screenshotForAgent();
      // Panel hanya memakai screencast bila ada pendengar frame.
      expect(koneksi.calls("Page.startScreencast")).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });
});
