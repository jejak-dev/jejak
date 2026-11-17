import { describe, expect, test } from "bun:test";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  formatDateId,
  isAuthDisabledError,
  passwordStatusText,
  validatePasswordForm,
} from "../src/client/lib/password-form";

describe("validasi formulir sandi", () => {
  test("sandi kosong ditolak", () => {
    const hasil = validatePasswordForm({ password: "", repeat: "" });
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toBe("Sandi belum diisi.");
  });

  test("sandi terlalu pendek ditolak", () => {
    const hasil = validatePasswordForm({ password: "a".repeat(MIN_PASSWORD_LENGTH - 1), repeat: "a".repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("minimal");
  });

  test("sandi terlalu panjang ditolak", () => {
    const panjang = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    const hasil = validatePasswordForm({ password: panjang, repeat: panjang });
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("maksimal");
  });

  test("ulangan yang tak sama ditolak", () => {
    const hasil = validatePasswordForm({ password: "sandi-12345", repeat: "sandi-67890" });
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toBe("Ulangi sandi tidak sama.");
  });

  test("sandi sah diterima dan sandi lama tak ikut saat membuat baru", () => {
    const hasil = validatePasswordForm({ password: "sandi-12345", repeat: "sandi-12345" });
    expect(hasil.ok).toBe(true);
    expect(hasil.ok === true && hasil.password).toBe("sandi-12345");
    expect(hasil.ok === true && hasil.current).toBeUndefined();
  });

  test("mengganti sandi mewajibkan sandi lama", () => {
    const kosong = validatePasswordForm(
      { current: "", password: "sandi-12345", repeat: "sandi-12345" },
      { replacing: true },
    );
    expect(kosong.ok).toBe(false);
    expect(kosong.ok === false && kosong.error).toBe("Sandi lama belum diisi.");

    const sama = validatePasswordForm(
      { current: "sandi-12345", password: "sandi-12345", repeat: "sandi-12345" },
      { replacing: true },
    );
    expect(sama.ok).toBe(false);
    expect(sama.ok === false && sama.error).toBe("Sandi baru harus berbeda dari sandi lama.");
  });

  test("mengganti sandi yang sah menerima sandi lama", () => {
    const hasil = validatePasswordForm(
      { current: "sandi-lama-1", password: "sandi-baru-2", repeat: "sandi-baru-2" },
      { replacing: true },
    );
    expect(hasil.ok).toBe(true);
    expect(hasil.ok === true && hasil.current).toBe("sandi-lama-1");
  });
});

describe("teks status sandi", () => {
  test("belum ada sandi", () => {
    expect(passwordStatusText({ configured: false })).toBe("Belum ada sandi");
  });

  test("sandi aktif menyebut tanggal", () => {
    const teks = passwordStatusText({
      configured: true,
      updatedAt: "2026-11-16T08:00:00.000Z",
    });
    expect(teks.startsWith("Sandi aktif sejak ")).toBe(true);
    expect(teks).toContain("2026");
  });

  test("status belum dimuat", () => {
    expect(passwordStatusText(undefined)).toContain("Memuat");
  });

  test("tanggal tak terbaca ditolak", () => {
    expect(formatDateId("bukan tanggal")).toBeUndefined();
    expect(formatDateId("")).toBeUndefined();
    expect(formatDateId(undefined)).toBeUndefined();
  });

  test("galat autentikasi tidak aktif dikenali", () => {
    expect(isAuthDisabledError({ status: 404, message: "autentikasi tidak aktif" })).toBe(true);
    expect(isAuthDisabledError({ status: 404, message: "lain" })).toBe(false);
    expect(isAuthDisabledError({ status: 500, message: "autentikasi tidak aktif" })).toBe(false);
    expect(isAuthDisabledError(new Error("autentikasi tidak aktif"))).toBe(false);
    expect(isAuthDisabledError(undefined)).toBe(false);
  });
});
