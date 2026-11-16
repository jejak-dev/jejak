import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sidebar = readFileSync(join(root, "src/client/components/Sidebar.tsx"), "utf8");
const css = readFileSync(join(root, "src/client/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Isi blok footer sidebar. */
function isiFooter(sumber: string): string {
  const mulai = sumber.indexOf('<footer class="jk-sidebar-foot">');
  const akhir = sumber.indexOf("</footer>", mulai);
  expect(mulai).toBeGreaterThanOrEqual(0);
  expect(akhir).toBeGreaterThan(mulai);
  return sumber.slice(mulai, akhir);
}

/** Label footer dikelompokkan menurut pembungkus `.jk-foot-group`. */
function kelompok(footer: string): string[][] {
  const penanda = [...footer.matchAll(/class="jk-foot-group"/g)].map((m) => m.index ?? 0);
  const label = [...footer.matchAll(/<span class="jk-foot-text">([^<]*)<\/span>/g)].map((m) => ({
    pos: m.index ?? 0,
    teks: m[1] ?? "",
  }));
  const hasil: string[][] = penanda.map(() => []);
  for (const item of label) {
    const indeks = Math.max(0, penanda.filter((pos) => pos < item.pos).length - 1);
    hasil[indeks]?.push(item.teks);
  }
  return hasil;
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

describe("kelompok footer sidebar", () => {
  test("Perintah berada di kelompok sendiri sebelum Workspace", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[0]).toEqual(["Perintah"]);
    expect(groups[1]?.[0]).toBe("Workspace");
  });

  test("Workspace, Memory, Server MCP, Instructions, dan Schedules satu kelompok berurutan", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[1]).toEqual([
      "Workspace",
      "Memory",
      "Server MCP",
      "Instructions",
      "Schedules",
    ]);
  });

  test("Usage dan Audit log satu kelompok", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[2]).toEqual(["Usage", "Audit log"]);
  });

  test("Pengaturan, Tema, dan Notifications satu kelompok", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[3]?.slice(0, 3)).toEqual(["Pengaturan", "Tema", "Notifications"]);
    expect(groups[3]).toContain("Keluar");
  });

  test("setiap kelompok memakai pembungkus jk-foot-group tanpa aria-label", () => {
    const footer = isiFooter(sidebar);
    const pembungkus = [...footer.matchAll(/<div class="jk-foot-group"[^>]*>/g)].map((m) => m[0]);
    expect(pembungkus.length).toBeGreaterThanOrEqual(4);
    for (const tag of pembungkus) {
      expect(tag).toContain('role="group"');
      expect(tag).not.toContain("aria-label");
    }
  });
});

describe("tautan Pengaturan di footer", () => {
  test("berlabel Pengaturan dengan ikon gear dan nama profil di sisi kanan", () => {
    const mulai = sidebar.indexOf('href="#/providers"');
    const akhir = sidebar.indexOf("</a>", mulai);
    expect(mulai).toBeGreaterThanOrEqual(0);
    const tautan = sidebar.slice(mulai, akhir);
    expect(tautan).toContain('name="gear"');
    expect(tautan).toContain("<span class=\"jk-foot-text\">Pengaturan</span>");
    expect(tautan).toContain('class="jk-foot-count"');
    expect(tautan).toContain("Atur provider");
    expect(tautan).toContain("aria-label=");
  });

  test("label lama Set up provider tak lagi dipakai", () => {
    expect(sidebar).not.toContain("Set up provider");
  });
});

describe("pemisah kelompok footer", () => {
  test("aturan garis tipis antar kelompok ada", () => {
    const isi = isiAturan(css, ".jk-foot-group + .jk-foot-group");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/border-top:\s*1px solid var\(--line\)/);
    expect(isi).toMatch(/margin-top:\s*6px/);
    expect(isi).toMatch(/padding-top:\s*6px/);
  });
});

describe("garis ganda di halaman Pengaturan", () => {
  test("bagian pertama di bawah navigasi tanpa border atas", () => {
    const isi = isiAturan(css, ".jk-settings-nav + section");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/border-top:\s*0/);
    expect(isi).toMatch(/margin-top:\s*0/);
    expect(isi).toMatch(/padding-top:\s*0/);
  });
});
