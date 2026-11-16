/** Status autentikasi server. */
export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  /**
   * True bila sandi dibuat pengguna sehingga bisa login dan keluar manual.
   * Absent pada server lama: dianggap `true` bila `required` menyala.
   */
  manualLogin?: boolean;
}

/**
 * True bila tombol "Keluar" boleh tampil.
 * Mode desktop memakai sandi internal acak: keluar berarti terkunci sampai
 * restart, jadi tombolnya disembunyikan.
 */
export function canShowLogout(status: AuthStatus | undefined): boolean {
  if (status === undefined) return false;
  if (!status.required) return false;
  return status.manualLogin ?? true;
}

/** True bila status respons berarti "perlu login". */
export function isAuthError(status: number): boolean {
  return status === 401;
}

/** True bila host Browser adalah loopback. */
export function isLoopbackHostname(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "" ) return false;
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const valid = parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return valid && parts[0] === "127";
}

/**
 * True bila perlu peringatan "tanpa TLS": protokol bukan https dan host
 * bukan loopback (kata sandi dan cookie lalu berjalan sebagai teks biasa).
 */
export function needsTlsWarning(protocol: string, host: string): boolean {
  if (protocol === "https:") return false;
  return !isLoopbackHostname(host);
}

/** Teks hitung mundur untuk penundaan login. */
export function formatRetry(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Coba lagi sebentar lagi.";
  const total = Math.ceil(seconds);
  if (total < 60) return `Coba lagi dalam ${total} detik.`;
  const minutes = Math.ceil(total / 60);
  return `Coba lagi dalam ${minutes} menit.`;
}
