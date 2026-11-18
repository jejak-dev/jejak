import { describe, expect, test } from "bun:test";
import { prepareMarkdownPreview } from "../src/client/lib/md-preview";

describe("prepareMarkdownPreview", () => {
  test("img dengan alt menjadi markdown gambar", () => {
    expect(prepareMarkdownPreview('<img src="a.png" alt="Logo">')).toContain("![Logo](a.png)");
    expect(prepareMarkdownPreview("<img alt='B' src='b.png'>")).toContain("![B](b.png)");
  });

  test("img tanpa src memakai # dan tanpa alt memakai gambar", () => {
    expect(prepareMarkdownPreview('<img alt="X">')).toContain("![X](#)");
    expect(prepareMarkdownPreview('<img src="c.png">')).toContain("![gambar](c.png)");
  });

  test("tautan berisi gambar", () => {
    const hasil = prepareMarkdownPreview('<a href="https://x.test"><img src="s.png" alt="S"></a>');
    expect(hasil).toContain("![S](s.png)");
  });

  test("p align center dibuang dan teks dipertahankan", () => {
    const hasil = prepareMarkdownPreview('<p align="center">Halo <b>dunia</b></p>');
    expect(hasil).toContain("Halo **dunia**");
    expect(hasil).not.toContain("<p");
    expect(hasil).not.toContain("align");
  });

  test("br menjadi baris baru", () => {
    expect(prepareMarkdownPreview("satu<br>dua")).toBe("satu\ndua");
    expect(prepareMarkdownPreview("satu<br/>dua")).toBe("satu\ndua");
  });

  test("heading html, b, i, code", () => {
    expect(prepareMarkdownPreview("<h2>Judul</h2>")).toContain("## Judul");
    expect(prepareMarkdownPreview("<b>x</b> <i>y</i> <code>z</code>")).toBe("**x** *y* `z`");
  });

  test("komentar html dihapus", () => {
    expect(prepareMarkdownPreview("a<!-- rahasia -->b")).toBe("ab");
  });

  test("isi pagar kode tidak tersentuh", () => {
    const sumber = '```html\n<p align="center"><img src="a.png" alt="A"></p>\n```';
    expect(prepareMarkdownPreview(sumber)).toBe(sumber);
  });

  test("autolink dan perbandingan dibiarkan utuh", () => {
    expect(prepareMarkdownPreview("<https://x.test>")).toBe("<https://x.test>");
    expect(prepareMarkdownPreview("a < b")).toBe("a < b");
  });

  test("teks kosong dan baris kosong beruntun", () => {
    expect(prepareMarkdownPreview("")).toBe("");
    expect(prepareMarkdownPreview("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  test("input 200 KB selesai < 1 detik", () => {
    const sumber = '<p align="center"><a href="https://x.test"><img src="a.png" alt="A"></a></p>\n'.repeat(2500);
    expect(sumber.length).toBeGreaterThan(150_000);
    const mulai = performance.now();
    const hasil = prepareMarkdownPreview(sumber);
    expect(performance.now() - mulai).toBeLessThan(1000);
    expect(hasil.length).toBeGreaterThan(0);
  });
});
