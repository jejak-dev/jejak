import { describe, expect, test } from "bun:test";
import { secretWarning } from "../src/client/lib/secret-warning";

describe("secretWarning", () => {
  test("teks tanpa rahasia tidak memberi peringatan", () => {
    expect(secretWarning("tolong jelaskan struktur proyek ini")).toBeUndefined();
  });

  test("teks kosong atau hanya spasi tidak memberi peringatan", () => {
    expect(secretWarning("")).toBeUndefined();
    expect(secretWarning("   \n\t")).toBeUndefined();
  });

  test("kunci API terdeteksi dengan jenis kunci API", () => {
    const warning = secretWarning("pakai kunci sk-abcdefgh12345678 ya");
    expect(warning?.kinds).toEqual(["kunci API"]);
  });

  test("token Bearer dan baris kredensial .env terdeteksi", () => {
    expect(secretWarning("Bearer abcdefgh12345678")?.kinds).toEqual(["token Bearer"]);
    expect(secretWarning("API_KEY=abcdefgh12345678")?.kinds).toEqual(["kredensial"]);
  });

  test("kinds unik dan terurut", () => {
    const warning = secretWarning(
      "glpat-abcdefgh12345678 dan sk-abcdefgh12345678 dan sk-zzzzzzzz12345678",
    );
    expect(warning?.kinds).toEqual(["kunci API", "token GitLab"]);
  });

  test("pesan tidak memuat nilai rahasia", () => {
    const warning = secretWarning("sk-abcdefgh12345678");
    expect(warning).toBeDefined();
    expect(warning?.message).not.toContain("abcdefgh12345678");
    expect(warning?.message).toContain("rahasia");
  });

  test("banyak jenis memakai 'dan lainnya' setelah tiga jenis", () => {
    const warning = secretWarning(
      [
        "ghp_abcdefgh12345678",
        "glpat-abcdefgh12345678",
        "AKIAABCDEFGHIJKLMNOP",
        "xoxb-abcdefgh123",
        "sk-abcdefgh12345678",
      ].join(" "),
    );
    expect(warning?.kinds.length).toBe(5);
    expect(warning?.message).toContain("dan lainnya");
    expect(warning?.message).not.toContain("token Slack");
  });
});
