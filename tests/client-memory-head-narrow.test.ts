import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "src", "client", "styles.css"),
  "utf8",
);

describe("kepala Memory di layar sempit", () => {
  test("grup tab tak boleh menyusut sehingga teksnya hilang", () => {
    expect(css).toMatch(
      /\.jk-memory-head\s*>\s*\.jk-panel-tabs\s*\{[^}]*flex:\s*none/,
    );
  });

  test("grup tab dibatasi lebar wadah", () => {
    expect(css).toMatch(
      /\.jk-memory-head\s*>\s*\.jk-panel-tabs\s*\{[^}]*max-width:\s*100%/,
    );
  });

  test("aturan diletakkan setelah aturan dasar .jk-memory-head", () => {
    const posisiDasar = css.indexOf(".jk-memory-head {");
    const posisiAnak = css.indexOf(".jk-memory-head > .jk-panel-tabs {");
    expect(posisiDasar).toBeGreaterThan(-1);
    expect(posisiAnak).toBeGreaterThan(posisiDasar);
  });
});
