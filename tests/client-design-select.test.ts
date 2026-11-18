import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameBounds, FrameStyle } from "../src/client/lib/design-protocol";
import {
  chipText,
  elementContext,
  overlayBorder,
  overlayRect,
  pageFile,
  styleRows,
  type Selection,
} from "../src/client/lib/design-select";

const BOUNDS: FrameBounds = { x: 10, y: 20, width: 100, height: 40 };

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    slug: "beranda",
    title: "Beranda",
    selector: "#tombol",
    tag: "button",
    text: "Kirim",
    html: "<button id=\"tombol\">Kirim</button>",
    bounds: BOUNDS,
    style: { color: "rgb(0, 0, 0)", fontSize: "14px" },
    ...overrides,
  };
}

describe("overlayRect", () => {
  test("menambah posisi frame ke kotak elemen", () => {
    expect(overlayRect({ x: 100, y: 200, width: 300, height: 400 }, BOUNDS)).toEqual({
      x: 110,
      y: 220,
      width: 100,
      height: 40,
    });
  });
});

describe("overlayBorder", () => {
  test("tampak 2 px di layar pada zoom berapa pun", () => {
    expect(overlayBorder(1)).toBe(2);
    expect(overlayBorder(0.1)).toBe(20);
    expect(overlayBorder(4)).toBe(0.5);
  });

  test("zoom tak hingga jatuh ke 1", () => {
    expect(overlayBorder(Number.NaN)).toBe(2);
  });
});

describe("styleRows", () => {
  test("urutan tetap dan label Bahasa Indonesia", () => {
    const style: FrameStyle = {
      display: "flex",
      color: "red",
      borderRadius: "4px",
      backgroundColor: "white",
    };
    expect(styleRows(style)).toEqual([
      { label: "Warna", value: "red" },
      { label: "Latar", value: "white" },
      { label: "Radius", value: "4px" },
      { label: "Tampilan", value: "flex" },
    ]);
  });

  test("nilai kosong dan undefined dilewati", () => {
    expect(styleRows({ color: "  ", fontSize: "" })).toEqual([]);
    expect(styleRows({})).toEqual([]);
  });
});

describe("chipText", () => {
  test("menggabungkan label dan tag", () => {
    expect(chipText("button", "Tombol")).toBe("Tombol · button");
  });
});

describe("pageFile", () => {
  test("berkas halaman dari slug", () => {
    expect(pageFile("beranda")).toBe("design/pages/beranda.html");
  });
});

describe("elementContext", () => {
  test("memuat judul, selector, tag, teks, ukuran, gaya, dan HTML", () => {
    const teks = elementContext(selection(), pageFile("beranda"));
    expect(teks).toContain('Elemen terpilih di halaman "Beranda" (design/pages/beranda.html)');
    expect(teks).toContain("- Selector: `#tombol`");
    expect(teks).toContain("- Tag: button");
    expect(teks).toContain("- Teks: Kirim");
    expect(teks).toContain("- Ukuran: 100 x 40");
    expect(teks).toContain("- Warna: rgb(0, 0, 0)");
    expect(teks).toContain("- Ukuran font: 14px");
    expect(teks).toContain("```html");
    expect(teks).toContain('<button id="tombol">Kirim</button>');
    expect(teks.trimEnd().endsWith("Ubah elemen ini:")).toBe(true);
  });

  test("pagar kode lebih panjang saat HTML memuat tiga backtick", () => {
    const teks = elementContext(selection({ html: "<pre>```x```</pre>" }), "f.html");
    expect(teks).toContain("````html");
    expect(teks).toContain("````");
  });

  test("selector berbacktick memakai pagar lebih panjang", () => {
    const teks = elementContext(selection({ selector: "a[data-x=\"`\"]" }), "f.html");
    expect(teks).toContain('- Selector: ``a[data-x="`"]``');
  });

  test("teks kosong dilewati", () => {
    const teks = elementContext(selection({ text: "   " }), "f.html");
    expect(teks).not.toContain("- Teks:");
  });

  test("HTML dipotong 2048 dan teks dipotong 200", () => {
    const teks = elementContext(
      selection({ html: "a".repeat(3000), text: "b".repeat(300) }),
      "f.html",
    );
    expect(teks).toContain("a".repeat(2048));
    expect(teks).not.toContain("a".repeat(2049));
    expect(teks).toContain("b".repeat(200));
    expect(teks).not.toContain("b".repeat(201));
  });
});

describe("sumber DesignCanvas", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "client", "components", "DesignCanvas.tsx"),
    "utf8",
  );

  test("tidak menyisipkan HTML dari frame", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  test("memproses hover/select lewat parseFrameMessage dan isFromFrame", () => {
    expect(source).toContain("parseFrameMessage(event.data)");
    expect(source).toContain("isFromFrame(event, el.contentWindow)");
    expect(source).toContain('case "hover"');
    expect(source).toContain('case "select"');
  });
});
