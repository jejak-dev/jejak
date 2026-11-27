import { describe, expect, test } from "bun:test";
import { fileMention, mergeMention } from "../src/client/lib/file-mention";

describe("fileMention", () => {
  test("jalur relatif jadi @jalur", () => {
    expect(fileMention("docs/a.md")).toBe("@docs/a.md");
  });
  test("garis miring depan dibuang", () => {
    expect(fileMention("/docs/a.md")).toBe("@docs/a.md");
  });
  test("repo non-utama jadi awalan", () => {
    expect(fileMention("src/a.ts", "api")).toBe("@api/src/a.ts");
  });
  test("spasi dikutip", () => {
    expect(fileMention("catatan saya.md")).toBe('@"catatan saya.md"');
  });
});

describe("mergeMention", () => {
  test("kolom kosong", () => {
    expect(mergeMention("", "@a.md")).toBe("@a.md ");
    expect(mergeMention("  \n", "@a.md")).toBe("@a.md ");
  });
  test("tidak menggandakan", () => {
    expect(mergeMention("lihat @a.md dulu", "@a.md")).toBe("lihat @a.md dulu");
    expect(mergeMention("@a.md ", "@a.md")).toBe("@a.md ");
    expect(mergeMention("@a.md\nlihat", "@a.md")).toBe("@a.md\nlihat");
  });
  test("awalan mirip bukan duplikat", () => {
    expect(mergeMention("@a.md.bak ", "@a.md")).toBe("@a.md.bak @a.md ");
  });
  test("mention beruntun dalam satu baris", () => {
    expect(mergeMention("@a.md ", "@b.md")).toBe("@a.md @b.md ");
  });
  test("teks biasa: mention di baris baru", () => {
    expect(mergeMention("ringkas ini", "@a.md")).toBe("ringkas ini\n@a.md ");
  });
});
