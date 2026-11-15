import { describe, expect, test } from "bun:test";
import {
  PANEL_CHAT_MIN,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  effectiveMax,
  effectiveMaxNarrow,
  panelWidth,
} from "../src/client/lib/panel-width";

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
