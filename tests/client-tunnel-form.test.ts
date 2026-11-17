import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/client/lib/api";
import {
  CLOUDFLARED_INSTALL_COMMAND,
  TUNNEL_FORBIDDEN_MESSAGE,
  normalizePublicHost,
  parseTunnelStatus,
  shouldPollTunnel,
  tunnelBadge,
  tunnelErrorKind,
  tunnelErrorMessage,
  tunnelToggleReason,
  validatePublicHost,
  type TunnelStatus,
} from "../src/client/lib/tunnel-form";

function status(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    installed: true,
    enabled: false,
    running: false,
    hasToken: false,
    ...overrides,
  };
}

describe("validasi hostname publik", () => {
  test("hostname sah diterima", () => {
    expect(validatePublicHost("jejak.contoh.com")).toEqual({
      ok: true,
      host: "jejak.contoh.com",
    });
    expect(validatePublicHost("a-b.contoh.io")).toEqual({ ok: true, host: "a-b.contoh.io" });
  });

  test("spasi tepi dan huruf besar dirapikan dulu", () => {
    expect(normalizePublicHost("  Jejak.Contoh.COM ")).toBe("jejak.contoh.com");
    expect(validatePublicHost("  Jejak.Contoh.COM ")).toEqual({
      ok: true,
      host: "jejak.contoh.com",
    });
  });

  test("kosong ditolak", () => {
    const hasil = validatePublicHost("   ");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("belum diisi");
  });

  test("skema ditolak", () => {
    const hasil = validatePublicHost("https://jejak.contoh.com");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("http://");
  });

  test("path dan port ditolak", () => {
    expect(validatePublicHost("jejak.contoh.com/a").ok).toBe(false);
    expect(validatePublicHost("jejak.contoh.com:8443").ok).toBe(false);
  });

  test("wildcard ditolak", () => {
    expect(validatePublicHost("*.contoh.com").ok).toBe(false);
  });

  test("satu label ditolak", () => {
    const hasil = validatePublicHost("localhost");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("nama domain lengkap");
  });

  test("IP ditolak", () => {
    expect(validatePublicHost("192.168.1.5").ok).toBe(false);
  });

  test("label diawali tanda hubung ditolak", () => {
    expect(validatePublicHost("-jejak.contoh.com").ok).toBe(false);
  });
});

describe("alasan tombol Aktifkan nonaktif", () => {
  const siap = {
    networkEnabled: true,
    installed: true,
    publicHost: "jejak.contoh.com",
    hasToken: true,
    token: "",
  };

  test("syarat lengkap: tombol aktif", () => {
    expect(tunnelToggleReason(siap)).toBeUndefined();
  });

  test("token baru yang diketik juga memenuhi syarat", () => {
    expect(tunnelToggleReason({ ...siap, hasToken: false, token: "abc123" })).toBeUndefined();
  });

  test("akses jaringan mati", () => {
    expect(tunnelToggleReason({ ...siap, networkEnabled: false })).toContain(
      "Nyalakan akses dari jaringan",
    );
  });

  test("cloudflared belum terpasang", () => {
    const alasan = tunnelToggleReason({ ...siap, installed: false });
    expect(alasan).toContain("cloudflared belum terpasang");
    expect(alasan).toContain(CLOUDFLARED_INSTALL_COMMAND);
  });

  test("hostname kosong", () => {
    expect(tunnelToggleReason({ ...siap, publicHost: "" })).toContain("Hostname publik");
  });

  test("token belum ada", () => {
    expect(tunnelToggleReason({ ...siap, hasToken: false, token: "" })).toContain(
      "token tunnel",
    );
  });

  test("token berspasi ditolak", () => {
    expect(tunnelToggleReason({ ...siap, hasToken: false, token: "a b" })).toContain(
      "tanpa spasi",
    );
  });
});

describe("lencana status tunnel", () => {
  test("belum dimuat", () => {
    expect(tunnelBadge(undefined)).toContain("Memuat");
  });

  test("berjalan dan mati", () => {
    expect(tunnelBadge(status({ running: true }))).toBe("Berjalan");
    expect(tunnelBadge(status({ running: false }))).toBe("Mati");
  });
});

describe("pemetaan galat tunnel", () => {
  test("403 berarti hanya dari komputer server", () => {
    const galat = new ApiError("apa saja", 403);
    expect(tunnelErrorKind(galat)).toBe("forbidden");
    expect(tunnelErrorMessage(galat)).toBe(TUNNEL_FORBIDDEN_MESSAGE);
  });

  test("404 berarti fitur tak tersedia", () => {
    expect(tunnelErrorKind(new ApiError("tidak ada", 404))).toBe("unavailable");
  });

  test("galat lain memakai pesannya", () => {
    const galat = new ApiError("Gagal menyalakan tunnel.", 409);
    expect(tunnelErrorKind(galat)).toBe("message");
    expect(tunnelErrorMessage(galat)).toBe("Gagal menyalakan tunnel.");
  });

  test("galat tanpa pesan memakai teks umum", () => {
    expect(tunnelErrorMessage("bukan galat")).toBe("Permintaan gagal.");
  });
});

describe("polling status tunnel", () => {
  test("hanya saat terlihat dan menyala", () => {
    expect(shouldPollTunnel({ visible: true, enabled: true })).toBe(true);
    expect(shouldPollTunnel({ visible: false, enabled: true })).toBe(false);
    expect(shouldPollTunnel({ visible: true, enabled: false })).toBe(false);
  });
});

describe("baca status tunnel dari server", () => {
  test("bentuk sah dibaca apa adanya", () => {
    const hasil = parseTunnelStatus({
      installed: true,
      enabled: true,
      running: true,
      publicHost: "jejak.contoh.com",
      hasToken: true,
      url: "https://jejak.contoh.com",
      lastLine: "registered tunnel connection",
      error: "galat lama",
    });
    expect(hasil.installed).toBe(true);
    expect(hasil.enabled).toBe(true);
    expect(hasil.running).toBe(true);
    expect(hasil.hasToken).toBe(true);
    expect(hasil.publicHost).toBe("jejak.contoh.com");
    expect(hasil.url).toBe("https://jejak.contoh.com");
    expect(hasil.lastLine).toBe("registered tunnel connection");
    expect(hasil.error).toBe("galat lama");
  });

  test("bentuk tak dikenal memakai nilai aman", () => {
    const hasil = parseTunnelStatus({});
    expect(hasil).toEqual({
      installed: false,
      enabled: false,
      running: false,
      hasToken: false,
    });
  });

  test("token tak pernah muncul di status parsing", () => {
    const hasil = parseTunnelStatus({ hasToken: true, token: "rahasia" });
    expect(JSON.stringify(hasil)).not.toContain("rahasia");
  });
});
