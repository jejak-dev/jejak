import type { TunnelStatus } from "../../server/network/tunnel-manager";

export type { TunnelStatus };

/** Jeda polling status tunnel selama bagian terlihat dan tunnel menyala. */
export const TUNNEL_POLL_MS = 5_000;

/** Perintah pemasangan cloudflared yang ditampilkan ke pengguna. */
export const CLOUDFLARED_INSTALL_COMMAND = "brew install cloudflared";

/** Pesan saat server menolak perubahan dari perangkat lain (403). */
export const TUNNEL_FORBIDDEN_MESSAGE =
  "Pengaturan ini hanya bisa diubah dari komputer yang menjalankan Jejak.";

/** Pesan saat biner cloudflared belum ditemukan. */
export const TUNNEL_INSTALL_MESSAGE = `cloudflared belum terpasang. Pasang dengan: ${CLOUDFLARED_INSTALL_COMMAND}`;

/** Hasil validasi kolom hostname publik. */
export type PublicHostResult =
  | { ok: true; host: string }
  | { ok: false; error: string };

/** Rapikan isian hostname: buang spasi tepi dan huruf besar. */
export function normalizePublicHost(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Periksa kolom hostname publik. Aturannya mencerminkan `isValidPublicHost`
 * di server: FQDN huruf kecil, tanpa skema, port, path, atau wildcard.
 * Fungsi murni: tanpa DOM dan tanpa jaringan.
 */
export function validatePublicHost(raw: string): PublicHostResult {
  const host = normalizePublicHost(raw);
  if (host === "") return { ok: false, error: "Hostname publik belum diisi." };
  if (host.length > 253) return { ok: false, error: "Hostname publik terlalu panjang." };
  if (host.includes("://")) {
    return { ok: false, error: "Tulis hostname saja, tanpa http:// atau https://." };
  }
  if (host.includes("/")) {
    return { ok: false, error: "Tulis hostname saja, tanpa path." };
  }
  if (host.includes(":")) {
    return { ok: false, error: "Tulis hostname saja, tanpa port." };
  }
  if (host.includes("*")) {
    return { ok: false, error: "Wildcard tidak didukung; tulis satu hostname." };
  }
  if (/\s/.test(host)) {
    return { ok: false, error: "Hostname publik tidak boleh berisi spasi." };
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    return { ok: false, error: "Tulis nama domain lengkap, mis. jejak.contoh.com." };
  }
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return { ok: false, error: "Tiap bagian hostname harus 1-63 karakter." };
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return {
        ok: false,
        error: "Hostname hanya boleh huruf kecil, angka, dan tanda hubung.",
      };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return {
        ok: false,
        error: "Bagian hostname tidak boleh diawali atau diakhiri tanda hubung.",
      };
    }
  }
  if (labels.every((label) => /^\d+$/.test(label))) {
    return { ok: false, error: "Tulis nama domain, bukan alamat IP." };
  }
  return { ok: true, host };
}

/** Masukan penentu alasan tombol "Aktifkan" nonaktif. */
export interface TunnelToggleInput {
  /** True bila akses dari jaringan sudah menyala. */
  networkEnabled: boolean;
  /** True bila biner cloudflared ditemukan server. */
  installed: boolean;
  /** Isian kolom hostname publik. */
  publicHost: string;
  /** True bila token tersimpan sudah ada. */
  hasToken: boolean;
  /** Isian kolom token (kosong bila tak diketik). */
  token: string;
  /** True bila server berjalan tanpa sandi sehingga tunnel tak bisa dinyalakan. */
  authDisabled?: boolean;
}

/**
 * Pure: alasan tombol "Aktifkan" nonaktif, atau `undefined` bila siap.
 * Urutannya mengikuti syarat server supaya pesan pertama yang tampil paling
 * mendasar.
 */
export function tunnelToggleReason(input: TunnelToggleInput): string | undefined {
  if (input.authDisabled === true) return "Butuh sandi";
  if (!input.networkEnabled) return "Nyalakan akses dari jaringan dulu.";
  if (!input.installed) return TUNNEL_INSTALL_MESSAGE;
  const host = validatePublicHost(input.publicHost);
  if (!host.ok) return host.error;
  const token = input.token.trim();
  if (token === "" && !input.hasToken) return "Tempel token tunnel dulu.";
  if (token !== "" && /\s/.test(token)) {
    return "Token tunnel harus teks tanpa spasi atau baris baru.";
  }
  return undefined;
}

/** Teks lencana status tunnel. */
export function tunnelBadge(status: TunnelStatus | undefined): string {
  if (status === undefined) return "Memuat…";
  return status.running ? "Berjalan" : "Mati";
}

/** Nada titik lencana status tunnel. */
export function tunnelBadgeTone(status: TunnelStatus | undefined): "success" | "muted" {
  return status?.running === true ? "success" : "muted";
}

/** Jenis galat tunnel: 403 (perangkat lain), 404 (fitur tak ada), atau pesan. */
export type TunnelErrorKind = "forbidden" | "unavailable" | "message";

/** Pure: klasifikasikan galat API berdasarkan status HTTP-nya. */
export function tunnelErrorKind(error: unknown): TunnelErrorKind {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 403) return "forbidden";
  if (status === 404) return "unavailable";
  return "message";
}

/** Pesan galat yang aman ditampilkan; token tak pernah ikut di sini. */
export function tunnelErrorMessage(error: unknown): string {
  if (tunnelErrorKind(error) === "forbidden") return TUNNEL_FORBIDDEN_MESSAGE;
  if (error instanceof Error && error.message !== "") return error.message;
  return "Permintaan gagal.";
}

/** Pure: apakah status tunnel perlu dipolling. */
export function shouldPollTunnel(input: {
  /** True bila bagian sedang terlihat di layar. */
  visible: boolean;
  /** True bila tunnel diizinkan menyala. */
  enabled: boolean;
}): boolean {
  return input.visible && input.enabled;
}

/**
 * Baca status tunnel dari respons server. Bentuk tak dikenal memakai nilai
 * aman (mati, tanpa token) supaya klien tak menampilkan keadaan palsu.
 */
export function parseTunnelStatus(value: unknown): TunnelStatus {
  const record = (value ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const raw = record[key];
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  };
  const publicHost = text("publicHost");
  const url = text("url");
  const error = text("error");
  const lastLine = text("lastLine");
  return {
    installed: record["installed"] === true,
    enabled: record["enabled"] === true,
    running: record["running"] === true,
    hasToken: record["hasToken"] === true,
    ...(publicHost === undefined ? {} : { publicHost }),
    ...(url === undefined ? {} : { url }),
    ...(error === undefined ? {} : { error }),
    ...(lastLine === undefined ? {} : { lastLine }),
  };
}
