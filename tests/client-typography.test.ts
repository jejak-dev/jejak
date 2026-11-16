import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "src", "client", "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Satu aturan CSS: selektor persis (sudah dipecah per koma) dan isinya. */
interface Aturan {
  selektor: string;
  isi: string;
}

/** Aturan CSS apa adanya: daftar selektor dan isinya. */
interface Blok {
  selektor: string[];
  isi: string;
}

const aturan: Aturan[] = [];
const blok: Blok[] = [];
{
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const isiBlok = cocok[2] ?? "";
    const daftar = (cocok[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    blok.push({ selektor: daftar, isi: isiBlok });
    for (const bersih of daftar) aturan.push({ selektor: bersih, isi: isiBlok });
    cocok = pola.exec(css);
  }
}

/** Isi aturan yang memuat salah satu selektor yang diminta. */
function isi(...selektor: string[]): string {
  const found = aturan.find((a) => selektor.includes(a.selektor));
  expect(found).toBeDefined();
  return found!.isi;
}

/** Isi aturan yang selektornya tunggal, persis seperti yang diminta. */
function isiTunggal(selektor: string): string {
  const found = blok.find((b) => b.selektor.length === 1 && b.selektor[0] === selektor);
  expect(found).toBeDefined();
  return found!.isi;
}

/** Selektor yang memang dibiarkan kecil, beserta sisa ukurannya dan alasannya. */
const KECUALIAN: { selektor: string; sisa: string; alasan: string }[] = [
  {
    selektor: ".jk-ask-tab-mark",
    sisa: "11px",
    alasan: "isi glyph (tanda centang/angka) di dalam lingkaran",
  },
  { selektor: ".jk-git-section-title", sisa: "11.5px", alasan: "label kecil uppercase" },
  { selektor: ".jk-memory-revision-label", sisa: "11px", alasan: "label kecil uppercase" },
  { selektor: ".jk-audit-table th", sisa: "11px", alasan: "label kecil uppercase" },
  { selektor: ".jk-usage-card-label", sisa: "11px", alasan: "label kecil uppercase" },
  { selektor: ".jk-usage-table th", sisa: "11px", alasan: "label kecil uppercase" },
  {
    selektor: ".jk-rail-badge",
    sisa: "10px",
    alasan: "badge angka menempel pada ikon rail; ukurannya dikunci geometri gelembung",
  },
];

const selektorKecualian = new Set(KECUALIAN.map((k) => k.selektor));
const polaKecil = /font(?:-size)?\s*:\s*11(?:\.5)?px/;
const polaBawahLantai = /font(?:-size)?\s*:\s*(?:10(?:\.5)?px|11(?:\.5)?px)/;

describe("skala tipe Jejak", () => {
  test(":root memuat keempat token ukuran", () => {
    const root = isiTunggal(":root");
    expect(root).toMatch(/--fs-ui:\s*14px/);
    expect(root).toMatch(/--fs-body:\s*15\.5px/);
    expect(root).toMatch(/--fs-small:\s*12\.5px/);
    expect(root).toMatch(/--fs-micro:\s*12px/);
  });

  test("body memakai token ukuran antarmuka", () => {
    expect(isiTunggal("body")).toMatch(/font-size:\s*var\(--fs-ui\)/);
  });

  test("teks jawaban agen memakai serif ukuran badan", () => {
    const teks = isiTunggal(".jk-text");
    expect(teks).toMatch(/font-family:\s*var\(--serif\)/);
    expect(teks).toMatch(/font-size:\s*var\(--fs-body\)/);
  });

  test("pesan user berukuran tetap dan tetap sans", () => {
    const user = isiTunggal(".jk-user");
    expect(user).toMatch(/font-size:\s*14\.5px/);
    expect(user).not.toMatch(/font-family:\s*var\(--serif\)/);
  });

  test("kode di dalam teks agen tetap monospasi ukuran tetap", () => {
    const kode = isi(".jk-text code", ".jk-text pre");
    expect(kode).toMatch(/font-family:\s*var\(--mono\)/);
    expect(kode).toMatch(/font-size:\s*12\.5px/);
  });

  test("tabel dan baris tombol di dalam markdown tetap sans", () => {
    expect(isiTunggal(".jk-md table")).toMatch(/font-family:\s*var\(--sans\)/);
    expect(isiTunggal(".jk-md-foot")).toMatch(/font-family:\s*var\(--sans\)/);
  });

  test("tak ada ukuran 11px atau 11.5px di luar daftar kekecualian", () => {
    const tersinggung = new Set<string>();
    for (const a of aturan) {
      if (!polaKecil.test(a.isi)) continue;
      if (!selektorKecualian.has(a.selektor)) tersinggung.add(a.selektor);
    }
    expect([...tersinggung]).toEqual([]);
  });

  test("kekecualian masih berlaku dan punya alasan", () => {
    for (const k of KECUALIAN) {
      expect(k.alasan.length).toBeGreaterThan(0);
      const a = aturan.find((x) => x.selektor === k.selektor);
      expect(a).toBeDefined();
      expect(a!.isi).toMatch(new RegExp(`font(?:-size)?\\s*:\\s*${k.sisa}`));
    }
  });

  test("tak ada ukuran di bawah lantai 12px", () => {
    const tersinggung = new Set<string>();
    for (const a of aturan) {
      if (!polaBawahLantai.test(a.isi)) continue;
      if (!selektorKecualian.has(a.selektor)) tersinggung.add(a.selektor);
    }
    expect([...tersinggung]).toEqual([]);
  });
});
