import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, type VNode } from "preact";
import { fakeWindow, flushEffects, installDom, mount } from "./helpers/dom";
import {
  MOBILE_QUERY,
  isMobile,
  mobileScreen,
  sortMobileSessions,
  useMobile,
} from "../src/client/lib/mobile";

const root = join(import.meta.dir, "..");

/** Objek media tiruan untuk `matchMedia`. */
class MqlTiruan {
  matches: boolean;
  media: string;
  pendengar: (() => void)[] = [];

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  addEventListener(_type: string, fn: () => void): void {
    this.pendengar.push(fn);
  }

  removeEventListener(_type: string, fn: () => void): void {
    const indeks = this.pendengar.indexOf(fn);
    if (indeks >= 0) this.pendengar.splice(indeks, 1);
  }
}

let daftar: MqlTiruan[] = [];

function pasangMatchMedia(matches: boolean): MqlTiruan[] {
  daftar = [];
  const jendela = fakeWindow as unknown as { matchMedia: (query: string) => MqlTiruan };
  jendela.matchMedia = (query: string): MqlTiruan => {
    const mql = new MqlTiruan(query, matches);
    daftar.push(mql);
    return mql;
  };
  return daftar;
}

function ubahLebar(matches: boolean): void {
  for (const mql of daftar) {
    mql.matches = matches;
    for (const fn of mql.pendengar) fn();
  }
}

function Pemantau(): VNode {
  const mobile = useMobile();
  return h("span", null, mobile ? "ponsel" : "lebar");
}

describe("deteksi layar ponsel", () => {
  let uninstall: () => void = () => {};

  beforeAll(() => {
    uninstall = installDom();
  });

  afterAll(() => {
    uninstall();
  });

  test("kueri layar ponsel sama dengan batas gaya 640px", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 640px)");
  });

  test("tanpa matchMedia layar dianggap lebar", () => {
    const jendela = fakeWindow as unknown as { matchMedia?: unknown };
    const asli = jendela.matchMedia;
    delete jendela.matchMedia;
    expect(isMobile()).toBe(false);
    jendela.matchMedia = asli;
  });

  test("layar sempit terdeteksi dari matchMedia", () => {
    pasangMatchMedia(true);
    const hasil = mount(h(Pemantau, null));
    expect(hasil.textContent).toBe("ponsel");
  });

  test("perubahan lebar langsung diikuti", async () => {
    pasangMatchMedia(false);
    const hasil = mount(h(Pemantau, null));
    expect(hasil.textContent).toBe("lebar");
    await flushEffects();
    ubahLebar(true);
    await flushEffects();
    expect(hasil.textContent).toBe("ponsel");
  });

  test("kueri yang ditanyakan adalah MOBILE_QUERY", () => {
    pasangMatchMedia(false);
    mount(h(Pemantau, null));
    expect(daftar.every((mql) => mql.media === MOBILE_QUERY)).toBe(true);
  });
});

describe("pemilihan layar ponsel", () => {
  test("desktop tak tersentuh", () => {
    expect(mobileScreen({ mobile: false, hasSession: true, hasPage: true })).toBe("desktop");
  });

  test("halaman lain menang atas sesi", () => {
    expect(mobileScreen({ mobile: true, hasSession: true, hasPage: true })).toBe("halaman");
  });

  test("sesi terpilih membuka layar chat", () => {
    expect(mobileScreen({ mobile: true, hasSession: true, hasPage: false })).toBe("chat");
  });

  test("tanpa sesi dan halaman berarti layar daftar sesi", () => {
    expect(mobileScreen({ mobile: true, hasSession: false, hasPage: false })).toBe("sesi");
  });
});

describe("urutan sesi di ponsel", () => {
  const sesi = (id: string, updatedAt: string, pendingPermissions = 0) => ({
    id,
    updatedAt,
    pendingPermissions,
  });

  test("sesi yang menunggu izin tampil lebih dulu", () => {
    const hasil = sortMobileSessions([
      sesi("baru", "2026-11-02T00:00:00.000Z"),
      sesi("menunggu", "2026-11-01T00:00:00.000Z", 1),
    ]);
    expect(hasil.map((item) => item.id)).toEqual(["menunggu", "baru"]);
  });

  test("sesudah itu urutan terbaru dulu", () => {
    const hasil = sortMobileSessions([
      sesi("lama", "2026-11-01T00:00:00.000Z"),
      sesi("baru", "2026-11-03T00:00:00.000Z"),
      sesi("tengah", "2026-11-02T00:00:00.000Z"),
    ]);
    expect(hasil.map((item) => item.id)).toEqual(["baru", "tengah", "lama"]);
  });

  test("daftar asal tidak diubah", () => {
    const asal = [sesi("a", "2026-11-01T00:00:00.000Z"), sesi("b", "2026-11-03T00:00:00.000Z")];
    sortMobileSessions(asal);
    expect(asal.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("gaya mobile di styles.css", () => {
  const css = readFileSync(join(root, "src/client/styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  test("blok ponsel memakai data-mobile sehingga desktop aman", () => {
    expect(css).toContain('.jk-app[data-mobile] .jk-composer-mobile');
    expect(css).toContain('.jk-app[data-mobile] .jk-mobile-session-row');
    expect(css).toContain('.jk-app[data-mobile] .jk-panel-close::after');
  });

  test("daftar sesi ponsel setinggi minimal 56px", () => {
    expect(css).toMatch(/\.jk-mobile-session-row\s*\{[^}]*min-height:\s*56px/);
  });

  test("target sentuh 44px di bilah atas dan komposer", () => {
    expect(css).toMatch(
      /\.jk-app\[data-mobile\] \.jk-pill-row \.jk-send[^{]*\{[^}]*width:\s*44px/,
    );
    expect(css).toMatch(
      /\.jk-app\[data-mobile\] \.jk-icon-btn[^{]*\{[^}]*min-height:\s*44px/,
    );
  });

  test("safe-area bawah dipakai pada layar Sesi dan balasan", () => {
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
    expect(css).toMatch(
      /\.jk-app\[data-mobile\] \.jk-home-mobile \.jk-home-wrap\s*\{[^}]*safe-area-inset-bottom/,
    );
    expect(css).toMatch(
      /\.jk-app\[data-mobile\] \.jk-reply\s*\{[^}]*safe-area-inset-bottom/,
    );
  });

  test("tinggi aplikasi memakai viewport dinamis agar keyboard tak menutup kolom", () => {
    expect(css).toMatch(/\.jk-app\[data-mobile\]\s*\{[^}]*height:\s*100dvh/);
  });
});

describe("sambungan app.tsx", () => {
  const app = readFileSync(join(root, "src/client/app.tsx"), "utf8");

  test("useMobile dipanggil sekali dan memasang data-mobile", () => {
    expect(app.match(/useMobile\(\)/g)).toHaveLength(1);
    expect(app).toContain('data-mobile={mobile ? "1" : undefined}');
  });

  test("header sesi memakai tombol kembali di ponsel", () => {
    expect(app).toMatch(/<SessionHeader[\s\S]*?mobile=\{mobile\}[\s\S]*?onBack=/);
  });

  test("beranda ponsel memakai varian daftar sesi dan komposer ringkas", () => {
    expect(app).toContain('variant={showingHome ? "mobile" : "home"}');
    expect(app).toContain("mobile={showingHome}");
  });

  test("pemilihan layar memakai mobileScreen", () => {
    expect(app).toContain("mobileScreen({");
  });
});
