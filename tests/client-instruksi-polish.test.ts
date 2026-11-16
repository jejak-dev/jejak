import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** CSS tanpa komentar; komentar bisa memuat contoh aturan yang menyesatkan. */
const css = readFileSync(join(root, "src/client/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const halaman = readFileSync(
  join(root, "src/client/components/InstruksiPage.tsx"),
  "utf8",
);

/** Blok <button> yang memakai role="switch". */
function blokSaklar(): string[] {
  return [...halaman.matchAll(/<button[\s\S]*?\/>/g)]
    .map((cocok) => cocok[0])
    .filter((blok) => blok.includes('role="switch"'));
}

describe("saklar pengaturan halaman Instruksi", () => {
  test("dua saklar memakai role switch", () => {
    expect([...halaman.matchAll(/role="switch"/g)]).toHaveLength(2);
    expect(blokSaklar()).toHaveLength(2);
  });

  test("saklar memakai kelas jk-switch dan label status", () => {
    expect(halaman).toContain("jk-switch");
    expect(halaman).toContain("jk-switch-on");
    expect(halaman).toContain("Nonaktif");
    expect(halaman).toContain('aria-label="Muat pengaturan pengguna"');
    expect(halaman).toContain('aria-label="Jalankan hooks Claude"');
  });

  test("saklar tidak lagi memakai aria-pressed atau jk-link-btn", () => {
    for (const blok of blokSaklar()) {
      expect(blok).not.toContain("aria-pressed");
      expect(blok).not.toContain("jk-link-btn");
    }
    expect(halaman).not.toContain('aria-pressed={config.userSettings}');
    expect(halaman).not.toContain('aria-pressed={config.hooksEnabled}');
  });

  test("status saklar ditulis di sebelah kiri dalam wadah kecil", () => {
    expect(halaman).toContain("jk-instruksi-switch-wrap");
    expect(halaman).toContain('<span class="jk-help" aria-hidden="true">');
  });
});

describe("tab halaman Instruksi", () => {
  test("tab aktif punya gaya khusus halaman Instruksi", () => {
    expect(css).toContain(".jk-instruksi-head .jk-panel-tab-active");
    expect(css).toContain(".jk-instruksi-head .jk-panel-tabs");
    expect(css).toContain(".jk-instruksi-head .jk-panel-tab:focus-visible");
  });

  test("aturan umum .jk-panel-tab tidak diubah", () => {
    const umum = css.indexOf("\n.jk-panel-tab {");
    const khusus = css.indexOf(".jk-instruksi-head .jk-panel-tab {");
    expect(umum).toBeGreaterThanOrEqual(0);
    expect(khusus).toBeGreaterThan(umum);
  });
});
