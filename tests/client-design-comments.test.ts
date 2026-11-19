import { describe, expect, test } from "bun:test";
import type { DesignComment } from "../src/client/lib/api";
import {
  commentCountLabel,
  commentNumbers,
  commentsPrompt,
  isOrphan,
  openCount,
  pinsForSlug,
  sortComments,
} from "../src/client/lib/design-comments";

function komentar(
  id: string,
  status: "open" | "done",
  createdAt: number,
  text = "Perbesar judul",
  slug = "beranda",
): DesignComment {
  return { id, slug, selector: '[id="judul"]', text, status, createdAt };
}

describe("sortComments", () => {
  test("open dulu, lalu createdAt naik di dalam kelompok", () => {
    const hasil = sortComments([
      komentar("c_3", "done", 2),
      komentar("c_2", "open", 3),
      komentar("c_1", "open", 1),
      komentar("c_4", "done", 1),
    ]);
    expect(hasil.map((item) => item.id)).toEqual(["c_1", "c_2", "c_4", "c_3"]);
  });

  test("tidak mengubah larik asli", () => {
    const asli = [komentar("c_1", "done", 1), komentar("c_2", "open", 2)];
    sortComments(asli);
    expect(asli.map((item) => item.id)).toEqual(["c_1", "c_2"]);
  });
});

describe("openCount dan commentCountLabel", () => {
  test("menghitung hanya yang open", () => {
    expect(openCount([])).toBe(0);
    expect(openCount([komentar("c_1", "open", 1), komentar("c_2", "done", 2)])).toBe(1);
    expect(
      openCount([komentar("c_1", "open", 1), komentar("c_2", "open", 2)]),
    ).toBe(2);
  });

  test("label chip", () => {
    expect(commentCountLabel([])).toBe("Komentar");
    expect(commentCountLabel([komentar("c_1", "done", 1)])).toBe("Komentar");
    expect(commentCountLabel([komentar("c_1", "open", 1)])).toBe("Komentar (1)");
    expect(
      commentCountLabel([komentar("c_1", "open", 1), komentar("c_2", "open", 2)]),
    ).toBe("Komentar (2)");
  });
});

describe("commentsPrompt", () => {
  const KEPALA =
    "Kerjakan komentar desain berikut. Ubah halaman dengan design_patch (satu elemen per panggilan), periksa hasilnya dengan design_screenshot bila kanvas terbuka, lalu tandai tiap komentar selesai dengan design_comment_resolve.";

  test("undefined saat kosong atau semua selesai", () => {
    expect(commentsPrompt([])).toBeUndefined();
    expect(commentsPrompt([komentar("c_1", "done", 1)])).toBeUndefined();
  });

  test("format persis dan hanya komentar open", () => {
    const hasil = commentsPrompt([
      komentar("c_2", "open", 2, "Ubah warna tombol", "masuk"),
      komentar("c_1", "done", 1, "Tidak tampil"),
      komentar("c_3", "open", 1, "Perbesar judul"),
    ]);
    expect(hasil).toBe(
      `${KEPALA}\n\n` +
        `- [c_3] design/pages/beranda.html, elemen \`[id="judul"]\`: Perbesar judul\n` +
        `- [c_2] design/pages/masuk.html, elemen \`[id="judul"]\`: Ubah warna tombol`,
    );
    expect(hasil).not.toContain("Tidak tampil");
  });

  test("baris baru dan karakter kontrol diganti spasi", () => {
    const hasil = commentsPrompt([
      komentar("c_1", "open", 1, "baris satu\nbaris\ttdua\u0000tiga"),
    ]);
    expect(hasil).toContain(": baris satu baris tdua tiga");
    expect(hasil).not.toContain("\nbaris");
  });
});

describe("isOrphan", () => {
  test("true bila halaman tak ada di daftar slug", () => {
    const slugs = new Set(["beranda"]);
    expect(isOrphan(komentar("c_1", "open", 1, "x", "beranda"), slugs)).toBe(false);
    expect(isOrphan(komentar("c_2", "open", 1, "x", "masuk"), slugs)).toBe(true);
  });
});

describe("commentNumbers", () => {
  test("nomor 1-based menurut createdAt naik, seri menurut id", () => {
    const nomor = commentNumbers([
      komentar("c_3", "open", 3),
      komentar("c_2", "open", 1),
      komentar("c_1", "open", 1),
    ]);
    expect(nomor.get("c_1")).toBe(1);
    expect(nomor.get("c_2")).toBe(2);
    expect(nomor.get("c_3")).toBe(3);
  });

  test("stabil saat status berubah", () => {
    const sebelum = commentNumbers([komentar("c_1", "open", 1), komentar("c_2", "open", 2)]);
    const sesudah = commentNumbers([komentar("c_1", "done", 1), komentar("c_2", "open", 2)]);
    expect(sesudah.get("c_1")).toBe(sebelum.get("c_1")!);
    expect(sesudah.get("c_2")).toBe(sebelum.get("c_2")!);
  });
});

describe("pinsForSlug", () => {
  test("semua komentar halaman itu, urut menurut nomor", () => {
    const daftar = [
      komentar("c_1", "open", 1, "satu", "beranda"),
      komentar("c_2", "done", 2, "dua", "masuk"),
      komentar("c_3", "done", 3, "tiga", "beranda"),
    ];
    expect(pinsForSlug(daftar, "beranda")).toEqual([
      { id: "c_1", selector: '[id="judul"]', n: 1, done: false },
      { id: "c_3", selector: '[id="judul"]', n: 3, done: true },
    ]);
    expect(pinsForSlug(daftar, "masuk")).toEqual([
      { id: "c_2", selector: '[id="judul"]', n: 2, done: true },
    ]);
    expect(pinsForSlug(daftar, "lain")).toEqual([]);
  });
});
