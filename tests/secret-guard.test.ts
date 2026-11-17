import { describe, expect, test } from "bun:test";
import { findSecret } from "../src/server/memory/secret-guard";

describe("findSecret: pola terdeteksi", () => {
  const positives: Array<[string, string]> = [
    ["kunci API", "simpan sk-abcdefgh12345678 di env"],
    ["kunci API", "pakai sk-ant-api03-abcdefghijklmnop"],
    ["token GitHub", "github: ghp_abcdefghijklmnopqrst"],
    ["token GitLab", "gitlab: glpat-abcdefghijklmnop"],
    ["kunci AWS", "AKIAIOSFODNN7EXAMPLE"],
    ["token Bearer", "Authorization: Bearer abcdefghijklmnop"],
    ["kunci privat", "-----BEGIN RSA PRIVATE KEY-----"],
    ["kredensial", "password = rahasia123"],
    ["kredensial", "api_key: supersecretvalue"],
    ["kredensial", "TOKEN: abcdefghij"],
    ["string acak panjang", "0123456789abcdef0123456789abcdef01234567"],
  ];

  for (const [kind, text] of positives) {
    test(`${kind}: ${text.slice(0, 24)}`, () => {
      expect(findSecret(text)).toBe(kind);
    });
  }
});

describe("findSecret: tidak pernah mengembalikan teks yang cocok", () => {
  test("nama pola saja, bukan rahasianya", () => {
    const secret = "sk-abcdefgh12345678";
    const found = findSecret(`nilai ${secret} terdeteksi`);
    expect(found).toBe("kunci API");
    expect(found).not.toContain(secret);
    expect(found).not.toContain("sk-");
  });

  test("kunci privat: nama pola tanpa isi", () => {
    const found = findSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nisi");
    expect(found).toBe("kunci privat");
    expect(found).not.toContain("BEGIN");
  });
});

describe("findSecret: teks biasa lolos", () => {
  const negatives = [
    "gunakan bun test",
    "Jalankan bun run typecheck sebelum commit.",
    "password lama sudah diganti",
    "Token harus diisi manual",
    "Kata sandi dan kunci disimpan di server, tidak pernah di browser.",
    "Preferensi: jawaban singkat, Bahasa Indonesia.",
    "Password tanpa nilai tetap aman disimpan sebagai catatan biasa.",
    "Konvensi commit memakai Conventional Commits (feat, fix, docs).",
  ];

  for (const text of negatives) {
    test(text.slice(0, 32), () => {
      expect(findSecret(text)).toBeNull();
    });
  }

  test("kalimat panjang berspasi tetap lolos", () => {
    const sentence =
      "Tim memakai satu branch per tugas dan satu merge request per service " +
      "supaya riwayat perubahan mudah ditelusuri kembali nanti.";
    expect(sentence.split(/\s+/).some((word) => word.length >= 40)).toBe(false);
    expect(findSecret(sentence)).toBeNull();
  });

  test("hex panjang tanpa spasi terdeteksi, versi berspasi tidak", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    expect(hex.length).toBe(40);
    expect(findSecret(hex)).toBe("string acak panjang");
    expect(findSecret("a1b2 c3d4 e5f6 a7b8 c9d0 e1f2 a3b4 c5d6")).toBeNull();
  });
});

describe("findSecret: jalur berkas bukan rahasia", () => {
  test("jalur absolut panjang lolos", () => {
    const jalur = "/Users/x/Developer/sandbox/ujicoba/project2/src/lib/storage";
    expect(findSecret(`Berkas diubah: ${jalur}`)).toBeNull();
  });

  test("nama berkas panjang bergaris bawah lolos", () => {
    expect(findSecret("Berkas diubah: …/memory/deepseek_worker_delegation_pattern.md")).toBeNull();
    expect(findSecret("a /memory/limbah_keluar_two_track_flow_change b")).toBeNull();
  });

  test("hex panjang di antara garis miring tetap rahasia", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(findSecret(`/x/${hex}/y`)).toBe("string acak panjang");
  });

  test("jalur relatif panjang lolos", () => {
    const jalur = "src/server/memory/session-summary/session-summary-helper";
    expect(findSecret(`Berkas diubah: ${jalur}`)).toBeNull();
  });

  test("jalur dalam kalimat panjang tetap lolos", () => {
    const teks =
      "Sunting berkas src/server/browser/browser-manager.ts dan " +
      "src/server/memory/session-summary.ts pada 2026-11-15 sore.";
    expect(findSecret(teks)).toBeNull();
  });
});

describe("findSecret: string acak panjang tetap terdeteksi", () => {
  test("base64 40+ karakter dengan garis miring", () => {
    const base64 = "aB3dEfG4hIjK5lMnO6pQrS7tUvW8xYz0A1b2/C3d4E5fG6h";
    expect(base64.length).toBeGreaterThanOrEqual(40);
    expect(findSecret(`nilai ${base64} di sini`)).toBe("string acak panjang");
  });

  test("kunci AWS secret 40 karakter yang berisi garis miring", () => {
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(aws.length).toBe(40);
    expect(findSecret(`rahasia ${aws}`)).toBe("string acak panjang");
  });

  test("token tanpa garis miring tetap terdeteksi", () => {
    expect(findSecret("abcdefghij0123456789klmnopqrstuvwxyz0123456789")).toBe(
      "string acak panjang",
    );
  });
});
