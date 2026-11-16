import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8");

/** Ambil isi blok CSS yang diawali selector tertentu. */
function blok(selector: string): string {
  const mulai = css.indexOf(selector);
  expect(mulai).toBeGreaterThan(-1);
  const buka = css.indexOf("{", mulai);
  const tutup = css.indexOf("}", buka);
  return css.slice(buka + 1, tutup);
}

/** Ambil nilai token warna dari isi blok. */
function token(blokIsi: string, nama: string): string {
  const cocok = blokIsi.match(new RegExp(`${nama}:\\s*(#[0-9a-fA-F]{6})`));
  expect(cocok).not.toBeNull();
  return cocok![1]!;
}

function rgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminans(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rasio kontras WCAG antara dua warna. */
function rasio(a: string, b: string): number {
  const la = luminans(a);
  const lb = luminans(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const terang = blok(":root {");
const gelapSistem = blok(':root:not([data-theme="light"]) {');
const gelapAtribut = blok(':root[data-theme="dark"] {');

describe("kontras token warna", () => {
  for (const [nama, isi] of [
    ["terang", terang],
    ["gelap (sistem)", gelapSistem],
    ["gelap (atribut)", gelapAtribut],
  ] as const) {
    test(`token teks lolos WCAG AA di tema ${nama}`, () => {
      const latar = ["--bg", "--side", "--surface"].map((n) => token(isi, n));
      for (const namaToken of ["--t3", "--warn", "--ok", "--bad"]) {
        const warna = token(isi, namaToken);
        for (const bg of latar) {
          const r = rasio(warna, bg);
          expect(r).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`hierarki t1 > t2 > t3 terjaga di tema ${nama}`, () => {
      const bg = token(isi, "--bg");
      const t1 = rasio(token(isi, "--t1"), bg);
      const t2 = rasio(token(isi, "--t2"), bg);
      const t3 = rasio(token(isi, "--t3"), bg);
      expect(t1).toBeGreaterThan(t2);
      expect(t2).toBeGreaterThan(t3);
    });
  }

  test("token t3, warn, dan ok sinkron di ketiga blok tema", () => {
    for (const namaToken of ["--t3", "--warn", "--ok", "--bad"]) {
      const nilaiGelapSistem = token(gelapSistem, namaToken);
      expect(token(gelapAtribut, namaToken)).toBe(nilaiGelapSistem);
    }
    expect(token(terang, "--t3")).toBe("#6f6c65");
    expect(token(terang, "--warn")).toBe("#9e5c0c");
    expect(token(terang, "--ok")).toBe("#2e7a4d");
    expect(token(gelapAtribut, "--t3")).toBe("#908d85");
  });
});
