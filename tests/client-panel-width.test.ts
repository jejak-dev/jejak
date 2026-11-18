import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PANEL_CHAT_MIN,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  effectiveMax,
  effectiveMaxNarrow,
  panelWidth,
} from "../src/client/lib/panel-width";

const appSrc = readFileSync(
  join(import.meta.dir, "..", "src", "client", "app.tsx"),
  "utf8",
);

/** Penyimpanan sederhana untuk menguji muat/simpan lebar panel. */
function storageFake(values: Record<string, string>) {
  const isi = { ...values };
  return {
    getItem(key: string): string | null {
      return isi[key] ?? null;
    },
    setItem(key: string, value: string): void {
      isi[key] = value;
    },
    isi,
  };
}

describe("lebar panel: batas", () => {
  test("batas statis diperlebar dan dipersempit", () => {
    expect(PANEL_MIN).toBe(280);
    expect(PANEL_MAX).toBe(1400);
    expect(panelWidth.spec.min).toBe(280);
    expect(panelWidth.spec.max).toBe(1400);
    expect(PANEL_DEFAULT).toBe(460);
  });

  test("nilai lama 320-760 tetap valid", () => {
    expect(panelWidth.parse("320")).toBe(320);
    expect(panelWidth.parse("460")).toBe(460);
    expect(panelWidth.parse("760")).toBe(760);
  });

  test("nilai di luar batas dijepit ke min/max baru", () => {
    expect(panelWidth.parse("200")).toBe(280);
    expect(panelWidth.parse("1000")).toBe(1000);
    expect(panelWidth.parse("5000")).toBe(1400);
  });

  test("nilai tak sah kembali ke bawaan", () => {
    expect(panelWidth.parse("")).toBe(460);
    expect(panelWidth.parse("abc")).toBe(460);
    expect(panelWidth.parse(undefined)).toBe(460);
  });

  test("lebar tersimpan dimuat dan disimpan utuh", () => {
    const simpanan = storageFake({ "jejak.panelWidth": "900" });
    expect(panelWidth.load(simpanan)).toBe(900);
    panelWidth.save(simpanan, 1100);
    expect(simpanan.isi["jejak.panelWidth"]).toBe("1100");
  });
});

describe("lebar panel: batas efektif jendela", () => {
  test("jendela lebar dibatasi statis", () => {
    expect(effectiveMax(3000, 264)).toBe(PANEL_MAX);
  });

  test("jendela sedang menyisakan ruang untuk kolom chat", () => {
    expect(effectiveMax(1000, 264)).toBe(1000 - 264 - PANEL_CHAT_MIN);
  });

  test("jendela sempit tak turun di bawah min", () => {
    expect(effectiveMax(500, 264)).toBe(PANEL_MIN);
    expect(effectiveMax(100, 0)).toBe(PANEL_MIN);
  });

  test("batas efektif tak pernah melebihi max statis", () => {
    expect(effectiveMax(1400, 0)).toBeLessThanOrEqual(PANEL_MAX);
    expect(effectiveMax(1400, 0)).toBeGreaterThanOrEqual(PANEL_MIN);
  });

  test("batas tak sah memakai max statis", () => {
    expect(effectiveMax(Number.NaN, 264)).toBe(PANEL_MAX);
    expect(effectiveMax(1200, Number.POSITIVE_INFINITY)).toBe(PANEL_MAX);
  });

  test("kolom chat selalu punya ruang 360px", () => {
    // Jendela yang terlalu sempit tertahan batas min panel, jadi ruang chat
    // dijamin hanya bila jendela cukup besar untuk min + 360px.
    for (const viewport of [1000, 1400, 1920, 2560]) {
      const batas = effectiveMax(viewport, 264);
      const chat = viewport - 264 - batas;
      expect(chat).toBeGreaterThanOrEqual(PANEL_CHAT_MIN);
    }
  });

  test("layar sempit: panel tak melebihi jendela", () => {
    expect(effectiveMaxNarrow(900)).toBe(868);
    expect(effectiveMaxNarrow(100)).toBe(PANEL_MIN);
    expect(effectiveMaxNarrow(4000)).toBe(PANEL_MAX);
  });

  test("chatMin kustom (mode lebar) mengubah batas", () => {
    expect(effectiveMax(1440, 0, 320)).toBe(1120);
    expect(effectiveMax(1440, 0, 720)).toBe(720);
    // Tanpa argumen ketiga perilaku lama tetap.
    expect(effectiveMax(1440, 0)).toBe(effectiveMax(1440, 0, PANEL_CHAT_MIN));
  });
});

describe("lebar panel: preferensi pengguna tak ditimpa jendela", () => {
  test("tidak ada efek yang menjepit panelW ke panelMax", () => {
    // Jejak lama: setPanelW((current) => (current > panelMax ? panelMax : current))
    // menimpa preferensi pengguna saat jendela mengecil.
    expect(appSrc).not.toMatch(/current\s*>\s*panelMax/);
    expect(appSrc).not.toMatch(/setPanelW\s*\(\s*\(current\)/);
  });

  test("lebar yang tampil dihitung dari jepitan preferensi dan batas", () => {
    expect(appSrc).toMatch(/Math\.min\(panelW,\s*panelMax\)/);
  });

  test("batas efektif kembali melebar saat jendela membesar", () => {
    const sempit = effectiveMax(900, 264);
    const lebar = effectiveMax(1800, 264);
    expect(sempit).toBeLessThan(lebar);
    expect(sempit).toBeGreaterThanOrEqual(PANEL_MIN);
    expect(lebar).toBeGreaterThan(PANEL_DEFAULT);
  });
});

describe("lebar panel: tombol keyboard", () => {
  test("panah kiri memperlebar, panah kanan mempersempit", () => {
    expect(panelWidth.forKey(460, "ArrowLeft", "ArrowLeft")).toBe(480);
    expect(panelWidth.forKey(460, "ArrowRight", "ArrowLeft")).toBe(440);
  });

  test("Home kembali ke lebar bawaan", () => {
    expect(panelWidth.forKey(900, "Home", "ArrowLeft")).toBe(460);
  });

  test("kunci lain tak dikenal", () => {
    expect(panelWidth.forKey(460, "Enter", "ArrowLeft")).toBeUndefined();
  });

  test("batas tak terlampaui saat panah ditekan", () => {
    expect(panelWidth.forKey(PANEL_MAX, "ArrowLeft", "ArrowLeft")).toBe(PANEL_MAX);
    expect(panelWidth.forKey(PANEL_MIN, "ArrowRight", "ArrowLeft")).toBe(PANEL_MIN);
  });
});
