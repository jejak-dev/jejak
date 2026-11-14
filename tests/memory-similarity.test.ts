import { describe, expect, test } from "bun:test";
import {
  MEMORY_SIMILARITY_MIN,
  keywords,
  memorySimilarity,
  similarity,
  wordSet,
} from "../src/server/memory/memory-similarity";

describe("similarity", () => {
  test("teks identik bernilai satu", () => {
    expect(similarity("bun test setiap commit", "bun test setiap commit")).toBe(1);
  });

  test("teks berbeda jauh di bawah ambang", () => {
    const nilai = similarity("bun test setiap commit", "kucing duduk di atas tikar");
    expect(nilai).toBeLessThan(MEMORY_SIMILARITY_MIN);
    expect(nilai).toBeGreaterThanOrEqual(0);
  });

  test("kata pendek diabaikan dan tidak menambah irisan", () => {
    expect(wordSet("a bun 12 cd")).toEqual(new Set(["bun"]));
    expect(similarity("bun", "bun")).toBe(1);
    expect(similarity("a b c", "d e f")).toBe(0);
  });

  test("teks kosong bernilai nol, bukan tak hingga", () => {
    expect(similarity("", "")).toBe(0);
    expect(similarity("", "bun test")).toBe(0);
    expect(similarity("!!! ???", "bun test")).toBe(0);
  });

  test("huruf besar, tanda baca, dan duplikasi diabaikan", () => {
    expect(similarity("Bun, Test!", "bun test bun")).toBe(1);
  });

  test("irisan dan gabungan dipakai, bukan hanya jumlah kata sama", () => {
    // Tiga kata sama dari enam kata berbeda: irisan 3, gabungan 6.
    expect(similarity("bun test commit", "bun test commit dan lain lagi")).toBeCloseTo(0.5, 5);
  });
});

describe("memorySimilarity", () => {
  test("judul dan isi digabung", () => {
    const kiri = { title: "Perintah commit", body: "Jalankan bun test" };
    expect(memorySimilarity(kiri, { ...kiri })).toBe(1);
    expect(
      memorySimilarity(kiri, { title: "Sama sekali", body: "Berbeda total dari yang lain" }),
    ).toBe(0);
  });
});

describe("keywords", () => {
  test("hanya huruf dan angka dengan panjang minimal tiga, tanpa duplikat", () => {
    expect(keywords("Bun test, bun! 12 ab")).toEqual(["bun", "test"]);
    expect(keywords("a b c")).toEqual([]);
  });
});
