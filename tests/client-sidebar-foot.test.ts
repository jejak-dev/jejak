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

/** Isi blok <details class="jk-foot-more"> beserta isinya. */
function isiMore(sumber: string): string {
  const mulai = sumber.indexOf('<details\n              class="jk-foot-more"');
  const alternatif = sumber.indexOf('<details class="jk-foot-more"');
  const awal = mulai >= 0 ? mulai : alternatif;
  const akhir = sumber.indexOf("</details>", awal);
  expect(awal).toBeGreaterThanOrEqual(0);
  expect(akhir).toBeGreaterThan(awal);
  return sumber.slice(awal, akhir);
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

  test("Workspace dan Memory satu kelompok", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[1]).toEqual(["Workspace", "Memory"]);
  });

  test("Lainnya memuat lima tautan dalam satu details", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[2]).toEqual([
      "Lainnya",
      "Server MCP",
      "Instruksi",
      "Jadwal",
      "Pemakaian",
      "Log audit",
    ]);
  });

  test("Pengaturan satu kelompok penuh, Tema dan Notifikasi jadi tombol ikon", () => {
    const groups = kelompok(isiFooter(sidebar));
    expect(groups[3]).toEqual(["Pengaturan", "Keluar"]);
    // Baris ikon tidak punya label teks.
    expect(groups[4]).toEqual([]);
    const footer = isiFooter(sidebar);
    expect(footer).not.toContain('<span class="jk-foot-text">Tema</span>');
    expect(footer).not.toContain('<span class="jk-foot-text">Notifikasi</span>');
  });

  test("setiap kelompok memakai pembungkus jk-foot-group tanpa aria-label", () => {
    const footer = isiFooter(sidebar);
    const pembungkus = [...footer.matchAll(/<div class="jk-foot-group"[^>]*>/g)].map((m) => m[0]);
    expect(pembungkus.length).toBeGreaterThanOrEqual(5);
    for (const tag of pembungkus) {
      expect(tag).toContain('role="group"');
      expect(tag).not.toContain("aria-label");
    }
  });
});

describe("kelompok Lainnya yang dilipat", () => {
  test("memakai details jk-foot-more dengan ringkasan berlabel Lainnya", () => {
    const more = isiMore(sidebar);
    expect(more).toContain('class="jk-foot-more"');
    expect(more).toContain("<summary");
    expect(more).toContain('class="jk-foot-link"');
    expect(more).toContain('<span class="jk-foot-text">Lainnya</span>');
    expect(more).toContain('class="jk-foot-chev"');
    expect(more).toContain('name="chevron-down"');
  });

  test("isi details memuat lima tautan dengan kelas dan href yang sama", () => {
    const more = isiMore(sidebar);
    for (const [teks, href] of [
      ["Server MCP", "#/mcp"],
      ["Instruksi", "#/instruksi"],
      ["Jadwal", "#/schedules"],
      ["Pemakaian", "#/usage"],
      ["Log audit", "#/audit"],
    ] as const) {
      expect(more).toContain(`href="${href}"`);
      expect(more).toContain(`<span class="jk-foot-text">${teks}</span>`);
      expect(more).toContain("jk-foot-link");
    }
  });

  test("penanda rute aktif tetap ada di dalam isi details", () => {
    const more = isiMore(sidebar);
    for (const aktif of ["mcpActive", "instruksiActive", "schedulesActive", "usageActive", "auditActive"]) {
      expect(more).toContain(aktif);
      expect(more).toContain('aria-current={');
    }
  });

  test("pilihan buka/tutup disimpan di localStorage dengan kunci jejak.sidebar.more", () => {
    expect(sidebar).toContain('"jejak.sidebar.more"');
    expect(sidebar).toContain('window.localStorage.getItem(MORE_STORAGE_KEY) === "1"');
    expect(sidebar).toContain('window.localStorage.setItem(MORE_STORAGE_KEY, nilai ? "1" : "0")');
  });

  test("keadaan terbuka berasal dari rute aktif atau pilihan pengguna", () => {
    expect(sidebar).toContain("mcpActive || instruksiActive || schedulesActive || usageActive || auditActive");
    expect(sidebar).toContain("moreAktif || bacaMorePref()");
    expect(sidebar).toContain("open={moreTerbuka}");
  });
});

describe("tombol ikon Tema dan Notifikasi", () => {
  test("berada di satu baris jk-foot-icons tanpa teks tampil", () => {
    const footer = isiFooter(sidebar);
    expect(footer).toContain('<div class="jk-foot-icons">');
    const baris = footer.slice(footer.indexOf('<div class="jk-foot-icons">'));
    expect(baris).toContain('jk-foot-icon');
    expect(baris).not.toContain('<span class="jk-foot-text">');
  });

  test("aria-label dan title memuat nama dan status", () => {
    const footer = isiFooter(sidebar);
    expect(footer).toContain('aria-label={`Tema: ${themeLabel(theme)}. Klik untuk mengganti.`}');
    expect(footer).toContain('title={`Tema: ${themeLabel(theme)}`}');
    expect(footer).toContain(
      'aria-label={`Notifikasi: ${notifyPrefs.enabled ? "Aktif" : "Mati"}`}',
    );
    expect(footer).toContain(
      'title={`Notifikasi: ${notifyPrefs.enabled ? "Aktif" : "Mati"}`}',
    );
  });

  test("Notifikasi aktif tetap memakai gaya jk-foot-link-active", () => {
    const footer = isiFooter(sidebar);
    expect(footer).toContain('jk-foot-icon${notifyPrefs.enabled ? " jk-foot-link-active" : ""}');
  });

  test("handler tema dan notifikasi tetap sama", () => {
    const footer = isiFooter(sidebar);
    expect(footer).toContain("onClick={cycleTheme}");
    expect(footer).toContain("setNotifyOpen((open) => !open)");
    expect(footer).toContain("aria-expanded={notifyOpen}");
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

describe("gaya footer", () => {
  test("jk-foot-more tanpa border atau background sendiri", () => {
    const isi = isiAturan(css, ".jk-foot-more");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/border:\s*0/);
    expect(isi).toMatch(/background:\s*transparent/);
  });

  test("ringkasan menyembunyikan penanda bawaan", () => {
    expect(isiAturan(css, ".jk-foot-more > summary")).toMatch(/list-style:\s*none/);
    expect(isiAturan(css, ".jk-foot-more > summary::-webkit-details-marker")).toMatch(
      /display:\s*none/,
    );
  });

  test("chevron kecil 10px dan berputar saat terbuka", () => {
    const chev = isiAturan(css, ".jk-foot-chev .jk-icon");
    expect(chev).toMatch(/width:\s*10px/);
    expect(chev).toMatch(/height:\s*10px/);
    expect(isiAturan(css, ".jk-foot-more[open] .jk-foot-chev")).toMatch(/rotate\(180deg\)/);
  });

  test("baris ikon flex dengan gap 4px dan tombol 32x32", () => {
    const baris = isiAturan(css, ".jk-foot-icons");
    expect(baris).toBeDefined();
    expect(baris).toMatch(/display:\s*flex/);
    expect(baris).toMatch(/gap:\s*4px/);
    const tombol = isiAturan(css, ".jk-foot-icon");
    expect(tombol).toBeDefined();
    expect(tombol).toMatch(/width:\s*32px/);
    expect(tombol).toMatch(/height:\s*32px/);
  });

  test("pemisah kelompok footer", () => {
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
