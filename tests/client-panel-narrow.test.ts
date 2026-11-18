import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "src", "client", "styles.css"),
  "utf8",
);
const panelSrc = readFileSync(
  join(import.meta.dir, "..", "src", "client", "components", "Panel.tsx"),
  "utf8",
);
const appSrc = readFileSync(
  join(import.meta.dir, "..", "src", "client", "app.tsx"),
  "utf8",
);

/** Ambil isi blok @media dengan kueri tertentu. */
function blokMedia(kueri: string): string[] {
  const hasil: string[] = [];
  const penanda = `@media (${kueri})`;
  let dari = 0;
  for (;;) {
    const mulai = css.indexOf(penanda, dari);
    if (mulai === -1) return hasil;
    const buka = css.indexOf("{", mulai);
    let depth = 0;
    let i = buka;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    hasil.push(css.slice(buka + 1, i));
    dari = i + 1;
  }
}

const blokSempit = blokMedia("max-width: 959px").filter((b) =>
  b.includes(".jk-panel-rail"),
);

describe("panel di layar sempit: lapisan penuh", () => {
  test("Panel.tsx tidak memasang inline width tanpa syarat sempit", () => {
    const posisi = panelSrc.indexOf("jk-panel${");
    expect(posisi).toBeGreaterThan(-1);
    const segmen = panelSrc
      .slice(posisi, posisi + 200)
      .replace(/\/\/[^\n]*/g, "");
    // Penentuan lebar inline harus bergantung pada flag layar sempit.
    expect(segmen).toMatch(/style=\{[\s\S]*?sempit/);
    expect(segmen).not.toMatch(/style=\{\s*width\s*===/);
  });

  test("flag sempit dihitung sebelum dipakai pada JSX panel", () => {
    const definisi = panelSrc.indexOf("const sempit");
    const pemakaian = panelSrc.indexOf("jk-panel${");
    expect(definisi).toBeGreaterThan(-1);
    expect(definisi).toBeLessThan(pemakaian);
  });

  test("blok media 959px membuat panel lapisan penuh", () => {
    expect(blokSempit.length).toBeGreaterThan(0);
    const isi = blokSempit.join("\n");
    expect(isi).toMatch(/\.jk-panel\s*\{[^}]*position:\s*absolute/);
    expect(isi).toMatch(/\.jk-panel\s*\{[^}]*width:\s*auto/);
  });

  test("batas lebar aturan dasar dilepas di layar sempit", () => {
    expect(blokSempit.length).toBeGreaterThan(0);
    const isi = blokSempit.join("\n");
    expect(isi).toMatch(/\.jk-panel\s*\{[^}]*max-width:\s*none/);
  });
});

describe("rel ikon di layar sempit: bisa digulir mendatar", () => {
  test("rel memakai overflow-x auto dan overflow-y hidden", () => {
    expect(blokSempit.length).toBeGreaterThan(0);
    const isi = blokSempit.join("\n");
    expect(isi).toMatch(/\.jk-panel-rail\s*\{[^}]*overflow-x:\s*auto/);
    expect(isi).toMatch(/\.jk-panel-rail\s*\{[^}]*overflow-y:\s*hidden/);
    expect(isi).not.toMatch(/\.jk-panel-rail\s*\{[^}]*overflow:\s*hidden/);
  });

  test("pusat aman dipakai, dengan fallback flex-start", () => {
    const isi = blokSempit.join("\n");
    const aturan = isi.match(/\.jk-panel-rail\s*\{[^}]*\}/)?.[0] ?? "";
    const posisiAman = aturan.indexOf("justify-content: safe center");
    const posisiCadangan = aturan.indexOf("justify-content: flex-start");
    expect(posisiAman).toBeGreaterThan(-1);
    expect(posisiCadangan).toBeGreaterThan(-1);
    // Fallback ditulis lebih dulu agar peramban tanpa `safe` menimpanya.
    expect(posisiCadangan).toBeLessThan(posisiAman);
  });

  test("ikon rel tak menyusut", () => {
    const isi = blokSempit.join("\n");
    expect(isi).toMatch(/\.jk-rail-btn\s*\{[^}]*flex:\s*none/);
    expect(isi).toMatch(/\.jk-rail-btn\s*\{[^}]*width:\s*32px/);
    expect(isi).toMatch(/\.jk-rail-btn\s*\{[^}]*height:\s*40px/);
  });

  test("scrollbar rel tetap disembunyikan di aturan dasar", () => {
    const dasar = css.match(/\.jk-panel-rail\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dasar).toMatch(/scrollbar-width:\s*none/);
    expect(css).toMatch(/\.jk-panel-rail::\-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  });
});

describe("pegangan geser panel di layar sempit", () => {
  test("pegangan geser panel tak dirender saat layar sempit", () => {
    const posisi = appSrc.indexOf('label="Lebar panel"');
    expect(posisi).toBeGreaterThan(-1);
    const segmen = appSrc.slice(Math.max(0, posisi - 400), posisi);
    expect(segmen).toMatch(/panelOpen(?:Now)?\s*&&\s*!\s*sempit/);
  });
});
