import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserError } from "../src/server/browser/browser-error";
import {
  BrowserManager,
  type BrowserProcess,
  SNAPSHOT_SCRIPT,
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
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-snapshot-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  manager: BrowserManager;
  koneksi: KoneksiPalsu;
}

function setup(): Setup {
  const koneksi = new KoneksiPalsu();
  koneksi.addTarget("T1");
  const manager = new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => prosesPalsu(),
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
    now: () => Date.now(),
  });
  return { manager, koneksi };
}

/** Cuplikan halaman palsu yang dikembalikan skrip snapshot. */
function halamanPalsu(teks = "halo dunia", jumlahElemen = 4): unknown {
  const dasar = [
    { ref: 1, tag: "button", role: "button", name: "Klik", x: 100, y: 120 },
    { ref: 2, tag: "input", role: "textbox", name: "Kotak", type: "text", value: "lama", x: 10, y: 20 },
    { ref: 3, tag: "input", role: "textbox", name: "Sandi", type: "password", value: "rahasia", x: 30, y: 40 },
    { ref: 4, tag: "a", role: "link", name: "Tautan", href: "https://contoh.test/tujuan", x: 5, y: 6 },
  ];
  const elements =
    jumlahElemen <= dasar.length
      ? dasar.slice(0, jumlahElemen)
      : Array.from({ length: jumlahElemen }, (_, index) => ({
          ref: index + 1,
          tag: "button",
          name: `Tombol ${index + 1}`,
          x: index + 1,
          y: index + 1,
        }));
  return {
    url: "https://contoh.test/",
    title: "Contoh",
    text: teks,
    elements,
  };
}

/** Ekspresi skrip yang tercatat pada panggilan `Runtime.evaluate`. */
function ekspresi(call: { params?: unknown }): string {
  return String((call.params as { expression?: string } | undefined)?.expression ?? "");
}

describe("snapshot halaman", () => {
  test("memakai skrip konstan dan mengurai hasilnya", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    const snap = await manager.snapshot();
    const panggilan = koneksi.calls("Runtime.evaluate");
    expect(panggilan).toHaveLength(1);
    expect(ekspresi(panggilan[0] ?? {})).toBe(SNAPSHOT_SCRIPT);
    expect(snap.url).toBe("https://contoh.test/");
    expect(snap.title).toBe("Contoh");
    expect(snap.text).toBe("halo dunia");
    expect(snap.elements).toHaveLength(4);
    expect(snap.elements[0]).toEqual({
      ref: 1,
      tag: "button",
      role: "button",
      name: "Klik",
      x: 100,
      y: 120,
    });
    expect(snap.elements[3]?.href).toBe("https://contoh.test/tujuan");
    await manager.close();
  });

  test("skrip snapshot tak memuat masukan dan tak berubah antar pemanggilan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    await manager.snapshot({ maxChars: 100 });
    await manager.snapshot({ maxChars: 30_000 });
    const ekspresiPemanggilan = koneksi.calls("Runtime.evaluate").map(ekspresi);
    expect(ekspresiPemanggilan).toHaveLength(2);
    expect(ekspresiPemanggilan[0]).toBe(SNAPSHOT_SCRIPT);
    expect(ekspresiPemanggilan[1]).toBe(SNAPSHOT_SCRIPT);
    expect(ekspresiPemanggilan[0]).not.toContain("100");
    expect(ekspresiPemanggilan[0]).not.toContain("30000");
    await manager.close();
  });

  test("teks dipotong dengan penanda dan memakai batas yang diminta", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu("x".repeat(50));
    const pendek = await manager.snapshot({ maxChars: 20 });
    expect(pendek.text).toBe(`${"x".repeat(10)}[dipotong]`);
    expect(pendek.text.length).toBe(20);
    koneksi.snapshot = halamanPalsu("y".repeat(20_000));
    const bawaan = await manager.snapshot();
    expect(bawaan.text.length).toBe(12_000);
    expect(bawaan.text.endsWith("[dipotong]")).toBe(true);
    koneksi.snapshot = halamanPalsu("z".repeat(40_000));
    const maks = await manager.snapshot({ maxChars: 99_999 });
    expect(maks.text.length).toBe(30_000);
    expect(maks.text.endsWith("[dipotong]")).toBe(true);
    await manager.close();
  });

  test("jumlah elemen dibatasi 80", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu("halo", 120);
    const snap = await manager.snapshot();
    expect(snap.elements).toHaveLength(80);
    await manager.close();
  });

  test("isi input kata sandi tak pernah keluar", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    const snap = await manager.snapshot();
    const sandi = snap.elements.find((el) => el.type === "password");
    expect(sandi).toBeDefined();
    expect(sandi?.value).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("rahasia");
    await manager.close();
  });

  test("hasil snapshot tak berbentuk objek tak menggagalkan manajer", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = "bukan json";
    const snap = await manager.snapshot();
    expect(snap.url).toBe("");
    expect(snap.text).toBe("");
    expect(snap.elements).toEqual([]);
    await manager.close();
  });
});

describe("klik lewat ref", () => {
  test("kirim mouse move, down, dan up di titik elemen", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 100, y: 120 };
    await manager.snapshot();
    await manager.clickRef(1);
    const mouse = koneksi.calls("Input.dispatchMouseEvent");
    expect(mouse.map((call) => (call.params as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouse[0]?.params).toMatchObject({ x: 100, y: 120, button: "none" });
    expect(mouse[1]?.params).toMatchObject({
      x: 100,
      y: 120,
      button: "left",
      clickCount: 1,
      buttons: 1,
    });
    expect(mouse[2]?.params).toMatchObject({ button: "left", clickCount: 1, buttons: 0 });
    expect(mouse[0]?.sessionId).toBe("S-T1");
    await manager.close();
  });

  test("ref tanpa snapshot ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    let galat: unknown;
    try {
      await manager.clickRef(1);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-valid");
    expect((galat as BrowserError).message).toBe(
      "Elemen tidak ditemukan; ambil snapshot baru.",
    );
    await manager.close();
  });

  test("ref di luar rentang dan ref tak valid ditolak", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 1, y: 2 };
    await manager.snapshot();
    for (const buruk of [0, 5, 999, 1.5, Number.NaN]) {
      let galat: unknown;
      try {
        await manager.clickRef(buruk);
      } catch (caught) {
        galat = caught;
      }
      expect(galat).toBeInstanceOf(BrowserError);
      expect((galat as BrowserError).code).toBe("tidak-valid");
    }
    expect(koneksi.calls("Input.dispatchMouseEvent")).toHaveLength(0);
    await manager.close();
  });

  test("elemen yang sudah hilang ditolak", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = null;
    await manager.snapshot();
    let galat: unknown;
    try {
      await manager.clickRef(2);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-valid");
    expect((galat as BrowserError).message).toBe(
      "Elemen tidak ditemukan; ambil snapshot baru.",
    );
    await manager.close();
  });

  test("ref tak berlaku lagi setelah halaman berpindah", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 1, y: 2 };
    await manager.snapshot();
    await manager.navigate("https://lain.test/");
    let galat: unknown;
    try {
      await manager.clickRef(1);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-valid");
    await manager.close();
  });
});

describe("ketik lewat ref", () => {
  test("pilih isi lama lalu kirim teks", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 10, y: 20 };
    await manager.snapshot();
    await manager.typeRef(2, "abc");
    const evaluate = koneksi.calls("Runtime.evaluate");
    expect(evaluate).toHaveLength(3);
    expect(ekspresi(evaluate[1] ?? {})).toContain("fokus(2)");
    expect(ekspresi(evaluate[2] ?? {})).toContain("pilih(2)");
    const insert = koneksi.calls("Input.insertText");
    expect(insert).toHaveLength(1);
    expect(insert[0]?.params).toEqual({ text: "abc" });
    // Teks dikirim setelah isi lama dipilih.
    const idxPilih = koneksi.panggilan.findIndex(
      (call) => call.method === "Runtime.evaluate" && ekspresi(call).includes("pilih(2)"),
    );
    const idxInsert = koneksi.panggilan.findIndex((call) => call.method === "Input.insertText");
    expect(idxInsert).toBeGreaterThan(idxPilih);
    await manager.close();
  });

  test("klik tengah supaya elemen terfokus lalu mengetik", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 10, y: 20 };
    await manager.snapshot();
    await manager.typeRef(2, "abc");
    const mouse = koneksi.calls("Input.dispatchMouseEvent");
    expect(mouse.map((call) => (call.params as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect((mouse[1]?.params as { x: number }).x).toBe(10);
    expect((mouse[1]?.params as { y: number }).y).toBe(20);
    await manager.close();
  });

  test("submit menambah tombol Enter setelah teks", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 10, y: 20 };
    await manager.snapshot();
    await manager.typeRef(2, "abc", { submit: true });
    const key = koneksi.calls("Input.dispatchKeyEvent");
    expect(key).toHaveLength(2);
    expect(key[0]?.params).toMatchObject({ type: "rawKeyDown", key: "Enter", code: "Enter" });
    expect(key[1]?.params).toMatchObject({ type: "keyUp", key: "Enter" });
    const idxInsert = koneksi.panggilan.findIndex((call) => call.method === "Input.insertText");
    const idxKey = koneksi.panggilan.findIndex((call) => call.method === "Input.dispatchKeyEvent");
    expect(idxKey).toBeGreaterThan(idxInsert);
    await manager.close();
  });

  test("teks terlalu panjang ditolak dan isinya tak masuk pesan galat", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = { x: 10, y: 20 };
    await manager.snapshot();
    const isi = "rahasia".repeat(2_000);
    let galat: unknown;
    try {
      await manager.typeRef(2, isi);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("batas");
    expect((galat as BrowserError).message).not.toContain("rahasia");
    expect(koneksi.calls("Input.insertText")).toHaveLength(0);
    await manager.close();
  });

  test("isi yang diketik tak bocor ke galat saat elemen tak dikenal", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.snapshot = halamanPalsu();
    koneksi.aksi = null;
    await manager.snapshot();
    const isi = "rahasia-teks";
    let galat: unknown;
    try {
      await manager.typeRef(2, isi);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).message).not.toContain(isi);
    await manager.close();
  });
});

describe("tekan tombol", () => {
  test("tombol bernama memakai code dan nomor tombol yang benar", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.pressKey("Enter");
    const key = koneksi.calls("Input.dispatchKeyEvent");
    expect(key).toHaveLength(2);
    expect(key[0]?.params).toMatchObject({
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(key[1]?.params).toMatchObject({ type: "keyUp", key: "Enter", code: "Enter" });
    await manager.close();
  });

  test("huruf tunggal diketik sebagai teks", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.pressKey("a");
    const key = koneksi.calls("Input.dispatchKeyEvent");
    expect(key[0]?.params).toMatchObject({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "a",
    });
    await manager.close();
  });

  test("tombol di luar daftar putih ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    for (const buruk of ["F5", "Shift", "Control", "Ctrl+A", "Alt+Tab", " ", ""]) {
      let galat: unknown;
      try {
        await manager.pressKey(buruk);
      } catch (caught) {
        galat = caught;
      }
      expect(galat).toBeInstanceOf(BrowserError);
      expect((galat as BrowserError).code).toBe("tidak-valid");
    }
    await manager.close();
  });
});

describe("gulir halaman", () => {
  test("gulir ke bawah memakai jarak bawaan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.scroll("down");
    const wheel = koneksi.calls("Input.dispatchMouseEvent");
    expect(wheel).toHaveLength(1);
    expect(wheel[0]?.params).toEqual({
      type: "mouseWheel",
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: 600,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });
    await manager.close();
  });

  test("gulir ke atas memakai delta negatif dan jarak diklem", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.scroll("up", 10_000);
    await manager.scroll("down", 0);
    await manager.scroll("down", 2.6);
    const wheel = koneksi.calls("Input.dispatchMouseEvent");
    expect((wheel[0]?.params as { deltaY: number }).deltaY).toBe(-5_000);
    expect((wheel[1]?.params as { deltaY: number }).deltaY).toBe(1);
    expect((wheel[2]?.params as { deltaY: number }).deltaY).toBe(3);
    await manager.close();
  });

  test("arah gulir tak valid ditolak", async () => {
    const { manager } = setup();
    await manager.ensure();
    let galat: unknown;
    try {
      await manager.scroll("kiri" as "up");
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-valid");
    await manager.close();
  });
});
