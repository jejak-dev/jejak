import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "src", "client", "styles.css"),
  "utf8",
);

/** Ambil semua blok @media dengan kueri tertentu (posisi + isi). */
function blokMedia(kueri: string): { mulai: number; isi: string }[] {
  const hasil: { mulai: number; isi: string }[] = [];
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
    hasil.push({ mulai, isi: css.slice(buka + 1, i) });
    dari = i + 1;
  }
}

/** Escape regex untuk teks biasa. */
function esc(teks: string): string {
  return teks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const blokNarrow = blokMedia("max-width: 760px").filter((b) =>
  b.isi.includes(".jk-top-title"),
);

describe("header di layar sempit", () => {
  test("ada blok media 760px yang menangani judul header", () => {
    expect(blokNarrow.length).toBeGreaterThan(0);
  });

  test("judul boleh membungkus dan ambil satu baris penuh", () => {
    const isi = blokNarrow.map((b) => b.isi).join("\n");
    expect(isi).toMatch(/\.jk-top-title\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(isi).toMatch(/\.jk-top-title\s*h2\s*\{[^}]*flex:\s*1\s+1\s+100%/);
  });

  test("empat lencana tak boleh menyusut sampai teksnya hilang", () => {
    const isi = blokNarrow.map((b) => b.isi).join("\n");
    for (const kelas of [
      ".jk-worktree-badge",
      ".jk-secret-badge",
      ".jk-budget-badge",
      ".jk-sandbox-badge",
    ]) {
      expect(isi).toMatch(new RegExp(`${esc(kelas)}[^}]*\\{\\s*flex:\\s*none`));
      expect(
        isi,
      ).toMatch(new RegExp(`${esc(kelas)}[^}]*\\{[^}]*max-width:\\s*100%`));
    }
  });

  test("blok media diletakkan setelah aturan dasar agar menimpanya", () => {
    // Aturan badge dasar (~5290) dan aturan judul (~813) harus lebih dulu.
    const posisiBadge = css.indexOf(".jk-worktree-badge {");
    const posisiJudul = css.indexOf(".jk-top-title {");
    expect(posisiBadge).toBeGreaterThan(-1);
    expect(posisiJudul).toBeGreaterThan(-1);
    for (const blok of blokNarrow) {
      expect(blok.mulai).toBeGreaterThan(posisiBadge);
      expect(blok.mulai).toBeGreaterThan(posisiJudul);
    }
  });
});
