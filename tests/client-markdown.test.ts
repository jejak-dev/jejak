import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { parseMarkdown, safeHref, type MdBlock, type MdInline } from "../src/client/lib/markdown";
import { Markdown } from "../src/client/components/Markdown";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function byTag(node: ComponentChild, tag: string): VNode[] {
  return findNodes(node, (vnode) => vnode.type === tag);
}

function structure(blocks: readonly MdBlock[]): string[] {
  return blocks.map((block) => block.type);
}

function inlinesOf(block: MdBlock | undefined): MdInline[] {
  if (block === undefined) throw new Error("blok kosong");
  if (block.type !== "paragraph" && block.type !== "heading") {
    throw new Error(`blok ${block.type} tidak punya inline`);
  }
  return block.children;
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function maxListDepth(blocks: readonly MdBlock[]): number {
  let max = 0;
  for (const block of blocks) {
    if (block.type === "list") {
      const inner = block.items.reduce((best, item) => Math.max(best, maxListDepth(item)), 0);
      max = Math.max(max, inner + 1);
    }
    if (block.type === "quote") max = Math.max(max, maxListDepth(block.children));
  }
  return max;
}

function maxQuoteDepth(blocks: readonly MdBlock[]): number {
  let max = 0;
  for (const block of blocks) {
    if (block.type === "quote") {
      const inner = maxQuoteDepth(block.children);
      max = Math.max(max, inner + 1);
    }
    if (block.type === "list") {
      for (const item of block.items) max = Math.max(max, maxQuoteDepth(item));
    }
  }
  return max;
}

/* ---------- safeHref ---------- */

describe("safeHref", () => {
  test("menolak javascript: dan variasinya", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeUndefined();
    expect(safeHref(" javascript:alert(1)")).toBeUndefined();
    expect(safeHref("java\nscript:alert(1)")).toBeUndefined();
  });

  test("menolak data:, vbscript:, relatif, dan protokol-relatif", () => {
    expect(safeHref("data:text/html,x")).toBeUndefined();
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeHref("//evil.com/x")).toBeUndefined();
    expect(safeHref("/relatif")).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
  });

  test("menerima http, https, mailto", () => {
    expect(safeHref("https://ok")).toBe("https://ok");
    expect(safeHref("http://ok.test/a?b=1")).toBe("http://ok.test/a?b=1");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("  https://ok  ")).toBe("https://ok");
  });
});

/* ---------- parseMarkdown ---------- */

describe("parseMarkdown: paragraf dan break", () => {
  test("baris berurutan digabung spasi", () => {
    const blocks = parseMarkdown("baris satu\nbaris dua");
    expect(inlinesOf(blocks[0])).toEqual([{ type: "text", text: "baris satu baris dua" }]);
  });

  test("dua spasi di akhir menghasilkan break", () => {
    const blocks = parseMarkdown("satu  \ndua");
    expect(inlinesOf(blocks[0])).toEqual([
      { type: "text", text: "satu" },
      { type: "break" },
      { type: "text", text: "dua" },
    ]);
  });

  test("backslash di akhir menghasilkan break", () => {
    const blocks = parseMarkdown("satu\\\ndua");
    expect(inlinesOf(blocks[0])).toEqual([
      { type: "text", text: "satu" },
      { type: "break" },
      { type: "text", text: "dua" },
    ]);
  });
});

describe("parseMarkdown: heading", () => {
  test("level 1-6", () => {
    const blocks = parseMarkdown("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f");
    expect(blocks.map((block) => (block.type === "heading" ? block.level : 0))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  test("isi heading diparse inline", () => {
    const blocks = parseMarkdown("## **tebal**");
    const heading = blocks[0];
    expect(heading).toMatchObject({ type: "heading", level: 2 });
    expect(inlinesOf(heading)[0]).toMatchObject({ type: "strong" });
  });
});

describe("parseMarkdown: tebal, miring, kode inline", () => {
  test("**tebal** dan __tebal__", () => {
    expect(inlinesOf(parseMarkdown("**tebal**")[0])[0]).toMatchObject({ type: "strong" });
    expect(inlinesOf(parseMarkdown("__tebal__")[0])[0]).toMatchObject({ type: "strong" });
  });

  test("*miring* dan _miring_", () => {
    expect(inlinesOf(parseMarkdown("*miring*")[0])[0]).toMatchObject({ type: "em" });
    expect(inlinesOf(parseMarkdown("_miring_")[0])[0]).toMatchObject({ type: "em" });
  });

  test("garis bawah di dalam kata bukan miring", () => {
    expect(inlinesOf(parseMarkdown("snake_case_nama")[0])).toEqual([
      { type: "text", text: "snake_case_nama" },
    ]);
  });

  test("`kode` inline dan tebal di dalamnya tidak diparse", () => {
    expect(inlinesOf(parseMarkdown("`a **b**`")[0])).toEqual([{ type: "code", text: "a **b**" }]);
  });

  test("penanda belum ditutup tetap teks", () => {
    expect(inlinesOf(parseMarkdown("**tebal tanpa penutup")[0])).toEqual([
      { type: "text", text: "**tebal tanpa penutup" },
    ]);
  });

  test("backslash-escape karakter markdown", () => {
    expect(inlinesOf(parseMarkdown("\\*bukan miring\\*")[0])).toEqual([
      { type: "text", text: "*bukan miring*" },
    ]);
  });
});

describe("parseMarkdown: blok kode berpagar", () => {
  test("``` dengan bahasa dan isi markdown tidak diparse", () => {
    const blocks = parseMarkdown("```ts\nconst a = **x**; [l](https://x)\n```");
    expect(blocks).toEqual([
      { type: "code", lang: "ts", text: "const a = **x**; [l](https://x)" },
    ]);
  });

  test("~~~ juga pagar", () => {
    expect(parseMarkdown("~~~\nkode\n~~~")).toEqual([{ type: "code", text: "kode" }]);
  });

  test("pagar belum ditutup berlaku sampai akhir teks", () => {
    const blocks = parseMarkdown("```js\nsedang stream\n# bukan heading");
    expect(blocks).toEqual([{ type: "code", lang: "js", text: "sedang stream\n# bukan heading" }]);
  });
});

describe("parseMarkdown: daftar", () => {
  test("daftar tak berurut dan bersarang", () => {
    const blocks = parseMarkdown("- a\n  - b\n- c");
    const list = blocks[0];
    expect(list).toMatchObject({ type: "list", ordered: false });
    if (list?.type !== "list") throw new Error("bukan list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.map((item) => item.type)).toEqual(["paragraph", "list"]);
  });

  test("daftar bernomor membawa start", () => {
    const blocks = parseMarkdown("3. tiga\n4. empat");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  test("penanda * dan +", () => {
    const blocks = parseMarkdown("* a\n\n+ b");
    expect(structure(blocks)).toEqual(["list"]);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
  });
});

describe("parseMarkdown: kutipan", () => {
  test("> baris berurutan menjadi satu quote dengan paragraf", () => {
    const blocks = parseMarkdown("> satu\n> dua");
    expect(structure(blocks)).toEqual(["quote"]);
    expect(blocks[0]).toEqual({
      type: "quote",
      children: [{ type: "paragraph", children: [{ type: "text", text: "satu dua" }] }],
    });
  });
});

describe("parseMarkdown: garis", () => {
  test("---, ***, ___", () => {
    expect(structure(parseMarkdown("---\n\n***\n\n___"))).toEqual(["rule", "rule", "rule"]);
  });
});

describe("parseMarkdown: tabel GFM", () => {
  test("header, alignment, dan baris", () => {
    const blocks = parseMarkdown("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
    const table = blocks[0];
    expect(table).toMatchObject({ type: "table", aligns: ["left", "center", "right"] });
    if (table?.type !== "table") throw new Error("bukan tabel");
    expect(table.header).toHaveLength(3);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[0]).toEqual([{ type: "text", text: "1" }]);
  });

  test("tabel tanpa baris data tetap valid", () => {
    expect(structure(parseMarkdown("| A |\n| --- |"))).toEqual(["table"]);
  });
});

describe("parseMarkdown: tautan", () => {
  test("[teks](url) aman menjadi node link", () => {
    expect(inlinesOf(parseMarkdown("[teks](https://ok.test)")[0])).toEqual([
      { type: "link", href: "https://ok.test", children: [{ type: "text", text: "teks" }] },
    ]);
  });

  test("autolink <https://...>", () => {
    expect(inlinesOf(parseMarkdown("<https://ok.test>")[0])).toEqual([
      { type: "link", href: "https://ok.test", children: [{ type: "text", text: "https://ok.test" }] },
    ]);
  });

  test("URL telanjang http(s) menjadi link", () => {
    expect(inlinesOf(parseMarkdown("lihat https://ok.test/a.")[0])).toEqual([
      { type: "text", text: "lihat " },
      { type: "link", href: "https://ok.test/a", children: [{ type: "text", text: "https://ok.test/a" }] },
      { type: "text", text: "." },
    ]);
  });

  test("tautan tidak aman tetap teks tanpa node link", () => {
    const nodes = inlinesOf(parseMarkdown("[x](javascript:alert(1))")[0]);
    expect(nodes.every((node) => node.type !== "link")).toBe(true);
    expect(nodes.map((node) => (node.type === "text" ? node.text : "")).join("")).toContain(
      "javascript:alert(1)",
    );
  });
});

describe("parseMarkdown: HTML mentah tetap teks", () => {
  test("<script> dan <img onerror>", () => {
    expect(inlinesOf(parseMarkdown("<script>alert(1)</script>")[0])).toEqual([
      { type: "text", text: "<script>alert(1)</script>" },
    ]);
    expect(inlinesOf(parseMarkdown('<img src=x onerror="alert(1)">')[0])).toEqual([
      { type: "text", text: '<img src=x onerror="alert(1)">' },
    ]);
  });
});

describe("parseMarkdown: gambar tidak menghasilkan node gambar", () => {
  test("![alt](url) menjadi teks alt", () => {
    const nodes = inlinesOf(parseMarkdown("![gambar](https://img.test/a.png)")[0]);
    expect(nodes).toEqual([{ type: "text", text: "gambar" }]);
    expect(nodes.every((node) => (node as { type: string }).type !== "image")).toBe(true);
  });
});

describe("parseMarkdown: opsi images", () => {
  test("images:true menghasilkan simpul image tanpa src", () => {
    expect(inlinesOf(parseMarkdown("![gambar](https://img.test/a.png)", { images: true })[0])).toEqual([
      { type: "image", alt: "gambar" },
    ]);
  });

  test("images:true juga berlaku untuk alt kosong", () => {
    expect(inlinesOf(parseMarkdown("![](x.png)", { images: true })[0])).toEqual([
      { type: "image", alt: "" },
    ]);
  });
});

describe("parseMarkdown: batas dan ketahanan", () => {
  const hostile = [
    ["*", 100_000],
    ["[", 100_000],
    ["_", 100_000],
    ["`", 100_000],
    [">", 100_000],
  ] as const;

  for (const [char, size] of hostile) {
    test(`100k "${char}" selesai < 500 ms`, () => {
      const started = performance.now();
      const blocks = parseMarkdown(char.repeat(size));
      const elapsed = performance.now() - started;
      expect(Array.isArray(blocks)).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });
  }

  test("lebih dari 200k karakter menjadi teks polos tanpa parsing", () => {
    const source = `# judul\n${"x".repeat(200_001)}`;
    const blocks = parseMarkdown(source);
    expect(blocks).toEqual([{ type: "code", text: source }]);
  });

  test("daftar bersarang > 6 tingkat menjadi teks", () => {
    const lines: string[] = [];
    for (let level = 0; level < 8; level += 1) {
      lines.push(`${"  ".repeat(level)}- level ${level}`);
    }
    const blocks = parseMarkdown(lines.join("\n"));
    expect(maxListDepth(blocks)).toBeLessThanOrEqual(6);
    expect(JSON.stringify(blocks)).toContain("level 7");
  });

  test("kutipan bersarang > 6 tingkat menjadi teks", () => {
    const source = `${"> ".repeat(8)}dalam`;
    const blocks = parseMarkdown(source);
    expect(maxQuoteDepth(blocks)).toBeLessThanOrEqual(6);
    expect(JSON.stringify(blocks)).toContain("dalam");
  });
});

/* ---------- Komponen Markdown ---------- */

function render(text: string): VNode {
  return Markdown({ text }) as VNode;
}

describe("Markdown: render Preact", () => {
  test("akar .jk-md dan paragraf", () => {
    const vnode = render("halo");
    expect(vnode.type).toBe("div");
    expect(propsOf(vnode).class).toBe("jk-md");
    expect(byTag(vnode, "p")).toHaveLength(1);
    expect(textOf(vnode)).toBe("halo");
  });

  test("break menjadi <br>", () => {
    expect(byTag(render("a  \nb"), "br")).toHaveLength(1);
  });

  test("heading memakai elemen h1-h6 tanpa serif", () => {
    expect(byTag(render("# Judul"), "h1")).toHaveLength(1);
    expect(byTag(render("###### Enam"), "h6")).toHaveLength(1);
  });

  test("tebal, miring, kode inline", () => {
    const vnode = render("**b** *i* `c`");
    expect(byTag(vnode, "strong")).toHaveLength(1);
    expect(byTag(vnode, "em")).toHaveLength(1);
    expect(propsOf(byTag(vnode, "code")[0]).class).toBe("jk-md-code");
  });

  test("blok kode: pre.jk-md-pre dengan tabindex dan label bahasa", () => {
    const vnode = render("```ts\nx\n```");
    const pre = byTag(vnode, "pre")[0];
    expect(propsOf(pre).class).toBe("jk-md-pre");
    expect(propsOf(pre).tabIndex).toBe(0);
    expect(textOf(pre as VNode)).toContain("ts");
    expect(textOf(pre as VNode)).toContain("x");
  });

  test("blok mermaid aman ditelusuri tanpa DOM dan menampilkan sumber", () => {
    const vnode = render("```mermaid\nflowchart TD\nA-->B\n```");
    const pre = byTag(vnode, "pre")[0];
    expect(propsOf(pre).class).toBe("jk-md-pre");
    expect(textOf(pre as VNode)).toContain("flowchart TD");
  });

  test("daftar dan tabel", () => {
    const list = render("- a\n- b");
    expect(byTag(list, "ul")).toHaveLength(1);
    expect(byTag(list, "li")).toHaveLength(2);
    expect(byTag(render("1. a"), "ol")).toHaveLength(1);

    const table = render("| A |\n| --- |\n| 1 |");
    expect(byTag(table, "table")).toHaveLength(1);
    expect(byTag(table, "th")).toHaveLength(1);
    expect(byTag(table, "td")).toHaveLength(1);
    expect(byTag(table, "div").some((div) => propsOf(div).class === "jk-md-table-wrap")).toBe(true);
  });

  test("kutipan dan garis", () => {
    expect(propsOf(byTag(render("> q"), "blockquote")[0]).class).toBe("jk-md-quote");
    expect(byTag(render("---"), "hr")).toHaveLength(1);
  });

  test("tautan aman memakai target dan rel", () => {
    const links = byTag(render("[klik](https://ok.test)"), "a");
    expect(links).toHaveLength(1);
    expect(propsOf(links[0]).href).toBe("https://ok.test");
    expect(propsOf(links[0]).target).toBe("_blank");
    expect(propsOf(links[0]).rel).toBe("noopener noreferrer");
  });

  test("tautan tidak aman dirender sebagai teks tanpa <a>", () => {
    const vnode = render("[x](javascript:alert(1)) [y](//evil.test) [z](/rel)");
    expect(byTag(vnode, "a")).toHaveLength(0);
    expect(textOf(vnode)).toContain("javascript:alert(1)");
  });

  test("HTML mentah menjadi teks, bukan elemen", () => {
    const vnode = render("<script>alert(1)</script>");
    expect(byTag(vnode, "script")).toHaveLength(0);
    expect(textOf(vnode)).toBe("<script>alert(1)</script>");
  });

  test("gambar tidak menghasilkan elemen img", () => {
    const vnode = render("![alt](https://img.test/a.png)");
    expect(byTag(vnode, "img")).toHaveLength(0);
    expect(textOf(vnode)).toBe("alt");
  });

  test("rich: gambar menjadi chip jk-md-img dengan teks alt", () => {
    const vnode = Markdown({ text: "![Logo](a.png)", rich: true }) as VNode;
    const chip = byTag(vnode, "span").filter((node) => propsOf(node).class === "jk-md-img");
    expect(chip).toHaveLength(1);
    expect(textOf(chip[0] as VNode)).toContain("Logo");
    expect(byTag(vnode, "img")).toHaveLength(0);
    expect(byTag(vnode, "svg").length).toBeGreaterThanOrEqual(1);
  });

  test("tanpa rich tidak ada chip gambar", () => {
    const vnode = render("![Logo](a.png)");
    const chip = byTag(vnode, "span").filter((node) => propsOf(node).class === "jk-md-img");
    expect(chip).toHaveLength(0);
    expect(textOf(vnode)).toContain("Logo");
  });

  test("teks > 200k dirender sebagai pre polos", () => {
    const text = "y".repeat(200_001);
    const vnode = render(text);
    expect(byTag(vnode, "pre")).toHaveLength(1);
    expect(textOf(vnode)).toBe(text);
  });
});
