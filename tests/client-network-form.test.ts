import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NETWORK_PORT,
  NETWORK_WARNING,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  networkStatusText,
  networkUrls,
  parseNetworkStatus,
  resolveNetworkPort,
  shouldReloadNetworkStatus,
  validateNetworkPort,
  type NetworkStatus,
} from "../src/client/lib/network-form";

const STATUS: NetworkStatus = {
  enabled: true,
  port: 4747,
  listening: true,
  urls: ["http://192.168.1.5:4747"],
  passwordRequired: false,
};

describe("validasi port jaringan", () => {
  test("port sah diterima", () => {
    expect(validateNetworkPort("4747")).toEqual({ ok: true, port: 4747 });
    expect(validateNetworkPort(String(MIN_NETWORK_PORT))).toEqual({
      ok: true,
      port: MIN_NETWORK_PORT,
    });
    expect(validateNetworkPort(String(MAX_NETWORK_PORT))).toEqual({
      ok: true,
      port: MAX_NETWORK_PORT,
    });
  });

  test("port kosong ditolak", () => {
    const hasil = validateNetworkPort("   ");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("Port belum diisi.");
  });

  test("port bukan angka ditolak", () => {
    const hasil = validateNetworkPort("empatribu");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("angka");
  });

  test("port di luar rentang ditolak", () => {
    const hasil = validateNetworkPort("80");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.error).toContain("1024");
    const lain = validateNetworkPort("70000");
    expect(lain.ok).toBe(false);
  });
});

describe("teks dan daftar status jaringan", () => {
  test("status belum dimuat", () => {
    expect(networkStatusText(undefined)).toContain("Memuat");
  });

  test("listener mati: Mati", () => {
    expect(networkStatusText({ ...STATUS, listening: false })).toBe("Mati");
  });

  test("listener hidup: Mendengarkan di:", () => {
    expect(networkStatusText(STATUS)).toBe("Mendengarkan di:");
  });

  test("daftar URL kosong saat listener mati", () => {
    expect(networkUrls({ ...STATUS, listening: false })).toEqual([]);
    expect(networkUrls(undefined)).toEqual([]);
    expect(networkUrls(STATUS)).toEqual(["http://192.168.1.5:4747"]);
  });

  test("peringatan menyebut Tailscale dan HTTP biasa", () => {
    expect(NETWORK_WARNING).toContain("Tailscale");
    expect(NETWORK_WARNING).toContain("HTTP biasa");
    expect(NETWORK_WARNING).toContain("tidak dienkripsi");
  });
});

describe("pemicu muat ulang status jaringan", () => {
  test("pemicu berubah: status harus dimuat ulang", () => {
    expect(shouldReloadNetworkStatus(0, 1)).toBe(true);
    expect(shouldReloadNetworkStatus(3, 4)).toBe(true);
  });

  test("pemicu tak berubah: status tak dimuat ulang", () => {
    expect(shouldReloadNetworkStatus(2, 2)).toBe(false);
    expect(shouldReloadNetworkStatus(7, 7)).toBe(false);
  });

  test("belum pernah memuat: status dimuat saat mount", () => {
    expect(shouldReloadNetworkStatus(undefined, 0)).toBe(true);
  });
});

describe("port setelah muat ulang status", () => {
  test("kolom port belum diubah: port server jadi acuan", () => {
    expect(
      resolveNetworkPort({ serverPort: 5000, currentPort: "4747", edited: false }),
    ).toBe("5000");
  });

  test("isian port yang diketik pengguna tak ditimpa", () => {
    expect(
      resolveNetworkPort({ serverPort: 5000, currentPort: "9999", edited: true }),
    ).toBe("9999");
  });
});

describe("baca status jaringan dari server", () => {
  test("bentuk sah dibaca apa adanya", () => {
    const status = parseNetworkStatus({
      enabled: true,
      port: 5000,
      listening: true,
      urls: ["http://10.0.0.3:5000"],
      passwordRequired: false,
      error: "Port 5000 sudah dipakai proses lain.",
    });
    expect(status.port).toBe(5000);
    expect(status.urls).toEqual(["http://10.0.0.3:5000"]);
    expect(status.error).toContain("sudah dipakai");
  });

  test("bentuk tak dikenal memakai nilai aman", () => {
    const status = parseNetworkStatus({});
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.port).toBe(DEFAULT_NETWORK_PORT);
    expect(status.urls).toEqual([]);
    expect(status.passwordRequired).toBe(false);
    expect(status.error).toBeUndefined();
  });
});
