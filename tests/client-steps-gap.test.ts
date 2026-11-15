import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Aturan {
  selektor: string;
  isi: string;
}

/** Baca aturan CSS sederhana: daftar selektor dan isinya. */
function aturanCss(css: string): Aturan[] {
  const hasil: Aturan[] = [];
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok: RegExpExecArray | null = pola.exec(css);
  while (cocok !== null) {
    hasil.push({ selektor: cocok[1]?.trim() ?? "", isi: cocok[2] ?? "" });
    cocok = pola.exec(css);
  }
  return hasil;
}

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8");
const aturan = aturanCss(css.replace(/\/\*[\s\S]*?\*\//g, ""));

/** Isi aturan yang selektornya memuat `selektor` di dalam daftar. */
function isiAturan(selektor: string): string | undefined {
  const found = aturan.find((a) => a.selektor.split(",").some((s) => s.trim() === selektor));
  return found?.isi;
}

describe("jarak ringkasan langkah dan teks agen", () => {
  test("jarak antar blok lain tetap 18px", () => {
    const isi = isiAturan(".jk-col");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/gap:\s*18px/);
  });

  test("ringkasan langkah dirapatkan dari teksnya di kedua arah", () => {
    const isi = isiAturan(".jk-col > .jk-steps + .jk-text");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/margin-top:\s*-11px/);
    // texts lalu steps, dan steps lalu steps ikut rapat
    expect(isiAturan(".jk-col > .jk-text + .jk-steps")).toBe(isi);
    expect(isiAturan(".jk-col > .jk-steps + .jk-steps")).toBe(isi);
  });

  test("penyempitan hanya berlaku pada pasangan langkah-teks", () => {
    const isi = isiAturan(".jk-col > .jk-steps + .jk-text") ?? "";
    // tak ada margin negatif yang menyentuh pesan user, kartu izin, atau hasil
    const pasanganLain = aturan.filter((a) =>
      /\.jk-(user|perm|result|notice|danger-box)/.test(a.selektor),
    );
    for (const a of pasanganLain) {
      expect(a.isi).not.toMatch(/margin-top:\s*-/);
    }
    expect(isi).not.toMatch(/margin-bottom/);
  });

  test("baris ringkasan langkah lebih pendek", () => {
    const isi = isiAturan(".jk-steps > summary");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/min-height:\s*26px/);
    expect(isi).not.toMatch(/min-height:\s*30px/);
  });

  test("ringkasan langkah dasar tetap punya tinggi wajar", () => {
    const isi = isiAturan(".jk-step > summary");
    expect(isi).toMatch(/min-height:\s*2[46]px/);
  });
});
