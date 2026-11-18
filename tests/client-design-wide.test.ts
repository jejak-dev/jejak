import { describe, expect, test } from "bun:test";
import {
  CHAT_WIDE_DEFAULT,
  CHAT_WIDE_MAX,
  CHAT_WIDE_MIN,
  WIDE_PANEL_MAX,
  chatFromPanel,
  chatWidth,
  wideAvailable,
  wideLayout,
} from "../src/client/lib/design-wide";
import { PANEL_MIN } from "../src/client/lib/panel-width";

/** Penyimpanan sederhana untuk menguji muat/simpan lebar chat. */
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

describe("mode lebar: ketersediaan", () => {
  test("hanya desktop yang lebar", () => {
    expect(wideAvailable({ narrow: false, mobile: false })).toBe(true);
    expect(wideAvailable({ narrow: true, mobile: false })).toBe(false);
    expect(wideAvailable({ narrow: false, mobile: true })).toBe(false);
    expect(wideAvailable({ narrow: true, mobile: true })).toBe(false);
  });
});

describe("mode lebar: pembagian lebar", () => {
  test("jendela 1440 memberi panel 1060", () => {
    const hasil = wideLayout({ viewport: 1440, chat: CHAT_WIDE_DEFAULT });
    expect(hasil.chat).toBe(380);
    expect(hasil.panel).toBe(1060);
    expect(hasil.panelMin).toBe(720);
    expect(hasil.panelMax).toBe(1120);
  });

  test("jendela 1920 memberi panel 1540", () => {
    const hasil = wideLayout({ viewport: 1920, chat: CHAT_WIDE_DEFAULT });
    expect(hasil.panel).toBe(1540);
    expect(hasil.panelMin).toBe(1200);
    expect(hasil.panelMax).toBe(1600);
  });

  test("chat di bawah min dan di atas max dijepit", () => {
    expect(wideLayout({ viewport: 1440, chat: 200 }).chat).toBe(CHAT_WIDE_MIN);
    expect(wideLayout({ viewport: 1440, chat: 900 }).chat).toBe(CHAT_WIDE_MAX);
  });

  test("chat tak boleh membuat panel lebih sempit dari PANEL_MIN", () => {
    const hasil = wideLayout({ viewport: 900, chat: 700 });
    expect(hasil.chat).toBe(900 - PANEL_MIN);
    expect(hasil.panel).toBe(PANEL_MIN);
  });

  test("nilai tak hingga memakai bawaan", () => {
    expect(wideLayout({ viewport: Number.NaN, chat: 380 }).panel).toBe(1280 - 380);
    expect(wideLayout({ viewport: 1440, chat: Number.POSITIVE_INFINITY }).chat).toBe(
      CHAT_WIDE_DEFAULT,
    );
    expect(wideLayout({ viewport: Number.POSITIVE_INFINITY, chat: 380 }).panel).toBe(1280 - 380);
  });

  test("panelMin tak pernah melebihi panelMax", () => {
    for (const viewport of [200, 500, 900, 1440, 1920, 4000]) {
      const hasil = wideLayout({ viewport, chat: CHAT_WIDE_DEFAULT });
      expect(hasil.panelMin).toBeLessThanOrEqual(hasil.panelMax);
      expect(hasil.panelMin).toBeGreaterThanOrEqual(PANEL_MIN);
      expect(hasil.panelMax).toBeLessThanOrEqual(WIDE_PANEL_MAX);
    }
  });

  test("jendela sangat kecil tak menghasilkan nilai negatif", () => {
    const hasil = wideLayout({ viewport: 200, chat: 380 });
    expect(hasil.chat).toBeGreaterThanOrEqual(CHAT_WIDE_MIN);
    expect(hasil.panel).toBeGreaterThanOrEqual(1);
    expect(hasil.panelMin).toBeGreaterThanOrEqual(PANEL_MIN);
    expect(hasil.panelMax).toBeGreaterThanOrEqual(PANEL_MIN);
  });
});

describe("mode lebar: geser panel menjadi lebar chat", () => {
  test("bolak-balik dengan wideLayout", () => {
    for (const viewport of [1440, 1920]) {
      const hasil = wideLayout({ viewport, chat: CHAT_WIDE_DEFAULT });
      expect(chatFromPanel(viewport, hasil.panel)).toBe(hasil.chat);
    }
  });

  test("hasil dijepit 320..720", () => {
    expect(chatFromPanel(1440, 1400)).toBe(CHAT_WIDE_MIN);
    expect(chatFromPanel(1440, 200)).toBe(CHAT_WIDE_MAX);
    expect(chatFromPanel(1440, Number.NaN)).toBe(CHAT_WIDE_DEFAULT);
  });
});

describe("mode lebar: lebar chat tersimpan", () => {
  test("kunci dan batas", () => {
    expect(chatWidth.spec.key).toBe("jejak.designChatWidth");
    expect(chatWidth.spec.def).toBe(380);
    expect(chatWidth.spec.min).toBe(320);
    expect(chatWidth.spec.max).toBe(720);
  });

  test("nilai rusak kembali ke bawaan, nilai luar batas dijepit", () => {
    expect(chatWidth.parse("abc")).toBe(CHAT_WIDE_DEFAULT);
    expect(chatWidth.parse("")).toBe(CHAT_WIDE_DEFAULT);
    expect(chatWidth.parse("100")).toBe(CHAT_WIDE_MIN);
    expect(chatWidth.parse("2000")).toBe(CHAT_WIDE_MAX);
    expect(chatWidth.parse("500")).toBe(500);
  });

  test("muat dan simpan memakai storage", () => {
    const simpanan = storageFake({ "jejak.designChatWidth": "440" });
    expect(chatWidth.load(simpanan)).toBe(440);
    chatWidth.save(simpanan, 600);
    expect(simpanan.isi["jejak.designChatWidth"]).toBe("600");
  });
});
