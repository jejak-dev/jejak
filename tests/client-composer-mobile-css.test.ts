import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Isi blok `@media (kondisi)` pertama yang memuat `penyebut`. */
function blokMedia(kondisi: string, penyebut: string): string {
  const pola = new RegExp(`@media\\s*\\(${kondisi}\\)\\s*\\{`, "g");
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const mulai = cocok.index + cocok[0].length;
    let kedalaman = 1;
    let i = mulai;
    while (i < css.length && kedalaman > 0) {
      if (css[i] === "{") kedalaman += 1;
      else if (css[i] === "}") kedalaman -= 1;
      i += 1;
    }
    const isi = css.slice(mulai, i - 1);
    if (isi.includes(penyebut)) return isi;
    cocok = pola.exec(css);
  }
  return "";
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

  test("mikrofon dikte tetap ada di layar kecil", () => {
    const blok = blokMedia("max-width: 640px", ".jk-dictation-btn");
    expect(blok).not.toBe("");
    const isi = isiAturan(blok, ".jk-dictation-btn") ?? "";
    expect(isi).toMatch(/width:\s*36px/);
    expect(isi).toMatch(/height:\s*36px/);
    expect(isi).toMatch(/min-width:\s*36px/);
    expect(isi).toMatch(/min-height:\s*36px/);
  });

  test("jarak komposer dirapatkan di layar kecil", () => {
    const blok = blokMedia("max-width: 640px", ".jk-pill-row");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-pill-row")).toMatch(/gap:\s*4px/);
    expect(isiAturan(blok, ".jk-comp-card")).toMatch(/padding:\s*8px/);
    expect(isiAturan(blok, ".jk-pill-row .jk-comp-input")).toMatch(/min-height:\s*40px/);
    expect(isiAturan(blok, ".jk-pill-row .jk-comp-input")).toMatch(/line-height:\s*1\.4/);
  });

  test("chip di bawah komposer tak berdesakan di layar kecil", () => {
    const blok = blokMedia("max-width: 640px", ".jk-comp-meta");
    expect(blok).not.toBe("");
    expect(isiAturan(blok, ".jk-comp-meta")).toMatch(/gap:\s*4px 4px/);
    expect(isiAturan(blok, ".jk-comp-meta")).toMatch(/padding:\s*0 4px/);
    expect(isiAturan(blok, ".jk-comp-meta .jk-chip")).toMatch(/padding:\s*0 7px/);
    expect(isiAturan(blok, ".jk-select.jk-chip-select .jk-select-label")).toMatch(
      /max-width:\s*110px/,
    );
    expect(isiAturan(blok, ".jk-chip-input")).toMatch(/min-width:\s*0/);
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
