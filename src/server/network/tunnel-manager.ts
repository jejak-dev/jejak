import { existsSync } from "node:fs";
import type { PasswordStore } from "../auth/password-store";
import {
  isValidPublicHost,
  type NetworkSettings,
  type NetworkStore,
} from "./network-store";
import {
  isValidTunnelToken,
  type TunnelTokenStore,
} from "./token-store";

/** Nama biner Cloudflare Tunnel. */
export const CLOUDFLARED_BINARY = "cloudflared";
/** Jeda percobaan ulang berurutan (ms): 5 dtk, 15 dtk, 60 dtk. */
export const TUNNEL_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
/** Jumlah percobaan ulang berurutan sebelum menyerah. */
export const MAX_TUNNEL_RESTARTS = 3;
/** Variabel env yang diteruskan ke cloudflared (selain token). */
export const TUNNEL_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;
/** Panjang maksimum baris log terakhir yang disimpan. */
export const MAX_LAST_LINE = 200;

/** Status tunnel; aman dikirim ke klien (tanpa token). */
export interface TunnelStatus {
  /** True bila biner `cloudflared` ditemukan. */
  installed: boolean;
  /** True bila tunnel diizinkan menyala. */
  enabled: boolean;
  /** True bila proses cloudflared sedang berjalan. */
  running: boolean;
  /** Hostname publik tersimpan. */
  publicHost?: string;
  /** True bila token tersimpan ada (nilainya tak pernah dikirim). */
  hasToken: boolean;
  /** URL publik yang bisa dibuka. */
  url?: string;
  /** Galat terakhir (pesan Indonesia, tanpa token). */
  error?: string;
  /** Baris log terakhir yang sudah di-redact. */
  lastLine?: string;
}

/** Galat tunnel dengan kode yang bisa dipetakan ke status HTTP. */
export class TunnelError extends Error {
  readonly code:
    | "jaringan-mati"
    | "sandi-kurang"
    | "token-kurang"
    | "host-kurang"
    | "cloudflared-tak-ada"
    | "host-tak-sah"
    | "token-tak-sah";

  constructor(code: TunnelError["code"], message: string) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
  }
}

/** Proses anak cloudflared; cukup yang dipakai manajer. */
export interface TunnelProcess {
  /** Selesai saat proses keluar; nilainya kode keluar. */
  exited: Promise<number>;
  /** Daftarkan penerima baris log (stdout/stderr). */
  onLine?(listener: (line: string) => void): void;
  /** Hentikan proses. */
  kill(): void;
}

/** Pembuat proses anak (disuntikkan supaya tes tak menjalankan proses nyata). */
export type TunnelSpawn = (
  cmd: string[],
  env: Record<string, string>,
) => TunnelProcess;

/** Dependensi manajer tunnel. */
export interface TunnelManagerDeps {
  /** Pembuat proses cloudflared. */
  spawn: TunnelSpawn;
  /** Pencari biner di PATH; `undefined` bila tak ditemukan. */
  which: (name: string) => string | undefined;
  /** Penyimpanan pengaturan jaringan (host publik + saklar tunnel). */
  store: NetworkStore;
  /** Penyimpanan token tunnel (rahasia). */
  tokenStore: TunnelTokenStore;
  /** Penyimpanan sandi; tunnel hanya boleh menyala bila sandi ada. */
  passwordStore: PasswordStore;
  /** Status listener jaringan; tunnel hanya boleh menyala bila menyala. */
  network: { status(): { listening: boolean } };
  /** Penunda (disuntikkan supaya tes tak menunggu). */
  delay?: (ms: number) => Promise<void>;
}

/** Ganti nilai token pada teks dengan `***`. */
export function redactToken(text: string, token: string | undefined): string {
  if (token === undefined || token === "") return text;
  return text.split(token).join("***");
}

/** Potong baris log ke batas aman. */
function trimLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LAST_LINE ? trimmed.slice(0, MAX_LAST_LINE) : trimmed;
}

/** Baca aliran proses baris demi baris; kegagalan aliran diabaikan. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  emit: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emit(line);
    }
    if (buffer !== "") emit(buffer);
  } catch {
    // Aliran tertutup: tak ada lagi yang bisa dibaca.
  }
}

/** Pembuat proses cloudflared sungguhan (Bun.spawn). */
export function spawnCloudflared(
  cmd: string[],
  env: Record<string, string>,
): TunnelProcess {
  const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const listeners: Array<(line: string) => void> = [];
  const emit = (line: string): void => {
    if (line.trim() === "") return;
    for (const listener of listeners) listener(line);
  };
  void pumpLines(proc.stdout as ReadableStream<Uint8Array>, emit);
  void pumpLines(proc.stderr as ReadableStream<Uint8Array>, emit);
  return {
    exited: proc.exited,
    onLine(listener) {
      listeners.push(listener);
    },
    kill() {
      proc.kill();
    },
  };
}

/** Cari biner di PATH lalu di folder pemasangan Homebrew yang lazim. */
export function whichBinary(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const dirs = [
    ...(env.PATH ?? "").split(":").filter((dir) => dir !== ""),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Folder tak terbaca: lanjut ke kandidat berikutnya.
    }
  }
  return undefined;
}

/**
 * Manajer Cloudflare Tunnel.
 *
 * Menjalankan `cloudflared tunnel run` sebagai proses anak yang mengarah ke
 * listener jaringan. Token dikirim lewat env `TUNNEL_TOKEN` (bukan argv) dan
 * tak pernah dikembalikan ke klien, log, atau audit.
 */
export class TunnelManager {
  private readonly deps: TunnelManagerDeps;
  private settings: NetworkSettings;
  private process: TunnelProcess | undefined;
  private error: string | undefined;
  private lastLine: string | undefined;
  private restarts = 0;
  private stopping = false;

  constructor(deps: TunnelManagerDeps) {
    this.deps = deps;
    this.settings = deps.store.load();
  }

  /** Status saat ini; aman dikirim ke klien. */
  status(): TunnelStatus {
    const publicHost = this.settings.publicHost;
    return {
      installed: this.deps.which(CLOUDFLARED_BINARY) !== undefined,
      enabled: this.settings.tunnelEnabled === true,
      running: this.process !== undefined,
      ...(publicHost === undefined ? {} : { publicHost }),
      hasToken: this.deps.tokenStore.has(),
      ...(publicHost === undefined ? {} : { url: `https://${publicHost}` }),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.lastLine === undefined ? {} : { lastLine: this.lastLine }),
    };
  }

  /** Hostname publik tersimpan; dipakai penjaga Host/Origin. */
  publicHost(): string | undefined {
    return this.settings.publicHost;
  }

  /**
   * Nyalakan tunnel. Syarat: listener jaringan menyala, sandi ada, token ada,
   * host publik ada, dan biner `cloudflared` ditemukan.
   */
  async enable(input: { publicHost?: string; token?: string } = {}): Promise<TunnelStatus> {
    if (!this.deps.network.status().listening) {
      throw new TunnelError(
        "jaringan-mati",
        "Nyalakan akses dari jaringan dulu sebelum mengaktifkan tunnel.",
      );
    }
    if (!this.deps.passwordStore.has()) {
      throw new TunnelError("sandi-kurang", "Buat sandi dulu.");
    }

    const token = input.token !== undefined ? input.token : this.deps.tokenStore.get();
    if (token === undefined || token === "") {
      throw new TunnelError("token-kurang", "Token tunnel belum diisi.");
    }
    if (!isValidTunnelToken(token)) {
      throw new TunnelError(
        "token-tak-sah",
        "Token tunnel harus teks tanpa spasi atau baris baru.",
      );
    }

    const publicHost = input.publicHost !== undefined ? input.publicHost : this.settings.publicHost;
    if (publicHost === undefined || publicHost === "") {
      throw new TunnelError("host-kurang", "Hostname publik tunnel belum diisi.");
    }
    if (!isValidPublicHost(publicHost)) {
      throw new TunnelError(
        "host-tak-sah",
        "Hostname publik harus nama domain huruf kecil tanpa skema, port, atau wildcard.",
      );
    }

    if (this.deps.which(CLOUDFLARED_BINARY) === undefined) {
      throw new TunnelError(
        "cloudflared-tak-ada",
        "cloudflared tak ditemukan. Pasang Cloudflare Tunnel dulu.",
      );
    }

    if (input.token !== undefined) this.deps.tokenStore.set(token);
    // Gabung dengan berkas terbaru: field jaringan tak boleh hilang.
    this.settings = {
      ...this.deps.store.load(),
      publicHost,
      tunnelEnabled: true,
    };
    this.deps.store.save(this.settings);
    this.error = undefined;
    this.restarts = 0;
    this.stopping = false;
    this.launch(token);
    return this.status();
  }

  /** Matikan tunnel dan hentikan proses anak. */
  async disable(): Promise<TunnelStatus> {
    this.stopProcess();
    this.settings = { ...this.deps.store.load(), tunnelEnabled: false };
    this.deps.store.save(this.settings);
    this.error = undefined;
    return this.status();
  }

  /** Hapus token tersimpan (tunnel harus sudah dimatikan pemanggil). */
  clearToken(): void {
    this.deps.tokenStore.clear();
  }

  /**
   * Dipanggil saat server mulai: nyalakan lagi bila sebelumnya diizinkan dan
   * semua syarat lengkap. Kekurangan syarat dicatat di status, tak melempar.
   */
  async start(): Promise<void> {
    this.settings = this.deps.store.load();
    if (this.settings.tunnelEnabled !== true) return;
    try {
      await this.enable();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "tunnel tak bisa dinyalakan";
    }
  }

  /** Hentikan proses anak (dipakai saat server berhenti). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopProcess();
  }

  /** Jalankan proses cloudflared dan pasang penangan keluarnya. */
  private launch(token: string): void {
    this.stopProcess();
    // Env minimal: kunci provider dan rahasia lain milik Jejak tak diwariskan.
    const env: Record<string, string> = {};
    for (const key of TUNNEL_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Token lewat env, bukan argv: tak terlihat di daftar proses.
    env.TUNNEL_TOKEN = token;

    let proc: TunnelProcess;
    try {
      proc = this.deps.spawn(
        [CLOUDFLARED_BINARY, "tunnel", "--no-autoupdate", "run"],
        env,
      );
    } catch (error) {
      this.error = `Gagal menjalankan cloudflared: ${
        error instanceof Error ? error.message : "alasan tak diketahui"
      }`;
      return;
    }
    this.process = proc;
    proc.onLine?.((line) => {
      this.lastLine = trimLine(redactToken(line, token));
    });
    void proc.exited.then(
      () => this.onExit(proc),
      () => this.onExit(proc),
    );
  }

  /** Proses keluar sendiri: coba nyalakan ulang dengan backoff. */
  private onExit(proc: TunnelProcess): void {
    if (this.process !== proc) return;
    this.process = undefined;
    if (this.stopping || this.settings.tunnelEnabled !== true) return;

    if (this.restarts >= MAX_TUNNEL_RESTARTS) {
      this.error = "cloudflared berhenti berulang kali; tunnel dimatikan.";
      this.settings = { ...this.deps.store.load(), tunnelEnabled: false };
      this.deps.store.save(this.settings);
      return;
    }
    const delayMs = TUNNEL_BACKOFF_MS[this.restarts] ?? 60_000;
    this.restarts += 1;
    const wait = this.deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    void wait(delayMs).then(() => {
      if (this.stopping || this.settings.tunnelEnabled !== true) return;
      const token = this.deps.tokenStore.get();
      if (token === undefined) {
        this.error = "Token tunnel hilang; tunnel dimatikan.";
        this.settings = { ...this.deps.store.load(), tunnelEnabled: false };
        this.deps.store.save(this.settings);
        return;
      }
      this.launch(token);
    });
  }

  /** Hentikan proses anak tanpa memicu percobaan ulang. */
  private stopProcess(): void {
    const proc = this.process;
    this.process = undefined;
    if (proc === undefined) return;
    try {
      proc.kill();
    } catch {
      // Proses mungkin sudah mati; tak boleh menggagalkan operasi lain.
    }
  }
}
