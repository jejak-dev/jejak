import type { SessionInfo } from "../../server/sessions/session-manager";

/**
 * Jembatan ke cangkang desktop (Tauri). Halaman Jejak yang dibuka di peramban
 * biasa tidak punya jembatan ini, jadi seluruh UI pembaruan disembunyikan di sana.
 */

/** Keadaan pembaruan yang dilaporkan cangkang desktop. */
export type UpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

/** Status pembaruan seperti yang dikirim perintah IPC `updater_status`. */
export interface UpdaterStatus {
  state: UpdaterState;
  version?: string;
  notes?: string;
  date?: string;
  downloaded?: number;
  total?: number;
  error?: string;
  /** Waktu pemeriksaan terakhir; epoch detik. */
  lastCheck?: number;
}

/** Pengaturan pembaruan yang disimpan cangkang desktop. */
export interface UpdaterSettings {
  autoCheck: boolean;
  channel: "stable" | "beta";
}

/** Informasi aplikasi desktop; sumber: perintah `desktop_info`. */
export interface DesktopInfo {
  version: string;
  platform: "macos" | "windows" | "linux";
}

/**
 * Fungsi pemanggilan perintah IPC. Bentuknya sengaja abstrak supaya tes
 * bisa menyuntik jembatan tiruan tanpa Tauri.
 */
export interface DesktopBridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/** Nama perintah IPC yang dipakai; kontrak dengan sisi Rust. */
export const DESKTOP_COMMANDS = {
  info: "desktop_info",
  getSettings: "updater_get_settings",
  setSettings: "updater_set_settings",
  check: "updater_check",
  status: "updater_status",
  install: "updater_install",
  restart: "updater_restart",
} as const;

/** Nama platform yang dikenali. */
const PLATFORMS = ["macos", "windows", "linux"] as const;

export type DesktopPlatform = (typeof PLATFORMS)[number];

const UPDATER_STATES: readonly UpdaterState[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "installing",
  "ready",
  "error",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdaterState(value: unknown): value is UpdaterState {
  return typeof value === "string" && (UPDATER_STATES as readonly string[]).includes(value);
}

/** Angka yang dipakai: harus terbatas dan tidak negatif. */
function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value === "" ? undefined : value;
}

/**
 * Jembatan desktop bila halaman dijalankan di dalam cangkang Tauri.
 *
 * Di peramban biasa `__TAURI_INTERNALS__` tidak ada, jadi hasilnya `undefined`
 * dan seluruh UI pembaruan tidak dirender.
 */
export function desktopBridge(): DesktopBridge | undefined {
  const scope = globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } };
  const internals = scope.__TAURI_INTERNALS__;
  if (internals === undefined || internals === null) return undefined;
  const invoke = internals.invoke;
  if (typeof invoke !== "function") return undefined;
  const call = invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  return {
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      return call(cmd, args) as Promise<T>;
    },
  };
}

/**
 * Bentuk status yang tak dikenal berubah jadi `idle`; angka negatif atau NaN
 * dibuang supaya tampilan tak pernah menampilkan angka rusak.
 */
export function parseUpdaterStatus(raw: unknown): UpdaterStatus {
  if (!isRecord(raw)) return { state: "idle" };
  if (!isUpdaterState(raw.state)) return { state: "idle" };
  const status: UpdaterStatus = { state: raw.state };
  const version = nonEmptyString(raw.version);
  if (version !== undefined) status.version = version;
  const notes = nonEmptyString(raw.notes);
  if (notes !== undefined) status.notes = notes;
  const date = nonEmptyString(raw.date);
  if (date !== undefined) status.date = date;
  const downloaded = nonNegativeNumber(raw.downloaded);
  if (downloaded !== undefined) status.downloaded = downloaded;
  const total = nonNegativeNumber(raw.total);
  if (total !== undefined) status.total = total;
  const error = nonEmptyString(raw.error);
  if (error !== undefined) status.error = error;
  const lastCheck = nonNegativeNumber(raw.lastCheck);
  if (lastCheck !== undefined) status.lastCheck = lastCheck;
  return status;
}

/** Persentase unduhan 0-100; `undefined` bila total tak diketahui. */
export function downloadPercent(status: UpdaterStatus): number | undefined {
  const downloaded = status.downloaded;
  const total = status.total;
  if (downloaded === undefined || total === undefined) return undefined;
  if (total <= 0) return undefined;
  const percent = Math.floor((downloaded / total) * 100);
  if (!Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

/** Status pembaruan dalam satu baris singkat. */
export function updaterStatusLine(status: UpdaterStatus): string {
  switch (status.state) {
    case "checking":
      return "Memeriksa…";
    case "available":
      return status.version === undefined
        ? "Pembaruan tersedia"
        : `Pembaruan ${status.version} tersedia`;
    case "downloading": {
      const percent = downloadPercent(status);
      return percent === undefined ? "Mengunduh…" : `Mengunduh ${percent}%`;
    }
    case "installing":
      return "Memasang…";
    case "ready":
      return "Siap dimulai ulang";
    case "error":
      return `Gagal: ${status.error ?? "tidak diketahui"}`;
    case "idle":
    default:
      return "Terbaru";
  }
}

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function dateText(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const bulan = BULAN[date.getMonth()] ?? "";
  return `${date.getDate()} ${bulan} ${date.getFullYear()}`;
}

/**
 * Kapan pemeriksaan terakhir dilakukan, relatif terhadap `now` (epoch detik).
 * `now` disuntik supaya hasilnya bisa diuji tanpa bergantung jam sistem.
 */
export function lastCheckText(lastCheck: number | undefined, now: number): string {
  if (lastCheck === undefined) return "belum pernah";
  if (!Number.isFinite(lastCheck) || lastCheck <= 0) return "belum pernah";
  if (!Number.isFinite(now)) return "belum pernah";
  const selisih = now - lastCheck;
  if (selisih < 60) return "baru saja";
  if (selisih < 3600) return `${Math.floor(selisih / 60)} menit lalu`;
  if (selisih < 86400) return `${Math.floor(selisih / 3600)} jam lalu`;
  return dateText(lastCheck);
}

/**
 * Peringatan sebelum aplikasi dimulai ulang: sesi yang sedang berjalan dan
 * tujuan Goal yang aktif akan terputus. `undefined` bila tak ada yang berjalan.
 */
export function restartWarning(sessions: readonly SessionInfo[]): string | undefined {
  let berjalan = 0;
  let tujuan = 0;
  for (const session of sessions) {
    if (session.status === "berjalan") berjalan += 1;
    if (session.goal?.status === "active") tujuan += 1;
  }
  if (berjalan === 0 && tujuan === 0) return undefined;
  const bagian: string[] = [];
  if (berjalan > 0) bagian.push(`${berjalan} sesi sedang berjalan`);
  if (tujuan > 0) bagian.push(`${tujuan} tujuan aktif`);
  return `${bagian.join(" dan ")}. Mulai ulang akan menghentikan proses yang sedang berjalan.`;
}

/** Pesan galat yang bisa dibaca pengguna. */
export function desktopErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? "Terjadi kesalahan pada cangkang desktop." : error.message;
  }
  const teks = String(error);
  return teks === "" ? "Terjadi kesalahan pada cangkang desktop." : teks;
}

/** Balasan `desktop_info` yang tidak dikenal ditolak. */
export function parseDesktopInfo(raw: unknown): DesktopInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const version = nonEmptyString(raw.version);
  if (version === undefined) return undefined;
  const platform = raw.platform;
  if (typeof platform !== "string") return undefined;
  const dinormalisasi = normalisasiPlatform(platform);
  if (dinormalisasi === undefined) return undefined;
  return { version, platform: dinormalisasi };
}

function normalisasiPlatform(platform: string): DesktopPlatform | undefined {
  const kunci = platform.toLowerCase();
  if (kunci === "macos" || kunci === "darwin" || kunci === "mac") return "macos";
  if (kunci === "windows" || kunci === "win32") return "windows";
  if (kunci === "linux") return "linux";
  return undefined;
}

/** Pengaturan pembaruan yang tidak dikenal ditolak. */
export function parseUpdaterSettings(raw: unknown): UpdaterSettings | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.autoCheck !== "boolean") return undefined;
  if (raw.channel !== "stable" && raw.channel !== "beta") return undefined;
  return { autoCheck: raw.autoCheck, channel: raw.channel };
}

/** Klien pembaruan: pemetaan perintah IPC ke bentuk yang sudah divalidasi. */
export interface UpdaterClient {
  info(): Promise<DesktopInfo>;
  getSettings(): Promise<UpdaterSettings>;
  setSettings(settings: UpdaterSettings): Promise<UpdaterSettings>;
  check(): Promise<UpdaterStatus>;
  status(): Promise<UpdaterStatus>;
  install(): Promise<void>;
  restart(): Promise<void>;
}

async function call<T>(
  bridge: DesktopBridge,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await bridge.invoke<T>(cmd, args);
  } catch (caught) {
    throw new Error(desktopErrorMessage(caught));
  }
}

/**
 * Klien pembaruan di atas jembatan desktop. Semua galat perintah menjadi
 * `Error` biasa dengan pesan yang bisa ditampilkan.
 */
export function createUpdaterClient(bridge: DesktopBridge): UpdaterClient {
  return {
    async info(): Promise<DesktopInfo> {
      const raw = await call<unknown>(bridge, DESKTOP_COMMANDS.info);
      const info = parseDesktopInfo(raw);
      if (info === undefined) {
        throw new Error("Balasan desktop_info tidak dikenal.");
      }
      return info;
    },
    async getSettings(): Promise<UpdaterSettings> {
      const raw = await call<unknown>(bridge, DESKTOP_COMMANDS.getSettings);
      const settings = parseUpdaterSettings(raw);
      if (settings === undefined) {
        throw new Error("Balasan pengaturan pembaruan tidak dikenal.");
      }
      return settings;
    },
    async setSettings(settings: UpdaterSettings): Promise<UpdaterSettings> {
      const raw = await call<unknown>(bridge, DESKTOP_COMMANDS.setSettings, {
        autoCheck: settings.autoCheck,
        channel: settings.channel,
      });
      const saved = parseUpdaterSettings(raw);
      if (saved === undefined) {
        throw new Error("Balasan pengaturan pembaruan tidak dikenal.");
      }
      return saved;
    },
    async check(): Promise<UpdaterStatus> {
      return parseUpdaterStatus(await call<unknown>(bridge, DESKTOP_COMMANDS.check));
    },
    async status(): Promise<UpdaterStatus> {
      return parseUpdaterStatus(await call<unknown>(bridge, DESKTOP_COMMANDS.status));
    },
    async install(): Promise<void> {
      await call<unknown>(bridge, DESKTOP_COMMANDS.install);
    },
    async restart(): Promise<void> {
      await call<unknown>(bridge, DESKTOP_COMMANDS.restart);
    },
  };
}
