import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Isi blok aturan pertama dengan selektor persis. */
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

describe("pratinjau Markdown berkas", () => {
  test(".jk-file-preview lega dan terbatas lebarnya", () => {
    const aturan = isiAturan(".jk-file-preview") ?? "";
    expect(aturan).toContain("max-width: 760px");
    expect(aturan).toContain("15px/1.75 var(--sans)");
    expect(aturan).toContain("color: var(--ink)");
  });

  test("--link ada di tema terang dan gelap", () => {
    expect(isiAturan(":root") ?? "").toContain("--link: #1d5fb3");
    expect(isiAturan(':root[data-theme="dark"]') ?? "").toContain("--link: #7ab3f0");
    expect(css).toContain("--link: #7ab3f0");
  });

  test("tautan pratinjau memakai var(--link)", () => {
    const aturan = isiAturan(".jk-file-preview .jk-md a") ?? "";
    expect(aturan).toContain("color: var(--link)");
  });

  test("chip gambar .jk-md-img ada", () => {
    const aturan = isiAturan(".jk-md-img") ?? "";
    expect(aturan).toContain("inline-flex");
    expect(aturan).toContain("background: var(--hover)");
  });

  test("judul h1 pratinjau dengan pembatas bawah", () => {
    const aturan = isiAturan(".jk-file-preview .jk-md h1.jk-md-heading") ?? "";
    expect(aturan).toContain("font-size: 1.7em");
    expect(aturan).toContain("border-bottom: 1px solid var(--line)");
  });

  test("paragraf pratinjau tidak abu-abu", () => {
    const aturan = isiAturan(".jk-file-preview .jk-md p") ?? "";
    expect(aturan).toContain("color: var(--ink)");
  });
});
