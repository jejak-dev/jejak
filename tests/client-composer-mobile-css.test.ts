import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Kondisi media yang dipakai untuk layar sentuh atau sempit. */
const SENTUH_SEMPIT = "pointer: coarse), (max-width: 760px";

/**
 * Isi blok `@media` dengan kondisi persis yang memuat penyebut.
 *
 * Kondisi boleh berisi beberapa kueri, mis. `pointer: coarse), (max-width: 760px`.
 */
function blokMedia(kondisi: string, penyebut: string): string {
  const penanda = `@media (${kondisi})`;
  let dari = 0;
  for (;;) {
    const mulai = css.indexOf(penanda, dari);
    if (mulai === -1) return "";
    const buka = css.indexOf("{", mulai);
    let kedalaman = 0;
    let i = buka;
    for (; i < css.length; i++) {
      if (css[i] === "{") kedalaman += 1;
      else if (css[i] === "}") {
        kedalaman -= 1;
        if (kedalaman === 0) break;
      }
    }
    const isi = css.slice(buka + 1, i);
    if (isi.includes(penyebut)) return isi;
    dari = i + 1;
  }
}

/** Isi aturan sederhana (selektor persis) di dalam potongan CSS. */
function isiAturan(potongan: string, selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(potongan);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((s) => s.trim() === selektor)) return cocok[2] ?? "";
    cocok = pola.exec(potongan);
  }
  return undefined;
}

describe("komposer di layar HP", () => {
  test("tombol bahasa dikte disembunyikan di layar kecil", () => {
    const blok = blokMedia("max-width: 640px", ".jk-dictation .jk-dd-btn");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-dictation .jk-dd-btn")).toMatch(/display:\s*none/);
  });

  test("kontrol baris input seragam 40x40 di layar sentuh atau sempit", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-pill-row .jk-attach-btn");
    expect(blok).not.toBe("");
    for (const selektor of [
      ".jk-pill-row .jk-attach-btn",
      ".jk-pill-row .jk-send",
      ".jk-dictation-btn",
    ]) {
      const isi = isiAturan(blok, selektor) ?? "";
      expect(isi).toMatch(/width:\s*40px/);
      expect(isi).toMatch(/height:\s*40px/);
      expect(isi).toMatch(/min-width:\s*40px/);
      expect(isi).toMatch(/min-height:\s*40px/);
    }
  });

  test("satu baris teks setinggi tombol di layar sentuh atau sempit", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-pill-row .jk-comp-input");
    expect(blok).not.toBe("");
    const isi = isiAturan(blok, ".jk-pill-row .jk-comp-input") ?? "";
    expect(isi).toMatch(/min-height:\s*40px/);
    expect(isi).toMatch(/padding:\s*8px 4px/);
    expect(isi).toMatch(/line-height:\s*1\.4/);
  });

  test("baris input tetap menempel di bawah saat teks bertambah", () => {
    const dasar = isiAturan(css, ".jk-pill-row") ?? "";
    expect(dasar).toMatch(/align-items:\s*flex-end/);
  });

  test("chip meta dirapatkan di layar sentuh atau sempit", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-comp-meta .jk-chip");
    expect(blok).not.toBe("");
    const meta = isiAturan(blok, ".jk-comp-meta") ?? "";
    expect(meta).toMatch(/gap:\s*6px/);
    const chip = isiAturan(blok, ".jk-comp-meta .jk-chip") ?? "";
    expect(chip).toMatch(/height:\s*34px/);
    expect(chip).toMatch(/min-height:\s*34px/);
  });

  test("chip folder kerja memakai satu baris penuh", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-comp-meta .jk-chip-cwd");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-comp-meta .jk-chip-cwd")).toMatch(/flex:\s*1 1 100%/);
  });

  test("opsi lanjutan sejajar dengan chip meta", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-advanced > summary");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-advanced > summary")).toMatch(/padding-left:\s*8px/);
  });

  test("menu slash muat di layar sempit dan tak menutupi tombol", () => {
    const blok = blokMedia(SENTUH_SEMPIT, ".jk-slash-menu");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-slash-menu")).toMatch(/max-height:\s*200px/);
    const dasar = isiAturan(css, ".jk-slash-menu") ?? "";
    expect(dasar).toMatch(/left:\s*0/);
    expect(dasar).toMatch(/right:\s*0/);
    expect(dasar).toMatch(/min-width:\s*0/);
  });

  test("popover dikte tak dipindahkan oleh aturan layar kecil", () => {
    const isi = isiAturan(css, ".jk-dictation-pop");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/right:\s*0/);
    expect(isi).not.toMatch(/left:/);
  });

  test("pintasan Ctrl K disembunyikan di layar sentuh", () => {
    const blok = blokMedia("hover: none", ".jk-foot-count");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-foot-count")).toMatch(/display:\s*none/);
  });
});
