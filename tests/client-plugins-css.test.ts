import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function isiAturan(selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((s) => s.trim() === selektor)) return cocok[2] ?? "";
    cocok = pola.exec(css);
  }
  return undefined;
}

describe("CSS daftar plugin ala direktori", () => {
  test("daftar memakai grid auto-fill", () => {
    const aturan = isiAturan(".jk-plugin-list") ?? "";
    expect(aturan).toContain("display: grid");
    expect(aturan).toContain("repeat(auto-fill, minmax(360px, 1fr))");
  });

  test("baris dipisah garis tipis tanpa kotak berbayang", () => {
    const aturan = isiAturan(".jk-plugin-row") ?? "";
    expect(aturan).toContain("border-bottom: 1px solid var(--line-2)");
    expect(aturan).not.toContain("box-shadow");
    expect(aturan).not.toContain("border-radius");
  });

  test("deskripsi dibatasi dua baris", () => {
    const aturan = isiAturan(".jk-plugin-desc") ?? "";
    expect(aturan).toContain("-webkit-line-clamp: 2");
  });

  test("kartu lama sudah dihapus", () => {
    expect(css).not.toContain(".jk-plugin-card");
    expect(css).not.toContain(".jk-plugin-market-card");
  });
});
