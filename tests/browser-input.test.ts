import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserError } from "../src/server/browser/browser-error";
import {
  BrowserManager,
  type BrowserProcess,
  validateInputEvents,
} from "../src/server/browser/browser-manager";
import { KoneksiPalsu } from "./browser-fake-cdp";

/** Proses Chrome palsu: bisa dibunuh seketika. */
function prosesPalsu(): BrowserProcess {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  return {
    pid: 4242,
    exited,
    kill: (): void => {
      selesai(0);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-input-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  manager: BrowserManager;
  koneksi: KoneksiPalsu;
  maju: (ms: number) => void;
}

function setup(options: { dialogTtlMs?: number } = {}): Setup {
  const koneksi = new KoneksiPalsu();
  koneksi.addTarget("T1");
  let waktu = 1_000;
  const manager = new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => prosesPalsu(),
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
    now: () => waktu,
    ...(options.dialogTtlMs === undefined ? {} : { dialogTtlMs: options.dialogTtlMs }),
  });
  return { manager, koneksi, maju: (ms: number) => { waktu += ms; } };
}

describe("ukuran tampilan", () => {
  test("ukuran diklem ke batas dan dipasang ke tab aktif", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const kecil = await manager.setViewport(10, 10);
    expect(kecil.viewport).toEqual({ width: 320, height: 240 });
    const besar = await manager.setViewport(5000, 5000);
    expect(besar.viewport).toEqual({ width: 1920, height: 1200 });
    const override = koneksi.calls("Emulation.setDeviceMetricsOverride");
    expect(override[override.length - 1]?.params).toEqual({
      width: 1920,
      height: 1200,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(override[override.length - 1]?.sessionId).toBe("S-T1");
    await manager.close();
  });

  test("ukuran dibulatkan", async () => {
    const { manager } = setup();
    await manager.ensure();
    const state = await manager.setViewport(800.6, 600.4);
    expect(state.viewport).toEqual({ width: 801, height: 600 });
    await manager.close();
  });

  test("ukuran tak valid ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(manager.setViewport("besar", 600)).rejects.toBeInstanceOf(BrowserError);
    await expect(manager.setViewport(800, Number.NaN)).rejects.toBeInstanceOf(BrowserError);
    await manager.close();
  });

  test("screencast dimulai ulang dan frame baru membawa ukuran viewport", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const frames: Array<{ width: number; height: number }> = [];
    manager.subscribe((frame) => {
      frames.push({ width: frame.width, height: frame.height });
    });
    await Bun.sleep(5);
    expect(koneksi.calls("Page.startScreencast")[0]?.params).toEqual({
      format: "jpeg",
      quality: 80,
      maxWidth: 2560,
      maxHeight: 1600,
    });
    await manager.setViewport(640, 480);
    await Bun.sleep(5);
    const mulai = koneksi.calls("Page.startScreencast");
    expect(mulai.length).toBe(2);
    expect(mulai[1]?.params).toEqual({
      format: "jpeg",
      quality: 80,
      maxWidth: 1280,
      maxHeight: 960,
    });
    expect(frames[frames.length - 1]).toEqual({ width: 640, height: 480 });
    await manager.close();
  });

  test("ukuran juga dipasang ke tab yang diaktifkan kemudian", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.setViewport(640, 480);
    await manager.newTab("https://kedua.test");
    await Bun.sleep(5);
    const override = koneksi.calls("Emulation.setDeviceMetricsOverride");
    const terakhir = override[override.length - 1];
    expect(terakhir?.params).toEqual({
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(terakhir?.sessionId).toBe("S-X1");
    await manager.close();
  });
});

describe("input mouse, keyboard, dan teks", () => {
  test("mouse dipetakan ke perintah CDP", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([
      { kind: "mouse", type: "move", x: 10, y: 20 },
      { kind: "mouse", type: "down", x: 10, y: 20, button: "left", clickCount: 1 },
      { kind: "mouse", type: "up", x: 10, y: 20, button: "left", clickCount: 1 },
      { kind: "mouse", type: "wheel", x: 10, y: 20, deltaX: 0, deltaY: 120 },
    ]);
    const panggilan = koneksi.calls("Input.dispatchMouseEvent");
    expect(panggilan.map((call) => (call.params as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "mouseWheel",
    ]);
    expect((panggilan[1]?.params as { buttons: number }).buttons).toBe(1);
    expect((panggilan[2]?.params as { buttons: number }).buttons).toBe(0);
    expect(panggilan[3]?.params).toEqual({
      type: "mouseWheel",
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: 120,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });
    expect(panggilan[0]?.sessionId).toBe("S-T1");
    await manager.close();
  });

  test("tombol mouse kanan memakai bitmask 2", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([
      { kind: "mouse", type: "down", x: 1, y: 1, button: "right" },
    ]);
    const panggilan = koneksi.calls("Input.dispatchMouseEvent");
    expect((panggilan[0]?.params as { buttons: number }).buttons).toBe(2);
    await manager.close();
  });

  test("tombol yang bisa mengetik memakai keyDown, tombol kontrol memakai rawKeyDown", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([
      { kind: "key", type: "down", key: "a", code: "KeyA", text: "a" },
      { kind: "key", type: "down", key: "Shift", code: "ShiftLeft" },
      { kind: "key", type: "up", key: "a", code: "KeyA" },
    ]);
    const panggilan = koneksi.calls("Input.dispatchKeyEvent");
    expect((panggilan[0]?.params as { type: string }).type).toBe("keyDown");
    expect((panggilan[0]?.params as { text?: string }).text).toBe("a");
    expect((panggilan[1]?.params as { type: string }).type).toBe("rawKeyDown");
    expect((panggilan[2]?.params as { type: string }).type).toBe("keyUp");
    await manager.close();
  });

  test("modifier diteruskan apa adanya", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([
      { kind: "key", type: "down", key: "s", code: "KeyS", text: "s", modifiers: 2 },
      { kind: "mouse", type: "move", x: 1, y: 1, modifiers: 8 },
    ]);
    const tombol = koneksi.calls("Input.dispatchKeyEvent");
    expect((tombol[0]?.params as { modifiers: number }).modifiers).toBe(2);
    const mouse = koneksi.calls("Input.dispatchMouseEvent");
    expect((mouse[0]?.params as { modifiers: number }).modifiers).toBe(8);
    await manager.close();
  });

  test("teks panjang memakai Input.insertText", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([{ kind: "text", text: "halo dunia" }]);
    const panggilan = koneksi.calls("Input.insertText");
    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]?.params).toEqual({ text: "halo dunia" });
    await manager.close();
  });

  test("event dikirim berurutan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.dispatchInput([
      { kind: "mouse", type: "move", x: 1, y: 1 },
      { kind: "text", text: "a" },
    ]);
    const urutan = koneksi.panggilan
      .filter(
        (call) =>
          call.method === "Input.dispatchMouseEvent" || call.method === "Input.insertText",
      )
      .map((call) => call.method);
    expect(urutan).toEqual(["Input.dispatchMouseEvent", "Input.insertText"]);
    await manager.close();
  });
});

describe("validasi input", () => {
  test("koordinat di luar area tampilan ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    let galat: unknown;
    try {
      await manager.dispatchInput([{ kind: "mouse", type: "move", x: 9999, y: 10 }]);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-valid");
    await manager.close();
  });

  test("jenis event tak dikenal ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(manager.dispatchInput([{ kind: "jari" }])).rejects.toBeInstanceOf(BrowserError);
    await manager.close();
  });

  test("field tak dikenal ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(
      manager.dispatchInput([{ kind: "text", text: "a", warna: "merah" }]),
    ).rejects.toBeInstanceOf(BrowserError);
    await manager.close();
  });

  test("teks terlalu panjang ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(
      manager.dispatchInput([{ kind: "text", text: "x".repeat(10_001) }]),
    ).rejects.toBeInstanceOf(BrowserError);
    await manager.close();
  });

  test("lebih dari 100 event ditolak dengan batas", async () => {
    const { manager } = setup();
    await manager.ensure();
    const banyak = Array.from({ length: 101 }, () => ({
      kind: "text" as const,
      text: "a",
    }));
    let galat: unknown;
    try {
      await manager.dispatchInput(banyak);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("batas");
    await manager.close();
  });

  test("isi input tak pernah muncul di pesan galat", async () => {
    const { manager } = setup();
    await manager.ensure();
    const rahasia = "kata-sandi-rahasia";
    let pesan = "";
    try {
      await manager.dispatchInput([{ kind: "key", type: "down", key: rahasia, code: 12 }]);
    } catch (caught) {
      pesan = caught instanceof Error ? caught.message : String(caught);
    }
    expect(pesan).not.toContain(rahasia);
    const galatUji = (() => {
      try {
        validateInputEvents([{ kind: "text", text: rahasia, tambahan: 1 }], {
          width: 100,
          height: 100,
        });
        return "";
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    })();
    expect(galatUji).not.toContain(rahasia);
    await manager.close();
  });

  test("batas laju 200 event per detik ditegakkan", async () => {
    const { manager, maju } = setup();
    await manager.ensure();
    const batch = Array.from({ length: 100 }, () => ({ kind: "text" as const, text: "a" }));
    await manager.dispatchInput(batch);
    await manager.dispatchInput(batch);
    let galat: unknown;
    try {
      await manager.dispatchInput(batch);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("batas");
    // Setelah satu detik, laju dihitung ulang.
    maju(1_100);
    await manager.dispatchInput(batch);
    await manager.close();
  });
});

describe("dialog, unduhan, izin, dan salin", () => {
  test("dialog alert diterima dan confirm ditolak", async () => {
    const { manager, koneksi } = setup({ dialogTtlMs: 50 });
    await manager.ensure();
    koneksi.emit(
      "Page.javascriptDialogOpening",
      { type: "confirm", message: "hapus file?" },
      "S-T1",
    );
    await Bun.sleep(20);
    expect(koneksi.dialog?.accept).toBe(false);
    expect(manager.state().lastDialog).toEqual({ type: "confirm", message: "hapus file?" });
    koneksi.emit(
      "Page.javascriptDialogOpening",
      { type: "alert", message: "halo" },
      "S-T1",
    );
    await Bun.sleep(20);
    expect(koneksi.dialog?.accept).toBe(true);
    expect(manager.state().lastDialog?.type).toBe("alert");
    await manager.close();
  });

  test("pesan dialog dibatasi 200 karakter dan hilang setelah 5 detik", async () => {
    const { manager, koneksi } = setup({ dialogTtlMs: 50 });
    await manager.ensure();
    koneksi.emit(
      "Page.javascriptDialogOpening",
      { type: "alert", message: "x".repeat(500) },
      "S-T1",
    );
    await Bun.sleep(20);
    expect(manager.state().lastDialog?.message.length).toBe(200);
    await Bun.sleep(80);
    expect(manager.state().lastDialog).toBeUndefined();
    await manager.close();
  });

  test("unduhan selalu ditolak dan izin tak pernah diberikan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const unduhan = koneksi.calls("Browser.setDownloadBehavior");
    expect(unduhan).toHaveLength(1);
    expect(unduhan[0]?.params).toEqual({ behavior: "deny" });
    expect(koneksi.calls("Browser.setPermission")).toHaveLength(0);
    await manager.close();
  });

  test("salin mengembalikan teks pilihan halaman aktif", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.pilihan = "teks terpilih";
    const text = await manager.copySelection();
    expect(text).toBe("teks terpilih");
    const panggilan = koneksi.calls("Runtime.evaluate");
    expect(panggilan[0]?.params).toEqual({
      expression: "window.getSelection().toString()",
      returnByValue: true,
    });
    await manager.close();
  });
});
