import type { NetworkStatus } from "../../server/network/network-manager";

export type { NetworkStatus };

/** Port bawaan listener jaringan. */
export const DEFAULT_NETWORK_PORT = 4747;
/** Port terkecil yang boleh dipakai (di atas port hakIstimewa). */
export const MIN_NETWORK_PORT = 1024;
/** Port terbesar yang sah. */
export const MAX_NETWORK_PORT = 65535;

/** Peringatan yang selalu tampil saat fitur ini dipakai. */
export const NETWORK_WARNING =
  "Perangkat di jaringan yang sama bisa membuka Jejak dengan sandi ini dan menjalankan agen di komputermu. " +
  "Pakai hanya di jaringan tepercaya atau lewat Tailscale; koneksi ini HTTP biasa (sandi tidak dienkripsi di jaringan lokal).";

/** Catatan soal dialog firewall macOS. */
export const NETWORK_FIREWALL_NOTE =
  'macOS mungkin menampilkan dialog "terima koneksi masuk" saat pertama kali.';

/** Hasil validasi kolom port. */
export type NetworkPortResult =
  | { ok: true; port: number }
  | { ok: false; error: string };

/**
 * Periksa kolom port listener jaringan. Semua pesan dalam Bahasa Indonesia.
 * Fungsi murni: tanpa DOM dan tanpa jaringan, jadi bisa dites sendiri.
 */
export function validateNetworkPort(raw: string): NetworkPortResult {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, error: "Port belum diisi." };
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: "Port harus berupa angka." };
  }
  const port = Number(value);
  if (port < MIN_NETWORK_PORT || port > MAX_NETWORK_PORT) {
    return {
      ok: false,
      error: `Port harus antara ${MIN_NETWORK_PORT} dan ${MAX_NETWORK_PORT}.`,
    };
  }
  return { ok: true, port };
}

/**
 * Kunci pemicu muat ulang status jaringan. Nilainya berubah setiap kali
 * status sandi berubah (sandi dibuat, diganti, atau dihapus).
 */
export type NetworkRefreshKey = number;

/**
 * Pure: apakah status jaringan perlu dimuat ulang.
 *
 * `lastKey` adalah kunci yang terakhir dimuat; `undefined` berarti belum
 * pernah memuat (saud mounting). Kunci yang sama berarti status sandi tak
 * berubah sehingga tak perlu muat ulang.
 */
export function shouldReloadNetworkStatus(
  lastKey: NetworkRefreshKey | undefined,
  nextKey: NetworkRefreshKey,
): boolean {
  return lastKey !== nextKey;
}

/**
 * Pure: port yang tampil setelah muat ulang status.
 *
 * Isian port yang sedang diketik pengguna dipertahankan; kalau kolom port
 * belum pernah diubah, port dari server jadi acuan.
 */
export function resolveNetworkPort(options: {
  /** Port menurut status terbaru dari server. */
  serverPort: number;
  /** Isian kolom port saat ini. */
  currentPort: string;
  /** True bila pengguna sudah mengubah kolom port sendiri. */
  edited: boolean;
}): string {
  if (options.edited) return options.currentPort;
  return String(options.serverPort);
}

/** Teks status akses jaringan: "Mati" atau "Mendengarkan di:". */
export function networkStatusText(status: NetworkStatus | undefined): string {
  if (status === undefined) return "Memuat status jaringan…";
  return status.listening ? "Mendengarkan di:" : "Mati";
}

/** Lencana status jaringan: label singkat dan nada titiknya. */
export function networkBadge(status: NetworkStatus | undefined): {
  label: string;
  tone: "success" | "muted";
} {
  if (status === undefined) return { label: "Memuat…", tone: "muted" };
  return status.listening
    ? { label: "Aktif", tone: "success" }
    : { label: "Mati", tone: "muted" };
}

/** Daftar URL yang boleh dibuka; kosong saat listener tak menyala. */
export function networkUrls(status: NetworkStatus | undefined): string[] {
  if (status === undefined) return [];
  if (!status.listening) return [];
  return status.urls;
}

/**
 * Pure: URL mana yang kodenya terbuka setelah tombol QR ditekan.
 * Satu kode terbuka sekali; menekan tombol yang sama menutupnya.
 */
export function toggleQrUrl(
  current: string | undefined,
  url: string,
): string | undefined {
  return current === url ? undefined : url;
}

/**
 * Baca status jaringan dari respons server. Bentuk tak dikenal memakai nilai
 * aman (mati) supaya klien tak pernah menampilkan keadaan palsu.
 */
export function parseNetworkStatus(value: unknown): NetworkStatus {
  const record = (value ?? {}) as Record<string, unknown>;
  const port = record["port"];
  const urls = record["urls"];
  const error = record["error"];
  return {
    enabled: record["enabled"] === true,
    port:
      typeof port === "number" && Number.isInteger(port) ? port : DEFAULT_NETWORK_PORT,
    listening: record["listening"] === true,
    urls: Array.isArray(urls)
      ? urls.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof error === "string" && error !== "" ? { error } : {}),
    passwordRequired: record["passwordRequired"] === true,
  };
}
