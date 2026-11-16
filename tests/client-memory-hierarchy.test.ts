import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hierarki judul di halaman Memory: judul halaman (h2) tetap besar,
 * sedangkan judul sub-bagian (h3) memakai kelas terpisah.
 */

const ROOT = join(import.meta.dir, "..");
const CLIENT = join(ROOT, "src", "client");

function baca(relatif: string): string {
  return readFileSync(join(CLIENT, relatif), "utf8");
}

/** Semua tag pembuka h3 pada isi berkas. */
function tagH3(isi: string): string[] {
  return isi.match(/<h3\b[^>]*>/g) ?? [];
}

describe("hierarki judul halaman Memory", () => {
  test("h3 di ClaudeMemorySync memakai jk-subsection-title", () => {
    const isi = baca(join("components", "ClaudeMemorySync.tsx"));
    const h3 = tagH3(isi);
    expect(h3.length).toBeGreaterThan(0);
    for (const tag of h3) {
      expect(tag).toContain("jk-subsection-title");
      expect(tag).not.toContain("jk-settings-title");
    }
  });

  test("h3 di ClaudeMemorySection memakai jk-subsection-title", () => {
    const isi = baca(join("components", "ClaudeMemorySection.tsx"));
    const h3 = tagH3(isi);
    expect(h3.length).toBeGreaterThan(0);
    for (const tag of h3) {
      expect(tag).toContain("jk-subsection-title");
      expect(tag).not.toContain("jk-settings-title");
    }
  });

  test("CSS menyediakan .jk-subsection-title dengan font-size 19px", () => {
    const css = baca("styles.css");
    const blok = css.match(/\.jk-subsection-title\s*\{[^}]*\}/);
    expect(blok).not.toBeNull();
    expect(blok?.[0]).toContain("font-size: 19px");
    // Judul halaman tetap memakai kelas lamanya.
    expect(css).toMatch(/\.jk-settings-title\s*\{[^}]*font-size: 28px/);
  });

  test("h2 di MemoryPage tetap memakai jk-settings-title", () => {
    const isi = baca(join("components", "MemoryPage.tsx"));
    const h2 = isi.match(/<h2\b[^>]*>/g) ?? [];
    expect(h2.length).toBeGreaterThan(0);
    for (const tag of h2) {
      expect(tag).toContain("jk-settings-title");
      expect(tag).not.toContain("jk-subsection-title");
    }
  });
});
