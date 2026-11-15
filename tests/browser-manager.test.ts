import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserError } from "../src/server/browser/browser-error";
import type { CdpConnection, CdpEventHandler } from "../src/server/browser/cdp-client";
import {
  BrowserManager,
  normalizeBrowserUrl,
  type BrowserFrame,
  type BrowserProcess,
  type BrowserState,
} from "../src/server/browser/browser-manager";

/** Koneksi CDP palsu: mencatat perintah dan menyiarkan peristiwa. */
class KoneksiPalsu implements CdpConnection {
  readonly panggilan: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  url = "about:blank";
  judul = "";
  tertutup = false;
  /** Data yang dikembalikan `Page.captureScreenshot`. */
  dataScreenshot = "YmVuaWgtMSA==";
  /** Bila true, `Page.captureScreenshot` tak pernah selesai. */
  tahanScreenshot = false;
  private readonly pendengar = new Map<string, Set<CdpEventHandler>>();

  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.panggilan.push({ method, params, sessionId });
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "T1", type: "page" }] };
      case "Target.attachToTarget":
        return { sessionId: "S1" };
      case "Target.createTarget":
        return { targetId: "T2" };
      case "Target.getTargetInfo":
        return { targetInfo: { url: this.url, title: this.judul } };
      case "Page.navigate":
        this.url = (params as { url?: string } | undefined)?.url ?? "";
        return { frameId: "F1" };
      case "Page.captureScreenshot":
        if (this.tahanScreenshot) return new Promise<never>(() => undefined);
        return { data: this.dataScreenshot };
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      default:
        return {};
    }
  }

  on(event: string, handler: CdpEventHandler, sessionId?: string): () => void {
    const key = sessionId === undefined ? event : `${event}@${sessionId}`;
    const set = this.pendengar.get(key) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.pendengar.set(key, set);
    return () => set.delete(handler);
  }

  close(): void {
    this.tertutup = true;
  }

  /** Sambungkan peristiwa ke pendengar yang cocok. */
  emit(event: string, params: unknown, sessionId?: string): void {
    for (const handler of this.pendengar.get(event) ?? []) handler(params, sessionId);
    if (sessionId !== undefined) {
      for (const handler of this.pendengar.get(`${event}@${sessionId}`) ?? []) {
        handler(params, sessionId);
      }
    }
  }

  /** Semua panggilan dengan metode tertentu. */
  calls(method: string): Array<{ method: string; params?: unknown; sessionId?: string }> {
    return this.panggilan.filter((call) => call.method === method);
  }
}

/** Proses Chrome palsu: bisa dibunuh dan "mati sendiri". */
function prosesPalsu(): BrowserProcess & { mati: () => void; jumlahKill: number } {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  const proses = {
    pid: 4242,
    exited,
    jumlahKill: 0,
    kill: (): void => {
      proses.jumlahKill += 1;
      selesai(0);
    },
    mati: (): void => {
      selesai(0);
    },
  };
  return proses;
}

interface Setup {
  manager: BrowserManager;
  koneksi: KoneksiPalsu;
  proses: Array<ReturnType<typeof prosesPalsu>>;
  jumlahSpawn: () => number;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(
  options: {
    adaChrome?: boolean;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
    idleScreenshotMs?: number;
  } = {},
): Setup {
  const koneksi = new KoneksiPalsu();
  const proses: Array<ReturnType<typeof prosesPalsu>> = [];
  let jumlahSpawn = 0;
  const manager = new BrowserManager({
    env: {
      JEJAK_HOME: dir,
      ...(options.adaChrome === false ? {} : { JEJAK_CHROME_PATH: "/fake/chrome" }),
    },
    platform: "linux",
    exists: (path) => options.adaChrome !== false && path === "/fake/chrome",
    spawn: () => {
      jumlahSpawn += 1;
      const dibuat = prosesPalsu();
      proses.push(dibuat);
      return dibuat;
    },
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
    now: options.now,
    schedule: options.schedule,
    idleScreenshotMs: options.idleScreenshotMs,
  });
  return { manager, koneksi, proses, jumlahSpawn: () => jumlahSpawn };
}

/** Jam palsu: waktu hanya maju saat diminta. */
function jamPalsu(): { now: () => number; maju: (ms: number) => void } {
  let waktu = 1_000;
  return {
    now: () => waktu,
    maju: (ms: number) => {
      waktu += ms;
    },
  };
}

/** Penjadwac palsu: detak hanya jalan saat dipicu manual. */
function penjadwacPalsu(): {
  schedule: (callback: () => void, delayMs: number) => () => void;
  pemicu: () => Promise<void>;
  pemicuPaksa: () => Promise<void>;
  tertunda: () => number;
} {
  const antrean: Array<{ callback: () => void; delayMs: number }> = [];
  let terakhir: (() => void) | undefined;
  return {
    schedule: (callback, delayMs) => {
      const item = { callback, delayMs };
      antrean.push(item);
      terakhir = callback;
      return () => {
        const index = antrean.indexOf(item);
        if (index >= 0) antrean.splice(index, 1);
      };
    },
    pemicu: async () => {
      const item = antrean.shift();
      item?.callback();
      await Bun.sleep(1);
    },
    pemicuPaksa: async () => {
      terakhir?.();
      await Bun.sleep(1);
    },
    tertunda: () => antrean.length,
  };
}

describe("normalizeBrowserUrl", () => {
  test("menerima http dan https apa adanya", () => {
    expect(normalizeBrowserUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("http://localhost:3000/halaman")).toBe(
      "http://localhost:3000/halaman",
    );
  });

  test("menambah skema untuk host lokal dan host biasa", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
  });

  test("menerima about:blank persis", () => {
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
  });

  test("menolak skema berbahaya", () => {
    const bahaya = [
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,<b>hai</b>",
      "view-source:https://example.com",
      "ftp://example.com",
    ];
    for (const url of bahaya) {
      let galat: unknown;
      try {
        normalizeBrowserUrl(url);
      } catch (caught) {
        galat = caught;
      }
      expect(galat).toBeInstanceOf(BrowserError);
      expect((galat as BrowserError).code).toBe("tidak-valid");
    }
  });

  test("menolak masukan yang bukan URL", () => {
    for (const url of ["", "   ", "halo dunia", 42, null]) {
      expect(() => normalizeBrowserUrl(url)).toThrow(BrowserError);
    }
  });
});

describe("BrowserManager", () => {
  test("start() malas: state tidak Repliesan Chrome", async () => {
    const { manager, jumlahSpawn } = setup();
    expect(manager.state().status).toBe("mati");
    expect(jumlahSpawn()).toBe(0);
    await manager.ensure();
    expect(jumlahSpawn()).toBe(1);
    expect(manager.state().status).toBe("menyala");
    await manager.ensure();
    expect(jumlahSpawn()).toBe(1);
    await manager.close();
  });

  test("Chrome tak ada -> galat tidak-ditemukan", async () => {
    const { manager } = setup({ adaChrome: false });
    let galat: unknown;
    try {
      await manager.ensure();
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-ditemukan");
    expect((galat as BrowserError).message).toBe(
      "Chrome atau Chromium tidak ditemukan. Pasang Google Chrome atau set JEJAK_CHROME_PATH.",
    );
  });

  test("navigate menormalkan URL dan mengirim Page.navigate", async () => {
    const { manager, koneksi } = setup();
    const state = await manager.navigate("example.com");
    expect(state.status).toBe("menyala");
    expect(state.url).toBe("https://example.com/");
    const panggilan = koneksi.calls("Page.navigate");
    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]?.params).toEqual({ url: "https://example.com/" });
    expect(panggilan[0]?.sessionId).toBe("S1");
    await manager.close();
  });

  test("navigate menolak skema berbahaya tanpa Repliesan Chrome", async () => {
    const { manager, jumlahSpawn } = setup();
    await expect(manager.navigate("javascript:alert(1)")).rejects.toBeInstanceOf(BrowserError);
    expect(jumlahSpawn()).toBe(0);
  });

  test("screencast mulai saat pelanggan pertama dan berhenti saat terakhir pergi", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const unsubscribe = manager.subscribe(() => undefined);
    await Bun.sleep(1);
    const mulai = koneksi.calls("Page.startScreencast");
    expect(mulai).toHaveLength(1);
    expect(mulai[0]?.params).toEqual({
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
    });
    expect(mulai[0]?.sessionId).toBe("S1");
    unsubscribe();
    await Bun.sleep(1);
    expect(koneksi.calls("Page.stopScreencast")).toHaveLength(1);
    await manager.close();
  });

  test("frame di-ack dan diteruskan ke pelanggan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const diterima: BrowserFrame[] = [];
    manager.subscribe((frame) => {
      diterima.push(frame);
    });
    await Bun.sleep(1);
    koneksi.emit("Page.screencastFrame", {
      data: "aW1n",
      sessionId: 7,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    }, "S1");
    await Bun.sleep(1);
    // Frame pertama adalah benih screenshot, berikutnya frame screencast.
    expect(diterima).toHaveLength(2);
    expect(diterima[1]?.data).toBe("aW1n");
    expect(diterima[1]?.width).toBe(1280);
    expect(diterima[1]?.height).toBe(800);
    const ack = koneksi.calls("Page.screencastFrameAck");
    expect(ack).toHaveLength(1);
    expect(ack[0]?.params).toEqual({ sessionId: 7 });
    await manager.close();
  });

  test("frame terakhir dikirim ke pelanggan baru", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    manager.subscribe(() => undefined);
    await Bun.sleep(1);
    koneksi.emit("Page.screencastFrame", {
      data: "pertama",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    }, "S1");
    await Bun.sleep(1);
    const baru: BrowserFrame[] = [];
    manager.subscribe((frame) => {
      baru.push(frame);
    });
    await Bun.sleep(1);
    expect(baru).toHaveLength(1);
    expect(baru[0]?.data).toBe("pertama");
    await manager.close();
  });

  test("pelanggan lambat hanya menerima frame terbaru", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    let lepas: () => void = () => undefined;
    const gerbang = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    const diterima: string[] = [];
    manager.subscribe(async (frame) => {
      diterima.push(frame.data);
      await gerbang;
    });
    await Bun.sleep(1);
    koneksi.emit("Page.screencastFrame", { data: "a" }, "S1");
    await Bun.sleep(1);
    koneksi.emit("Page.screencastFrame", { data: "b" }, "S1");
    koneksi.emit("Page.screencastFrame", { data: "c" }, "S1");
    await Bun.sleep(1);
    // Benih screenshot mengisi frame pertama; sisanya menyusul.
    expect(diterima).toEqual(["YmVuaWgtMSA=="]);
    lepas();
    await Bun.sleep(5);
    expect(diterima).toEqual(["YmVuaWgtMSA==", "c"]);
    await manager.close();
  });

  test("benih screenshot dikirim saat pelanggan pertama walau screencast diam", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const diterima: BrowserFrame[] = [];
    manager.subscribe((frame) => {
      diterima.push(frame);
    });
    await Bun.sleep(5);
    expect(diterima).toHaveLength(1);
    expect(diterima[0]?.data).toBe("YmVuaWgtMSA==");
    expect(diterima[0]?.width).toBe(1280);
    expect(diterima[0]?.height).toBe(800);
    const tangkap = koneksi.calls("Page.captureScreenshot");
    expect(tangkap).toHaveLength(1);
    expect(tangkap[0]?.params).toEqual({ format: "jpeg", quality: 60 });
    expect(tangkap[0]?.sessionId).toBe("S1");
    await manager.close();
  });

  test("detak mengirim frame baru saat halaman diam", async () => {
    const jam = jamPalsu();
    const jam_detak = penjadwacPalsu();
    const { manager, koneksi } = setup({
      now: jam.now,
      schedule: jam_detak.schedule,
      idleScreenshotMs: 2_000,
    });
    await manager.ensure();
    const diterima: BrowserFrame[] = [];
    manager.subscribe((frame) => {
      diterima.push(frame);
    });
    await Bun.sleep(5);
    expect(diterima).toHaveLength(1);
    // Halaman diam: waktu maju, lalu detak dipicu manual.
    jam.maju(2_500);
    await jam_detak.pemicu();
    expect(koneksi.calls("Page.captureScreenshot")).toHaveLength(2);
    expect(diterima).toHaveLength(2);
    await manager.close();
  });

  test("detak berhenti setelah pelanggan terakhir pergi", async () => {
    const jam = jamPalsu();
    const jam_detak = penjadwacPalsu();
    const { manager, koneksi } = setup({
      now: jam.now,
      schedule: jam_detak.schedule,
      idleScreenshotMs: 2_000,
    });
    await manager.ensure();
    const unsubscribe = manager.subscribe(() => undefined);
    await Bun.sleep(5);
    const sebelum = koneksi.calls("Page.captureScreenshot").length;
    unsubscribe();
    jam.maju(5_000);
    await jam_detak.pemicuPaksa();
    expect(koneksi.calls("Page.captureScreenshot")).toHaveLength(sebelum);
    await manager.close();
  });

  test("detak tidak menumpuk permintaan screenshot yang masih berjalan", async () => {
    const jam = jamPalsu();
    const jam_detak = penjadwacPalsu();
    const { manager, koneksi } = setup({
      now: jam.now,
      schedule: jam_detak.schedule,
      idleScreenshotMs: 2_000,
    });
    await manager.ensure();
    manager.subscribe(() => undefined);
    await Bun.sleep(5);
    expect(koneksi.calls("Page.captureScreenshot")).toHaveLength(1);
    koneksi.tahanScreenshot = true;
    jam.maju(2_500);
    await jam_detak.pemicuPaksa();
    expect(koneksi.calls("Page.captureScreenshot")).toHaveLength(2);
    jam.maju(2_500);
    await jam_detak.pemicuPaksa();
    expect(koneksi.calls("Page.captureScreenshot")).toHaveLength(2);
    await manager.close();
  });

  test("Chrome yang mati sendiri dilepaskan lagi saat ensure() berikutnya", async () => {
    const { manager, proses, jumlahSpawn } = setup();
    await manager.ensure();
    expect(manager.state().status).toBe("menyala");
    proses[0]?.mati();
    await Bun.sleep(5);
    expect(manager.state().status).toBe("mati");
    await manager.ensure();
    expect(jumlahSpawn()).toBe(2);
    expect(manager.state().status).toBe("menyala");
    await manager.close();
  });

  test("close() menutup soket dan membunuh proses Chrome", async () => {
    const { manager, koneksi, proses } = setup();
    await manager.ensure();
    await manager.close();
    expect(koneksi.tertutup).toBe(true);
    expect(proses[0]?.jumlahKill).toBeGreaterThan(0);
    expect(manager.state().status).toBe("mati");
  });
});

/** Penjadwac palsu: mencatat tundaan, bisa dipicu, dan bisa dibatalkan. */
function penjadwacAgen(): {
  schedule: (callback: () => void, delayMs: number) => () => void;
  tundaan: () => number[];
  picu: () => void;
  batal: () => number;
} {
  const tundaan: number[] = [];
  let antre: (() => void) | undefined;
  let batal = 0;
  return {
    schedule: (callback, delayMs) => {
      tundaan.push(delayMs);
      antre = callback;
      return () => {
        batal += 1;
        antre = undefined;
      };
    },
    tundaan: () => tundaan,
    picu: () => antre?.(),
    batal: () => batal,
  };
}

describe("aktivitas agent di browser", () => {
  test("noteAgent mencatat aktivitas dan mendorong state ke pelanggan", async () => {
    const jam = jamPalsu();
    const { manager } = setup({ now: jam.now });
    const terkirim: BrowserState[] = [];
    manager.subscribeState((state) => {
      terkirim.push(state);
    });
    manager.noteAgent("membuka alamat");
    await Bun.sleep(120);
    const terakhir = terkirim[terkirim.length - 1];
    expect(terakhir?.agent).toEqual({ action: "membuka alamat", at: jam.now() });
    await manager.close();
  });

  test("catatan hilang setelah 4 detik dan timer dibersihkan saat close", async () => {
    const jam = jamPalsu();
    const penjadwac = penjadwacAgen();
    const { manager } = setup({ now: jam.now, schedule: penjadwac.schedule });
    manager.noteAgent("membuka alamat");
    expect(penjadwac.tundaan()).toEqual([4_000]);
    expect(manager.state().agent).toEqual({ action: "membuka alamat", at: jam.now() });
    penjadwac.picu();
    expect(manager.state().agent).toBeUndefined();

    manager.noteAgent("mengetik");
    expect(penjadwac.batal()).toBe(0);
    await manager.close();
    expect(penjadwac.batal()).toBe(1);
    expect(manager.state().agent).toBeUndefined();
  });

  test("label dibatasi 60 karakter dan kosong diabaikan", () => {
    const { manager } = setup();
    manager.noteAgent("membuka alamat");
    expect(manager.state().agent?.action).toBe("membuka alamat");
    manager.noteAgent("x".repeat(120));
    expect(manager.state().agent?.action).toHaveLength(60);
    manager.noteAgent("   ");
    expect(manager.state().agent?.action).toHaveLength(60);
  });
});
