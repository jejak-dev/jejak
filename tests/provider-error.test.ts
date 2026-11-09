import { describe, expect, test } from "bun:test";
import { classifyProviderError, describeFallbackReason } from "../src/server/agent/provider-error";

describe("classifyProviderError", () => {
  test("koneksi", () => {
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:443",
      "read ECONNRESET",
      "getaddrinfo ENOTFOUND api.example",
      "ETIMEDOUT",
      "timeout after 30s",
      "Request timed out",
      "fetch failed",
      "socket hang up",
      "network error",
      "Tidak dapat terhubung ke server",
    ]) {
      expect(classifyProviderError(message)).toBe("koneksi");
    }
  });

  test("auth", () => {
    for (const message of ["HTTP 401", "403 Forbidden", "Unauthorized", "invalid api key", "Authentication failed"]) {
      expect(classifyProviderError(message)).toBe("auth");
    }
  });

  test("batas", () => {
    for (const message of ["HTTP 429", "rate limit exceeded", "Too Many Requests", "quota habis"]) {
      expect(classifyProviderError(message)).toBe("batas");
    }
  });

  test("server", () => {
    for (const message of ["500", "502 bad gateway", "503 service unavailable", "504", "529 overloaded", "overloaded_error"]) {
      expect(classifyProviderError(message)).toBe("server");
    }
  });

  test("case-insensitive", () => {
    expect(classifyProviderError("FETCH FAILED")).toBe("koneksi");
    expect(classifyProviderError("Rate Limit")).toBe("batas");
  });

  test("angka dicocokkan dengan batas kata", () => {
    expect(classifyProviderError("model 1401 tidak ada")).toBeUndefined();
    expect(classifyProviderError("token 4290")).toBeUndefined();
    expect(classifyProviderError("kode 5001")).toBeUndefined();
    expect(classifyProviderError("4096 token")).toBeUndefined();
    expect(classifyProviderError("model-403b")).toBe("auth");
  });

  test("dibatalkan dan galat non-provider tidak diklasifikasi", () => {
    for (const message of [
      "dibatalkan",
      "sesi berakhir tanpa hasil",
      "izin ditolak",
      "tool gagal",
      "prompt kosong",
      "",
    ]) {
      expect(classifyProviderError(message)).toBeUndefined();
    }
  });
});

describe("describeFallbackReason", () => {
  test("teks pendek Indonesia per kategori", () => {
    expect(describeFallbackReason("koneksi")).toBe("koneksi gagal");
    expect(describeFallbackReason("auth")).toBe("autentikasi ditolak");
    expect(describeFallbackReason("batas")).toBe("batas laju");
    expect(describeFallbackReason("server")).toBe("galat server");
  });
});
