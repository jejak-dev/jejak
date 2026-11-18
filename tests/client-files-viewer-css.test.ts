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

/** Gabungan isi semua blok aturan dengan selektor persis. */
function semuaAturan(selektor: string): string {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let hasil = "";
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((s) => s.trim() === selektor)) hasil += cocok[2] ?? "";
    cocok = pola.exec(css);
  }
  return hasil;
}

/** Isi blok `@container (min-width: 560px)`. */
function blokContainer(): string {
  const penanda = "@container (min-width: 560px)";
  const mulai = css.indexOf(penanda);
  if (mulai === -1) return "";
  const buka = css.indexOf("{", mulai);
  let kedalaman = 0;
  let i = buka;
  for (; i < css.length; i++) {
    if (css[i] === "{") kedalaman += 1;
    else if (css[i] === "}") {
      kedalaman -= 1;
      if (kedalaman === 0) break;
    }
  }
  return css.slice(buka + 1, i);
}

describe("penampil berkas ala VS Code", () => {
  test("pohon berkas muncul lewat container query 560px", () => {
    const blok = blokContainer();
    expect(blok).not.toBe("");
    expect(blok).toContain(".jk-file-split");
    expect(blok).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*240px/);
  });

  test("variabel --vs-bg ada di tema terang dan gelap", () => {
    const akar = isiAturan(":root") ?? "";
    expect(akar).toContain("--vs-bg: #ffffff");
    const gelap = isiAturan(':root[data-theme="dark"]') ?? "";
    expect(gelap).toContain("--vs-bg: #1e1e1e");
    expect(css).toContain("--vs-bg: #1e1e1e");
  });

  test("token memakai variabel VS Code", () => {
    expect(isiAturan(".tok-keyword")).toContain("var(--vs-keyword)");
    expect(isiAturan(".tok-comment")).toContain("var(--vs-comment)");
    expect(isiAturan(".jk-vs-code .jk-line-hit")).toContain("var(--vs-line-hit)");
  });

  test(".jk-perm-code global tidak berubah", () => {
    const aturan = isiAturan(".jk-perm-code") ?? "";
    expect(aturan).toContain("max-height: 220px");
    expect(aturan).not.toContain("--vs-bg");
  });

  test("penyunting berlapis: textarea transparan dengan caret berwarna", () => {
    const input = semuaAturan(".jk-ce-input");
    expect(input).toContain("color: transparent");
    expect(input).toContain("caret-color: var(--vs-fg)");
    expect(input).toContain("background: transparent");
  });

  test("--vs-selection ada di tema terang dan gelap", () => {
    expect(isiAturan(":root") ?? "").toContain("--vs-selection: #add6ff");
    expect(isiAturan(':root[data-theme="dark"]') ?? "").toContain("--vs-selection: #264f78");
  });

  test("pre sorotan dan textarea memakai font serta line-height sama", () => {
    const hl = semuaAturan(".jk-ce-hl");
    const input = semuaAturan(".jk-ce-input");
    const font = /font:\s*13px\/1\.6 var\(--mono\)/;
    expect(hl).toMatch(font);
    expect(input).toMatch(font);
    expect(hl).toContain("tab-size: 2");
    expect(input).toContain("tab-size: 2");
  });

  test("panel tidak tergulir saat tampilan berkas terbuka", () => {
    const pane = isiAturan(".jk-pane-body:has(.jk-panel-file-view)") ?? "";
    expect(pane).toContain("display: flex");
    expect(pane).toContain("flex-direction: column");
    expect(pane).toContain("overflow: hidden");
    const body = isiAturan(".jk-panel-body:has(.jk-panel-file-view)") ?? "";
    expect(body).toContain("flex: 1");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("display: flex");
  });

  test(".jk-pane-body global tetap tergulir", () => {
    const aturan = isiAturan(".jk-pane-body") ?? "";
    expect(aturan).toContain("overflow-y: auto");
    expect(aturan).not.toContain("overflow: hidden");
  });

  test("kolom kiri dan pohon berkas bergulir sendiri", () => {
    const main = isiAturan(".jk-file-main") ?? "";
    expect(main).toContain("overflow-y: auto");
    expect(main).toContain("min-height: 0");
    const tree = isiAturan(".jk-file-tree") ?? "";
    expect(tree).toContain("overflow-y: auto");
    expect(tree).toContain("min-height: 0");
    expect(tree).toContain("height: 100%");
  });

  test("pemisah berkas mengisi tinggi dan baris grid dibatasi", () => {
    const blok = blokContainer();
    expect(blok).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(blok).toContain("min-height: 0");
  });
});
