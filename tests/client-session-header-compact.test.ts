import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const header = readFileSync(
  join(root, "src/client/components/SessionHeader.tsx"),
  "utf8",
);
const css = readFileSync(join(root, "src/client/styles.css"), "utf8");

/** Isi aturan CSS sederhana (selektor persis). */
function isiAturan(selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((bagian) => bagian.trim() === selektor)) {
      return cocok[2] ?? "";
    }
    cocok = pola.exec(css);
  }
  return undefined;
}

/** Potongan JSX lencana rahasia di berkas header. */
function blokLencana(): string {
  const mulai = header.indexOf('class="jk-secret-badge"');
  expect(mulai).toBeGreaterThan(-1);
  const akhir = header.indexOf(")}", mulai);
  expect(akhir).toBeGreaterThan(mulai);
  return header.slice(mulai, akhir);
}

describe("header sesi lebih ringan", () => {
  test("subjudul header memakai sessionSubtitle, bukan sessionContextLabel", () => {
    expect(header).toContain("sessionSubtitle");
    expect(header).toMatch(/subtitle:\s*sessionSubtitle\(/);
    expect(header).not.toContain("sessionContextLabel");
  });

  test("lencana rahasia hanya ikon perisai tanpa teks label", () => {
    const blok = blokLencana();
    expect(blok).not.toContain("<span>{secretBadge.label}</span>");
    expect(blok).not.toMatch(/\/>\s*\{secretBadge\.label\}/);
    expect(blok).toContain('<Icon name="shield" />');
  });

  test("lencana rahasia tetap punya title dan aria-label", () => {
    const blok = blokLencana();
    expect(blok).toContain("title={secretBadge.title}");
    expect(blok).toContain("aria-label={secretBadge.ariaLabel ?? secretBadge.label}");
  });

  test("lencana rahasia jadi kapsul kecil", () => {
    const isi = isiAturan(".jk-secret-badge");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/padding:\s*2px 5px/);
  });
});
