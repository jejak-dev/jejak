import { describe, expect, test } from "bun:test";
import type { DesignToken } from "../src/client/lib/api";
import {
  diffTokens,
  groupTokens,
  hexForColorInput,
  isValidTokenName,
  isValidTokenValue,
  tokenKind,
} from "../src/client/lib/design-tokens";

function token(name: string, value: string): DesignToken {
  return { name, value };
}

describe("tokenKind", () => {
  test("warna hex 3, 4, 6, dan 8 digit", () => {
    expect(tokenKind("#fff")).toBe("color");
    expect(tokenKind("#ffff")).toBe("color");
    expect(tokenKind("#2f6fed")).toBe("color");
    expect(tokenKind("#2f6fed80")).toBe("color");
    expect(tokenKind("#ABCDEF")).toBe("color");
  });

  test("fungsi rgb dan hsl termasuk warna", () => {
    expect(tokenKind("rgb(1, 2, 3)")).toBe("color");
    expect(tokenKind("rgba(1, 2, 3, 0.5)")).toBe("color");
    expect(tokenKind("hsl(210, 80%, 50%)")).toBe("color");
  });

  test("angka dengan satuan atau angka murni termasuk ukuran", () => {
    expect(tokenKind("16px")).toBe("length");
    expect(tokenKind("1.5rem")).toBe("length");
    expect(tokenKind("2em")).toBe("length");
    expect(tokenKind("50%")).toBe("length");
    expect(tokenKind("12")).toBe("length");
    expect(tokenKind("-4px")).toBe("length");
  });

  test("nilai lain termasuk teks", () => {
    expect(tokenKind("system-ui, sans-serif")).toBe("text");
    expect(tokenKind("1px solid red")).toBe("text");
    expect(tokenKind("#12345")).toBe("text");
    expect(tokenKind("")).toBe("text");
  });
});

describe("groupTokens", () => {
  test("mengelompokkan berurutan dan membuang kelompok kosong", () => {
    const hasil = groupTokens([
      token("--warna-aksen", "#2f6fed"),
      token("--jarak", "16px"),
      token("--font-sans", "system-ui"),
      token("--lainnya", "teks"),
    ]);

    expect(hasil.map((group) => group.title)).toEqual([
      "Warna",
      "Ukuran",
      "Font",
      "Lainnya",
    ]);
    expect(hasil[0]?.tokens.map((item) => item.name)).toEqual(["--warna-aksen"]);
    expect(hasil[1]?.tokens.map((item) => item.name)).toEqual(["--jarak"]);
    expect(hasil[2]?.tokens.map((item) => item.name)).toEqual(["--font-sans"]);
    expect(hasil[3]?.tokens.map((item) => item.name)).toEqual(["--lainnya"]);
  });

  test("nilai warna masuk kelompok Warna walau namanya lain", () => {
    const hasil = groupTokens([token("--latar", "#ffffff")]);
    expect(hasil).toHaveLength(1);
    expect(hasil[0]?.title).toBe("Warna");
  });

  test("nama berawalan --color masuk kelompok Warna", () => {
    const hasil = groupTokens([token("--color-brand", "biru")]);
    expect(hasil[0]?.title).toBe("Warna");
  });

  test("kelompok kosong dibuang", () => {
    const hasil = groupTokens([token("--warna-aksen", "#2f6fed")]);
    expect(hasil.map((group) => group.title)).toEqual(["Warna"]);
  });

  test("urutan asli di dalam kelompok dipertahankan", () => {
    const hasil = groupTokens([
      token("--warna-b", "#111111"),
      token("--warna-a", "#222222"),
    ]);
    expect(hasil[0]?.tokens.map((item) => item.name)).toEqual(["--warna-b", "--warna-a"]);
  });
});

describe("diffTokens", () => {
  test("menghitung nilai yang berubah, token baru, dan token dihapus", () => {
    const saved = [token("--a", "1"), token("--b", "2"), token("--c", "3")];
    const draft = [token("--a", "9"), token("--b", "2"), token("--d", "4")];
    expect(diffTokens(saved, draft)).toBe(3);
  });

  test("nol bila draf sama", () => {
    const saved = [token("--a", "1")];
    expect(diffTokens(saved, [token("--a", "1")])).toBe(0);
  });

  test("token baru dihitung satu", () => {
    expect(diffTokens([], [token("--a", "1")])).toBe(1);
  });

  test("token dihapus dihitung satu", () => {
    expect(diffTokens([token("--a", "1")], [])).toBe(1);
  });
});

describe("isValidTokenName", () => {
  test("nama sah diterima", () => {
    expect(isValidTokenName("--warna-aksen")).toBe(true);
    expect(isValidTokenName("--a")).toBe(true);
    expect(isValidTokenName("--A_b-1")).toBe(true);
  });

  test("nama tak sah ditolak", () => {
    expect(isValidTokenName("warna-aksen")).toBe(false);
    expect(isValidTokenName("-warna")).toBe(false);
    expect(isValidTokenName("--")).toBe(false);
    expect(isValidTokenName("--warna aksen")).toBe(false);
    expect(isValidTokenName("--warna.aksen")).toBe(false);
    expect(isValidTokenName(`--${"a".repeat(65)}`)).toBe(false);
  });
});

describe("isValidTokenValue", () => {
  test("nilai sah diterima", () => {
    expect(isValidTokenValue("#2f6fed")).toBe(true);
    expect(isValidTokenValue("16px")).toBe(true);
    expect(isValidTokenValue("system-ui, sans-serif")).toBe(true);
  });

  test("nilai kosong dan kepanjangan ditolak", () => {
    expect(isValidTokenValue("")).toBe(false);
    expect(isValidTokenValue("a".repeat(201))).toBe(false);
    expect(isValidTokenValue("a".repeat(200))).toBe(true);
  });

  test("tanda struktural CSS ditolak", () => {
    expect(isValidTokenValue("red; background: blue")).toBe(false);
    expect(isValidTokenValue("red}")).toBe(false);
    expect(isValidTokenValue("{red")).toBe(false);
    expect(isValidTokenValue("</style>")).toBe(false);
  });

  test("baris baru ditolak", () => {
    expect(isValidTokenValue("red\nblue")).toBe(false);
    expect(isValidTokenValue("red\rblue")).toBe(false);
  });
});

describe("hexForColorInput", () => {
  test("hex 6 digit menjadi huruf kecil", () => {
    expect(hexForColorInput("#2F6FED")).toBe("#2f6fed");
  });

  test("hex 3 digit dikembangkan", () => {
    expect(hexForColorInput("#ABC")).toBe("#aabbcc");
  });

  test("nilai lain tak punya padanan hex", () => {
    expect(hexForColorInput("rgb(1, 2, 3)")).toBeUndefined();
    expect(hexForColorInput("#12345")).toBeUndefined();
    expect(hexForColorInput("#2f6fed80")).toBeUndefined();
    expect(hexForColorInput("biru")).toBeUndefined();
  });
});
