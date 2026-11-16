import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const css = readFileSync(join(root, "src/client/styles.css"), "utf8");
const permissionCard = readFileSync(
  join(root, "src/client/components/PermissionCard.tsx"),
  "utf8",
);

/** Buang komentar CSS supaya selector tak tercemar keterangan. */
const cssBersih = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Isi aturan CSS sederhana (selektor persis). */
function isiAturan(selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(cssBersih);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((bagian) => bagian.trim() === selektor)) {
      return cocok[2] ?? "";
    }
    cocok = pola.exec(cssBersih);
  }
  return undefined;
}

/** Ambil semua blok @media dengan kueri tertentu (isi blok). */
function blokMedia(kueri: string): string[] {
  const hasil: string[] = [];
  const penanda = `@media (${kueri})`;
  let dari = 0;
  for (;;) {
    const mulai = cssBersih.indexOf(penanda, dari);
    if (mulai === -1) return hasil;
    const buka = cssBersih.indexOf("{", mulai);
    let depth = 0;
    let i = buka;
    for (; i < cssBersih.length; i++) {
      if (cssBersih[i] === "{") depth++;
      else if (cssBersih[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    hasil.push(cssBersih.slice(buka + 1, i));
    dari = i + 1;
  }
}

const blokNarrow = blokMedia("max-width: 760px").filter((b) =>
  b.includes(".jk-top-title"),
);

describe("tampilan sesi di layar sempit", () => {
  test("ringkasan pertanyaan bukan monospace", () => {
    const isi = isiAturan(".jk-step-arg-text");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/font-family:\s*inherit/);
    expect(isi).toMatch(/font-size:\s*var\(--fs-small\)/);
  });

  test("nama langkah tak pecah jadi dua baris", () => {
    const isi = isiAturan(".jk-step-name");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/white-space:\s*nowrap/);
  });

  test("blok judul header turun ke baris kedua di HP", () => {
    expect(blokNarrow.length).toBeGreaterThan(0);
    const isi = blokNarrow.join("\n");
    expect(isi).toMatch(/\.jk-top-title\s*\{[^}]*order:\s*\d+/);
  });

  test("kartu izin menandai ringkasan pertanyaan", () => {
    expect(permissionCard).toContain("jk-step-arg-text");
  });
});
