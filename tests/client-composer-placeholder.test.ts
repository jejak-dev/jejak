import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, type VNode } from "preact";
import { fakeWindow, flushEffects, installDom, mount } from "./helpers/dom";
import { NARROW_VIEWPORT_QUERY, useNarrowViewport } from "../src/client/lib/pane-narrow";
import {
  PLACEHOLDER_TUGAS,
  PLACEHOLDER_TUGAS_SEMPIT,
  placeholderTugas,
} from "../src/client/lib/composer-placeholder";

/* ---------- Tiruan matchMedia ---------- */

/** Objek media tiruan; hanya `matches` dan listener `change` yang dipakai. */
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

/** Pasang `matchMedia` tiruan; mengembalikan daftar objek media yang dibuat. */
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

/** Ubah hasil pencocokan semua objek media lalu beri tahu pendengarnya. */
function ubahLebar(matches: boolean): void {
  for (const mql of daftar) {
    mql.matches = matches;
    for (const fn of mql.pendengar) fn();
  }
}

/* ---------- Komponen pemantau ---------- */

/** Menampilkan status layar sempit hasil hook. */
function Pemantau(): VNode {
  const sempit = useNarrowViewport();
  return h("span", null, sempit ? "sempit" : "lebar");
}

const composerSrc = readFileSync(
  join(import.meta.dir, "..", "src", "client", "components", "Composer.tsx"),
  "utf8",
);

describe("useNarrowViewport", () => {
  let uninstall: () => void = () => {};

  beforeAll(() => {
    uninstall = installDom();
  });

  afterAll(() => {
    uninstall();
  });

  test("layar sempit terdeteksi dari matchMedia", () => {
    pasangMatchMedia(true);
    const root = mount(h(Pemantau, null));
    expect(root.textContent).toBe("sempit");
  });

  test("layar lebar terdeteksi dari matchMedia", () => {
    pasangMatchMedia(false);
    const root = mount(h(Pemantau, null));
    expect(root.textContent).toBe("lebar");
  });

  test("perubahan lebar layar langsung diikuti", async () => {
    pasangMatchMedia(false);
    const root = mount(h(Pemantau, null));
    expect(root.textContent).toBe("lebar");
    await flushEffects();
    ubahLebar(true);
    await flushEffects();
    expect(root.textContent).toBe("sempit");
  });

  test("kueri layar sempit sama dengan breakpoint panel", () => {
    pasangMatchMedia(true);
    const mql = mount(h(Pemantau, null));
    expect(mql.textContent).toBe("sempit");
    expect(NARROW_VIEWPORT_QUERY).toBe("(max-width: 959px)");
  });
});

describe("placeholder komposer", () => {
  test("layar sempit memakai placeholder pendek", () => {
    expect(placeholderTugas(true)).toBe(PLACEHOLDER_TUGAS_SEMPIT);
    expect(PLACEHOLDER_TUGAS_SEMPIT).toBe("Tulis tugas…");
  });

  test("layar lebar memakai contoh lengkap", () => {
    expect(placeholderTugas(false)).toBe(PLACEHOLDER_TUGAS);
    expect(PLACEHOLDER_TUGAS).toBe("Tulis tugas, mis. “jelaskan struktur proyek ini”");
  });

  test("Composer memakai helper placeholder dan hook layar sempit", () => {
    expect(composerSrc).toContain("useNarrowViewport");
    expect(composerSrc).toContain("placeholder={placeholderTugas(sempit)}");
  });
});
