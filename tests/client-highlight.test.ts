import { describe, expect, test } from "bun:test";
import {
  highlight,
  languageForPath,
  MAX_HIGHLIGHT_LINES,
  type LangId,
  type Token,
} from "../src/client/lib/highlight";

function lineText(tokens: readonly Token[] | undefined): string {
  return (tokens ?? []).map((token) => token.text).join("");
}

function kinds(tokens: readonly Token[] | undefined): string[] {
  return (tokens ?? []).map((token) => token.kind);
}

function assertLossless(content: string, lang: LangId): void {
  const lines = highlight(content, lang);
  const expected = content === "" ? [] : content.replace(/\r\n/g, "\n").split("\n");
  if (expected.length > 0 && expected[expected.length - 1] === "") expected.pop();
  expect(lines).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(lineText(lines[index])).toBe(expected[index] ?? "");
  }
}

describe("languageForPath", () => {
  test("memetakan ekstensi umum", () => {
    expect(languageForPath("a.ts")).toBe("ts");
    expect(languageForPath("a.tsx")).toBe("ts");
    expect(languageForPath("a.mjs")).toBe("js");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("a.scss")).toBe("css");
    expect(languageForPath("index.html")).toBe("html");
    expect(languageForPath("a.svg")).toBe("html");
    expect(languageForPath("run.sh")).toBe("sh");
    expect(languageForPath("a.py")).toBe("py");
    expect(languageForPath("a.php")).toBe("php");
    expect(languageForPath("a.yml")).toBe("yaml");
    expect(languageForPath("README.md")).toBe("md");
    expect(languageForPath("a.go")).toBe("go");
    expect(languageForPath("a.rs")).toBe("rust");
    expect(languageForPath("a.kt")).toBe("java");
    expect(languageForPath("a.sql")).toBe("sql");
    expect(languageForPath("a.toml")).toBe("toml");
    expect(languageForPath("a.patch")).toBe("diff");
  });

  test("nama berkas khusus dan tanpa ekstensi", () => {
    expect(languageForPath(".zshrc")).toBe("sh");
    expect(languageForPath("Dockerfile")).toBe("sh");
    expect(languageForPath("Makefile")).toBe("plain");
    expect(languageForPath("src/a.TS")).toBe("ts");
  });
});

describe("invarian lossless", () => {
  const samples: Array<[LangId, string]> = [
    ["ts", "const a = 1;\n// komentar\n/* blok\nbaris */\nconst s = `x\n${a}\ny`;\n"],
    ["js", "function f(x) { return x + 1; }\n"],
    ["json", '{\n  "a": 1,\n  "b": [true, null]\n}\n'],
    ["css", "/* c */\n.a { color: #fff; margin: 1px; }\n@media (max-width: 1px) {}\n"],
    ["html", "<!-- c -->\n<div class=\"x\">teks</div>\n<!doctype html>\n"],
    ["sh", "#!/bin/bash\n# komentar\necho \"$HOME\" -n\nif [ -f x ]; then exit 0; fi\n"],
    ["py", 'def f():\n    """doc\n    multi"""\n    return 1\n'],
    ["php", "<?php\n// c\nfunction f($x) { return $x; }\n?>\n"],
    ["yaml", "# c\nkunci: nilai\nangka: 12\nflag: true\n- item\n"],
    ["md", "# Judul\n\n```\nkode\n```\n- daftar **tebal** [a](b)\n"],
    ["go", "package main\nfunc main() { return }\n"],
    ["rust", "fn main() { let x = 1; }\n"],
    ["java", "public class A { void f() {} }\n"],
    ["sql", "SELECT * FROM t WHERE a = 'x';\n-- c\n"],
    ["toml", "[tabel]\nkunci = \"nilai\"\nflag = true\n"],
    ["diff", "diff --git a b\n@@ -1 +1 @@\n+baru\n-lama\n"],
  ];

  for (const [lang, content] of samples) {
    test(`${lang} mempertahankan teks tiap baris`, () => {
      assertLossless(content, lang);
    });
  }

  test("CRLF dinormalkan", () => {
    assertLossless("const a = 1;\r\nconst b = 2;\r\n", "ts");
  });

  test("string tak tertutup tidak melempar", () => {
    expect(() => highlight('const a = "belum tertutup', "ts")).not.toThrow();
    expect(() => highlight("/* belum tertutup", "ts")).not.toThrow();
    expect(() => highlight("'''belum", "py")).not.toThrow();
  });

  test("konten kosong menjadi daftar kosong", () => {
    expect(highlight("", "ts")).toEqual([]);
  });

  test("baris kosong menjadi array kosong", () => {
    const lines = highlight("a\n\nb", "ts");
    expect(lines[1]).toEqual([]);
  });
});

describe("kind token", () => {
  test("ts: keyword, control, string, comment, function", () => {
    const lines = highlight("const x = 1; // x\nreturn foo(1);", "ts");
    expect(lines[0]?.find((t) => t.text === "const")?.kind).toBe("keyword");
    expect(lines[0]?.find((t) => t.text === "// x")?.kind).toBe("comment");
    expect(lines[0]?.find((t) => t.text === "1")?.kind).toBe("number");
    expect(lines[1]?.find((t) => t.text === "return")?.kind).toBe("control");
    expect(lines[1]?.find((t) => t.text === "foo")?.kind).toBe("function");
  });

  test("ts: string dan property", () => {
    const lines = highlight('const s = "abc"; obj.prop;', "ts");
    expect(lines[0]?.find((t) => t.text === '"abc"')?.kind).toBe("string");
    expect(lines[0]?.find((t) => t.text === "prop")?.kind).toBe("property");
  });

  test("json: kunci property, nilai string, boolean keyword", () => {
    const lines = highlight('{"a": "b", "c": true}', "json");
    expect(lines[0]?.find((t) => t.text === '"a"')?.kind).toBe("property");
    expect(lines[0]?.find((t) => t.text === '"b"')?.kind).toBe("string");
    expect(lines[0]?.find((t) => t.text === "true")?.kind).toBe("keyword");
  });

  test("diff: baris tambah dan hapus", () => {
    const lines = highlight("+baru\n-lama\n@@ -1 +1 @@", "diff");
    expect(kinds(lines[0])).toEqual(["inserted"]);
    expect(kinds(lines[1])).toEqual(["deleted"]);
    expect(kinds(lines[2])).toEqual(["keyword"]);
  });

  test("md: judul heading", () => {
    const lines = highlight("# Judul", "md");
    expect(kinds(lines[0])).toEqual(["heading"]);
  });

  test("css: properti dan selektor", () => {
    const lines = highlight(".a { color: red; }", "css");
    expect(lines[0]?.find((t) => t.text === ".a")?.kind).toBe("type");
    expect(lines[0]?.find((t) => t.text === "color")?.kind).toBe("property");
  });

  test("html: tag dan atribut", () => {
    const lines = highlight('<div class="x">', "html");
    expect(lines[0]?.find((t) => t.text === "<div")?.kind).toBe("tag");
    expect(lines[0]?.find((t) => t.text === "class")?.kind).toBe("attr");
    expect(lines[0]?.find((t) => t.text === '"x"')?.kind).toBe("string");
  });
});

describe("batas dan fallback", () => {
  test("lang plain menjadi semua plain", () => {
    const lines = highlight("const a = 1;", "plain");
    expect(kinds(lines[0])).toEqual(["plain"]);
  });

  test("lebih dari MAX_HIGHLIGHT_LINES menjadi semua plain", () => {
    const content = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "const a = 1;").join("\n");
    const lines = highlight(content, "ts");
    expect(lines).toHaveLength(MAX_HIGHLIGHT_LINES + 1);
    expect(kinds(lines[0])).toEqual(["plain"]);
  });

  test("input besar satu baris selesai cepat", () => {
    const content = `const a = "${"x".repeat(200_000)}";`;
    const started = performance.now();
    const lines = highlight(content, "ts");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(lineText(lines[0])).toBe(content);
  });
});
