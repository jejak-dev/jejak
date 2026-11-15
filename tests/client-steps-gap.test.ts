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

/** Isi blok `@media (hover: none)` yang memuat `penyebut`. */
function blokHoverNone(css: string, penyebut: string): string {
  const pola = /@media\s*\(hover:\s*none\)\s*\{/g;
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

describe("jarak ringkasan langkah dan teks agen", () => {
  test("jarak antar blok lain tetap 18px", () => {
    const isi = isiAturan(".jk-col");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/gap:\s*18px/);
  });

  test("ringkasan langkah dirapatkan dari teksnya di kedua arah", () => {
    const isi = isiAturan(".jk-col > .jk-steps + .jk-text");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/margin-top:\s*-14px/);
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

  test("blok isi terakhir markdown tak menambah margin bawah", () => {
    const isi = isiAturan(".jk-md > *:has(+ .jk-md-foot)");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/margin-bottom:\s*0/);
  });
});

describe("baris tombol salin tak memakai ruang", () => {
  test("baris .jk-md-foot bertinggi 0 dan tombolnya absolut", () => {
    const isi = isiAturan(".jk-md-foot");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/height:\s*0/);
    expect(isi).toMatch(/margin:\s*0/);
    expect(isi).toMatch(/position:\s*relative/);

    const tombol = isiAturan(".jk-md-foot .jk-copy");
    expect(tombol).toBeDefined();
    expect(tombol).toMatch(/position:\s*absolute/);
    expect(tombol).toMatch(/right:\s*0/);
    expect(tombol).toMatch(/top:\s*2px/);
  });

  test("tombol tersembunyi tak menangkap klik blok di bawahnya", () => {
    const tombol = isiAturan(".jk-md-foot .jk-copy");
    expect(tombol).toMatch(/opacity:\s*0/);
    expect(tombol).toMatch(/pointer-events:\s*none/);
  });

  test("hover dan fokus fokus keyboard menghidupkan tombol", () => {
    const aktif = isiAturan(".jk-md:hover .jk-md-foot .jk-copy");
    expect(aktif).toBeDefined();
    expect(aktif).toMatch(/opacity:\s*1/);
    expect(aktif).toMatch(/pointer-events:\s*auto/);
    // aturan :focus-within memakai isi yang sama
    expect(isiAturan(".jk-md:focus-within .jk-md-foot .jk-copy")).toBe(aktif);
  });

  test("layar sentuh kembali ke alur normal agar tombol bisa diketuk", () => {
    const blok = blokHoverNone(css, ".jk-md-foot");
    expect(blok).not.toBe("");
    const aturanSentuh = aturanCss(blok);

    const foot = aturanSentuh.find((a) =>
      a.selektor.split(",").some((s) => s.trim() === ".jk-md-foot"),
    );
    expect(foot?.isi).toMatch(/height:\s*auto/);
    expect(foot?.isi).toMatch(/margin:\s*6px 0 0/);

    const tombol = aturanSentuh.find((a) =>
      a.selektor.split(",").some((s) => s.trim() === ".jk-md-foot .jk-copy"),
    );
    expect(tombol?.isi).toMatch(/position:\s*static/);
    expect(tombol?.isi).toMatch(/opacity:\s*1/);
    expect(tombol?.isi).toMatch(/pointer-events:\s*auto/);
  });

  test("baris tombol salin tak menambah tinggi layout di luar mode sentuh", () => {
    // dua aturan .jk-md-foot: yang pertama untuk perangkat berkemampuan hover,
    // yang kedua di dalam @media (hover: none) untuk layar sentuh.
    const semua = aturan.filter((a) =>
      a.selektor.split(",").some((s) => s.trim() === ".jk-md-foot"),
    );
    expect(semua).toHaveLength(2);
    expect(semua[0]?.isi).toMatch(/height:\s*0/);
    expect(semua[1]?.isi).toMatch(/height:\s*auto/);
  });
});
