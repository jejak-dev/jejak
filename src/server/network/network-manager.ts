import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { PasswordStore } from "../auth/password-store";
import {
  DEFAULT_NETWORK_PORT,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_STORE_VERSION,
  isValidNetworkPort,
  type NetworkSettings,
  type NetworkStore,
} from "./network-store";
import { networkFetch, type SocketLike } from "./network-fetch";

/** Nama host yang didengarkan listener jaringan (semua antarmuka). */
export const NETWORK_HOSTNAME = "0.0.0.0";

/** Status akses dari jaringan; aman dikirim ke klien (tanpa data sensitif). */
export interface NetworkStatus {
  /** True bila akses dari jaringan diizinkan oleh pengguna. */
  enabled: boolean;
  /** Port listener jaringan. */
  port: number;
  /** True bila listener benar-benar menyala. */
  listening: boolean;
  /** Alamat yang bisa dibuka perangkat lain di jaringan. */
  urls: string[];
  /** Galat terakhir (mis. port sudah dipakai). */
  error?: string;
  /** True bila sandi belum dibuat sehingga akses jaringan tak bisa menyala. */
  passwordRequired: boolean;
}

/** Galat jaringan dengan jenis yang bisa dipetakan ke status HTTP. */
export class NetworkError extends Error {
  readonly code: "sandi-kurang" | "auth-tak-aktif" | "port-tak-sah" | "bind-gagal";

  constructor(code: NetworkError["code"], message: string) {
    super(message);
    this.name = "NetworkError";
    this.code = code;
  }
}

/** Satu antarmuka jaringan (bagian dari `os.networkInterfaces()`). */
export interface NetworkInterfaceEntry {
  address: string;
  family: string | number;
  internal: boolean;
}

/** Peladen yang dibuat manajer; cukup yang dipakai jaringan. */
export interface NetworkListener {
  requestIP?(request: Request): { address: string } | null;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

/** Fungsi pembuatan listener (disuntikkan supaya tes tak membuka port). */
export type NetworkServe = (options: {
  hostname: string;
  port: number;
  fetch: (request: Request, server: SocketLike | undefined) => Response | Promise<Response>;
}) => NetworkListener;

/** Dependensi manajer jaringan. */
export interface NetworkManagerDeps {
  /** Fungsi yang benar-benar membuka port. */
  serve: NetworkServe;
  /** Daftar antarmuka jaringan; dipakai menyusun daftar URL. */
  networkInterfaces: () => NetworkInterfaceEntry[];
  /** Penyimpanan sandi; syarat listener jaringan boleh menyala. */
  passwordStore: PasswordStore;
  /** Penyimpanan pengaturan jaringan. */
  store: NetworkStore;
  /** Penangan permintaan aplikasi Jejak. */
  handle: (request: Request) => Response | Promise<Response>;
  /** Penyimpanan log audit. */
  audit?: AuditStore;
  /**
   * True bila aplikasi sudah memakai autentikasi (penjaga cookie). Listener
   * jaringan hanya boleh hidup kalau `/api/` dijaga cookie; default `true`.
   */
  authActive?: () => boolean;
}

/** Terjemahkan galat bind menjadi pesan berbahasa Indonesia. */
export function describeBindError(error: unknown, port: number): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const kode = typeof code === "string" ? code.toUpperCase() : "";
  if (kode === "EADDRINUSE" || raw.includes("EADDRINUSE") || raw.includes("already in use")) {
    return `Port ${port} sudah dipakai proses lain.`;
  }
  if (kode === "EACCES" || raw.includes("EACCES") || raw.includes("permission denied")) {
    return `Port ${port} tak boleh dipakai proses ini.`;
  }
  return `Gagal membuka port ${port}: ${raw}`;
}

/** True bila antarmuka ini punya alamat IPv4 yang bisa dipakai. */
function isUsableIpv4(entry: NetworkInterfaceEntry): boolean {
  if (entry.internal) return false;
  const family = entry.family;
  const ipv4 = family === "IPv4" || family === 4;
  if (!ipv4) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(entry.address);
}

/**
 * Manajer akses dari jaringan.
 *
 * Menyimpan pengaturan, membuka listener kedua (hostname `0.0.0.0`) saat
 * pengguna mengizinkan, dan menutupnya lagi. Listener utama tak tersentuh:
 * ia tetap loopback.
 */
export class NetworkManager {
  private readonly deps: NetworkManagerDeps;
  private settings: NetworkSettings;
  private listener: NetworkListener | undefined;
  private error: string | undefined;

  constructor(deps: NetworkManagerDeps) {
    this.deps = deps;
    this.settings = deps.store.load();
  }

  /** Status saat ini; aman dipanggil tanpa awaited. */
  status(): NetworkStatus {
    const listening = this.listener !== undefined;
    return {
      enabled: this.settings.enabled,
      port: this.settings.port,
      listening,
      urls: listening ? this.urls() : [],
      ...(this.error === undefined ? {} : { error: this.error }),
      passwordRequired: !this.deps.passwordStore.has(),
    };
  }

  /** Alamat yang bisa dibuka perangkat lain; urut stabil. */
  urls(): string[] {
    const port = this.settings.port;
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const entry of this.deps.networkInterfaces()) {
      if (!isUsableIpv4(entry)) continue;
      const url = `http://${entry.address}:${port}`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    return urls.sort();
  }

  /** Nyalakan akses dari jaringan; butuh sandi tersimpan. */
  async enable(port?: number): Promise<NetworkStatus> {
    if (!this.deps.passwordStore.has()) {
      throw new NetworkError("sandi-kurang", "Buat sandi dulu.");
    }
    // Listener jaringan hanya boleh hidup di belakang penjaga autentikasi.
    if ((this.deps.authActive?.() ?? true) !== true) {
      throw new NetworkError(
        "auth-tak-aktif",
        "Sandi belum dipakai server. Mulai ulang Jejak agar sandi aktif.",
      );
    }
    const target = port ?? this.settings.port;
    if (!isValidNetworkPort(target)) {
      throw new NetworkError(
        "port-tak-sah",
        `Port harus antara ${MIN_NETWORK_PORT} dan ${MAX_NETWORK_PORT}.`,
      );
    }

    try {
      await this.listen(target);
    } catch (error) {
      const message = describeBindError(error, target);
      this.error = message;
      this.listener = undefined;
      // Gagal bind tak boleh menyalakan akses jaringan.
      this.settings = { ...this.settings, enabled: false, port: target };
      this.deps.store.save(this.settings);
      throw new NetworkError("bind-gagal", message);
    }

    this.error = undefined;
    this.settings = {
      version: NETWORK_STORE_VERSION,
      enabled: true,
      port: target,
    };
    this.deps.store.save(this.settings);
    return this.status();
  }

  /** Matikan akses dari jaringan dan tutup listener. */
  async disable(): Promise<NetworkStatus> {
    await this.stopListener();
    this.error = undefined;
    this.settings = { ...this.settings, enabled: false };
    this.deps.store.save(this.settings);
    return this.status();
  }

  /** Dipanggil saat sandi dihapus: listener ditutup, akses dimatikan. */
  async onPasswordCleared(): Promise<void> {
    await this.stopListener();
    this.error = undefined;
    this.settings = { ...this.settings, enabled: false };
    this.deps.store.save(this.settings);
  }

  /**
   * Dipanggil saat server mulai. Bila akses sebelumnya diizinkan dan sandi
   * masih ada, listener dinyalakan lagi. Gagal bind tak menjatuhkan server:
   * galat dicatat di status.
   */
  async start(): Promise<void> {
    const settings = this.deps.store.load();
    this.settings = settings;
    if (!settings.enabled) return;

    if (!this.deps.passwordStore.has()) {
      // Sandi dihapus sejak server terakhir hidup: jangan nyalakan.
      this.settings = { ...settings, enabled: false };
      this.deps.store.save(this.settings);
      return;
    }

    if ((this.deps.authActive?.() ?? true) !== true) {
      // Server belum memakai sandi: `/api/` tak dijaga cookie. Jangan nyalakan;
      // pengaturan tetap "diizinkan" supaya aktif setelah server dimulai ulang.
      this.error =
        "Sandi belum dipakai server. Mulai ulang Jejak agar sandi aktif.";
      return;
    }

    try {
      await this.listen(settings.port);
      this.error = undefined;
    } catch (error) {
      this.error = describeBindError(error, settings.port);
      // Pengaturan tetap "diizinkan" supaya percobaan.next diulang saat
      // server dinyalakan berikutnya.
      console.warn(`Akses dari jaringan tak bisa dinyalakan: ${this.error}`);
    }
  }

  /** Tutup listener (dipakai saat server berhenti). */
  async stop(): Promise<void> {
    await this.stopListener();
  }

  /** Buka listener jaringan pada port tertentu. */
  private async listen(port: number): Promise<void> {
    await this.stopListener();
    this.listener = this.deps.serve({
      hostname: NETWORK_HOSTNAME,
      port,
      fetch: networkFetch(this.deps.handle, (request, server) =>
        server?.requestIP?.(request)?.address,
      ),
    });
  }

  /** Tutup listener bila ada; aman dipanggil berkali-kali. */
  private async stopListener(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    if (listener === undefined) return;
    try {
      await listener.stop(true);
    } catch {
      // Penutupan tak boleh menggagalkan operasi lain.
    }
  }
}

/** Catatan audit untuk perubahan akses jaringan (tanpa data sensitif). */
export function recordNetworkAudit(
  audit: AuditStore | undefined,
  action: "jaringan-diaktifkan" | "jaringan-dimatikan",
  port: number,
): void {
  recordAudit(audit, {
    kind: "pengaturan",
    summary: `Jaringan: ${action}`,
    meta: { aksi: action, port },
  });
}

/** Port bawaan yang dipakai bila pengaturan belum pernah disimpan. */
export { DEFAULT_NETWORK_PORT };
