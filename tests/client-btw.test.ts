import { describe, expect, test } from "bun:test";
import { parseBtw } from "../src/client/lib/btw";

describe("parseBtw", () => {
  test("mengembalikan pertanyaan setelah /btw", () => {
    expect(parseBtw("/btw apa agenda sesi ini?")).toBe("apa agenda sesi ini?");
    expect(parseBtw("/btw  dua spasi")).toBe("dua spasi");
    expect(parseBtw("/btw\t dengan tab")).toBe("dengan tab");
  });

  test("huruf besar-kecil tak dibedakan", () => {
    expect(parseBtw("/BTW apa kabar?")).toBe("apa kabar?");
    expect(parseBtw("/BtW apa kabar?")).toBe("apa kabar?");
  });

  test("baris baru setelah /btw tetap pertanyaan", () => {
    expect(parseBtw("/btw\napa kabar?")).toBe("apa kabar?");
    expect(parseBtw("/btw\r\napa kabar?")).toBe("apa kabar?");
  });

  test("pertanyaan dikembalikan tanpa spasi tepi", () => {
    expect(parseBtw("/btw   apa kabar?   ")).toBe("apa kabar?");
  });

  test("/btw kosong dan /btwx bukan pertanyaan sampingan", () => {
    expect(parseBtw("/btw")).toBeUndefined();
    expect(parseBtw("/btw ")).toBeUndefined();
    expect(parseBtw("/btw\n   ")).toBeUndefined();
    expect(parseBtw("/btwx")).toBeUndefined();
    expect(parseBtw("/btwfoo")).toBeUndefined();
  });

  test("teks biasa bukan pertanyaan sampingan", () => {
    expect(parseBtw("halo")).toBeUndefined();
    expect(parseBtw("tolong /btw ini")).toBeUndefined();
    expect(parseBtw("")).toBeUndefined();
  });
});
