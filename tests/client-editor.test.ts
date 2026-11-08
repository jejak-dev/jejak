import { describe, expect, test } from "bun:test";
import { ApiError, type FileContent } from "../src/client/lib/api";
import {
  describeSaveError,
  highlightMatch,
  isDirty,
  isEditable,
  lineStartOffset,
} from "../src/client/lib/editor";

function file(patch: Partial<FileContent>): FileContent {
  return { path: "a.txt", size: 3, binary: false, truncated: false, content: "abc", version: "v1", ...patch };
}

describe("isEditable", () => {
  test("berkas teks utuh dengan versi bisa disunting", () => {
    expect(isEditable(file({}))).toBe(true);
  });

  test("biner tidak bisa disunting", () => {
    expect(isEditable(file({ binary: true }))).toBe(false);
  });

  test("berkas terpotong tidak bisa disunting", () => {
    expect(isEditable(file({ truncated: true }))).toBe(false);
  });

  test("tanpa version tidak bisa disunting", () => {
    expect(isEditable(file({ version: undefined }))).toBe(false);
  });

  test("tanpa konten tidak bisa disunting", () => {
    expect(isEditable(file({ content: undefined }))).toBe(false);
  });
});

describe("isDirty", () => {
  test("teks sama tidak kotor, beda berarti kotor", () => {
    expect(isDirty("a", "a")).toBe(false);
    expect(isDirty("a", "b")).toBe(true);
    expect(isDirty("", " ")).toBe(true);
  });
});

describe("lineStartOffset", () => {
  test("baris 1 mulai dari offset 0", () => {
    expect(lineStartOffset("abc\ndef", 1)).toBe(0);
  });

  test("baris tengah menghitung newline sebelumnya", () => {
    expect(lineStartOffset("abc\ndef\nghi", 2)).toBe(4);
    expect(lineStartOffset("abc\ndef\nghi", 3)).toBe(8);
  });

  test("di luar rentang dijepit ke baris terakhir", () => {
    expect(lineStartOffset("abc\ndef", 99)).toBe(4);
  });

  test("baris di bawah 1 dijepit ke baris pertama", () => {
    expect(lineStartOffset("abc\ndef", 0)).toBe(0);
  });

  test("teks tanpa newline selalu 0", () => {
    expect(lineStartOffset("abc", 1)).toBe(0);
    expect(lineStartOffset("abc", 5)).toBe(0);
  });

  test("CRLF dihitung panjang barisnya termasuk CR", () => {
    expect(lineStartOffset("ab\r\ncd", 2)).toBe(4);
  });

  test("teks kosong menghasilkan 0", () => {
    expect(lineStartOffset("", 3)).toBe(0);
  });
});

describe("describeSaveError", () => {
  test("409 berubah di disk ditandai konflik", () => {
    const result = describeSaveError(
      new ApiError("Berkas berubah di disk. Muat ulang sebelum menyimpan.", 409),
    );
    expect(result.conflict).toBe(true);
    expect(result.message).toBe("Berkas berubah di disk. Muat ulang sebelum menyimpan.");
  });

  test("409 sesi berjalan bukan konflik", () => {
    const result = describeSaveError(new ApiError('Sesi "s1" sedang berjalan.', 409));
    expect(result.conflict).toBe(false);
    expect(result.message).toBe('Sesi "s1" sedang berjalan.');
  });

  test("403 memakai pesan server", () => {
    const result = describeSaveError(new ApiError("Penyuntingan berkas dimatikan.", 403));
    expect(result.conflict).toBe(false);
    expect(result.message).toBe("Penyuntingan berkas dimatikan.");
  });

  test("galat non-ApiError menjadi pesan umum", () => {
    const result = describeSaveError(new Error("boom"));
    expect(result.conflict).toBe(false);
    expect(result.message).toBe("Berkas tidak dapat disimpan.");
  });
});

describe("highlightMatch", () => {
  test("peka huruf membedakan besar-kecil", () => {
    expect(highlightMatch("Halo dunia", "Dunia", true)).toBeUndefined();
    expect(highlightMatch("Halo dunia", "dunia", true)).toEqual({
      before: "Halo ",
      hit: "dunia",
      after: "",
    });
  });

  test("tidak peka huruf menemukan kecocokan berbeda kapitalisasi", () => {
    expect(highlightMatch("Halo Dunia", "dunia", false)).toEqual({
      before: "Halo ",
      hit: "Dunia",
      after: "",
    });
  });

  test("tidak ketemu menjadi undefined", () => {
    expect(highlightMatch("abc", "z", false)).toBeUndefined();
    expect(highlightMatch("abc", "", false)).toBeUndefined();
  });

  test("kecocokan di awal dan akhir dipisah benar", () => {
    expect(highlightMatch("abc abc", "abc", false)).toEqual({
      before: "",
      hit: "abc",
      after: " abc",
    });
    expect(highlightMatch("xabc", "abc", false)).toEqual({ before: "x", hit: "abc", after: "" });
  });
});
