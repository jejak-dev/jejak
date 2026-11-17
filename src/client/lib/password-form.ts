/** Panjang minimal kata sandi. */
export const MIN_PASSWORD_LENGTH = 8;
/** Panjang maksimum kata sandi. */
export const MAX_PASSWORD_LENGTH = 256;

/** Isi formulir sandi. */
export interface PasswordFormValues {
  /** Sandi lama; wajib saat sandi yang ada diganti. */
  current?: string;
  /** Sandi baru. */
  password: string;
  /** Pengulangan sandi baru. */
  repeat: string;
}

/** Opsi validasi formulir. */
export interface PasswordFormOptions {
  /** True bila sandi sudah ada; sandi lama jadi wajib. */
  replacing?: boolean;
}

/** Hasil validasi formulir sandi. */
export type PasswordFormResult =
  | { ok: true; password: string; current?: string }
  | { ok: false; error: string };

/** Status sandi milik pengguna. */
export interface PasswordStatus {
  /** True bila sandi tersimpan ada. */
  configured: boolean;
  /** Waktu sandi terakhir diubah (ISO). */
  updatedAt?: string;
}

/**
 * Periksa isian formulir sandi. Semua pesan dalam Bahasa Indonesia.
 * Fungsi murni: tanpa DOM dan tanpa jaringan, jadi bisa dites sendiri.
 */
export function validatePasswordForm(
  values: PasswordFormValues,
  options: PasswordFormOptions = {},
): PasswordFormResult {
  const current = values.current ?? "";
  const password = values.password ?? "";
  const repeat = values.repeat ?? "";

  if (options.replacing === true) {
    if (current === "") {
      return { ok: false, error: "Sandi lama belum diisi." };
    }
    if (current === password) {
      return { ok: false, error: "Sandi baru harus berbeda dari sandi lama." };
    }
  }

  if (password === "") {
    return { ok: false, error: "Sandi belum diisi." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Sandi minimal ${MIN_PASSWORD_LENGTH} karakter.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Sandi maksimal ${MAX_PASSWORD_LENGTH} karakter.` };
  }
  if (repeat !== password) {
    return { ok: false, error: "Ulangi sandi tidak sama." };
  }

  return {
    ok: true,
    password,
    ...(options.replacing === true ? { current } : {}),
  };
}

/** Tanggal dalam Bahasa Indonesia; `undefined` bila nilai tak terbaca. */
export function formatDateId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Teks status sandi untuk kartu Akses & sandi. */
export function passwordStatusText(status: PasswordStatus | undefined): string {
  if (status === undefined) return "Memuat status sandi…";
  if (!status.configured) return "Belum ada sandi";
  const date = formatDateId(status.updatedAt);
  return date === undefined ? "Sandi aktif" : `Sandi aktif sejak ${date}`;
}

/** Catatan pengganti formulir saat server mandiri berjalan tanpa sandi. */
export const PASSWORD_DESKTOP_ONLY_NOTE =
  "Server ini berjalan tanpa sandi, jadi sandi belum bisa dibuat dari sini. Jalankan ulang dengan JEJAK_PASSWORD=sandimu (atau --password), atau pakai aplikasi desktop.";

/**
 * Pure: apakah galat berarti server berjalan tanpa autentikasi (404
 * "autentikasi tidak aktif"). Galat ini bukan kesalahan pengguna sehingga
 * tidak boleh tampil sebagai galat merah.
 */
export function isAuthDisabledError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  const message = (error as { message?: unknown }).message;
  return (
    status === 404 &&
    typeof message === "string" &&
    message.includes("autentikasi tidak aktif")
  );
}
