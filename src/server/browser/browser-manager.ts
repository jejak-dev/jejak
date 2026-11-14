import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserError } from "./browser-error";
import { locateChrome, type ChromeExists } from "./chrome-locator";
import { CdpClient, type CdpConnection } from "./cdp-client";
import { jejakHome } from "../provider-store";

export { BrowserError } from "./browser-error";
export type { BrowserErrorCode } from "./browser-error";

/** Status browser yang terlihat pengguna. */
export type BrowserStatus = "mati" | "menyala";

export interface BrowserState {
  status: BrowserStatus;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Satu frame screencast (JPEG base64). */
export interface BrowserFrame {
  /** Isi JPEG dalam base64 (tanpa prefiks data URL). */
  data: string;
  width: number;
  height: number;
  ts: number;
}

/** Pendengar frame screencast. */
export type BrowserFrameListener = (frame: BrowserFrame) => void;

/** Proses Chrome yang dijalankan Jejak (bisa dipalsukan pada tes). */
export interface BrowserProcess {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
  exited: Promise<number>;
}

/** Isi berkas `DevToolsActivePort`: port dan jalur WebSocket. */
export interface DevToolsEndpoint {
  port: number;
  path: string;
}

export interface BrowserManagerOptions {
  /** Env; dipakai `JEJAK_CHROME_PATH` dan `JEJAK_HOME`. */
  env?: Record<string, string | undefined>;
  /** Platform untuk Pencarian Chrome; bawaan `process.platform`. */
  platform?: NodeJS.Platform;
  /** Pemeriksa keberadaan berkas; diinjeksi supaya bisa diuji. */
  exists?: ChromeExists;
  /** Peluncur proses Chrome; diinjeksi supaya bisa diuji. */
  spawn?: (command: string, args: string[]) => BrowserProcess;
  /** Penghubung CDP; diinjeksi supaya bisa diuji. */
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  /** Pembaca port DevTools dari profil; diinjeksi supaya bisa diuji. */
  readDevToolsPort?: (profileDir: string) => DevToolsEndpoint | undefined;
  /** Sumber waktu (ms); diinjeksi supaya bisa diuji. */
  now?: () => number;
  /** Penjadwac tunda; diinjeksi supaya detak bisa dipicu manual pada tes. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Lamanya halaman diam (ms) sebelum diambil screenshot lagi; bawaan 2 detik. */
  idleScreenshotMs?: number;
  /** Batas menunggu port DevTools (ms); bawaan 10 detik. */
  portTimeoutMs?: number;
  /** Batas menunggu proses Chrome keluar (ms); bawaan 3 detik. */
  closeTimeoutMs?: number;
}

const DEFAULT_PORT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const PORT_POLL_MS = 100;
const DEFAULT_IDLE_SCREENSHOT_MS = 2_000;
const SCREENSHOT_QUALITY = 60;

/** Skema yang boleh dipakai untuk navigasi. */
const ALLOWED_SCHEMES = new Set(["http", "https"]);

/** Host yang dianggap lokal (dipakai `http://`, bukan `https://`). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function invalid(message: string): BrowserError {
  return new BrowserError(message, "tidak-valid");
}

/** Nama host dari masukan tanpa skema (tanpa port). */
function hostNameOf(raw: string): string | undefined {
  let host = raw;
  const cut = host.search(/[/?#]/);
  if (cut >= 0) host = host.slice(0, cut);
  if (host === "") return undefined;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return undefined;
    return host.slice(0, end + 1).toLowerCase();
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    const port = host.slice(colon + 1);
    if (!/^\d+$/.test(port)) return undefined;
    host = host.slice(0, colon);
  }
  if (host === "") return undefined;
  return host.toLowerCase();
}

/** Apakah masukan tanpa skema terlihat seperti nama host? */
function looksLikeHost(raw: string): boolean {
  const host = hostNameOf(raw);
  if (host === undefined) return false;
  if (host.startsWith("[")) return host.endsWith("]");
  return /^[a-z0-9][a-z0-9.-]*$/.test(host);
}

/**
 * Normalisasi URL navigasi (fungsi murni).
 *
 * Hanya `http:`, `https:`, dan persis `about:blank` yang diterima.
 * Masukan tanpa skema yang terlihat seperti host mendapat `http://` untuk host
 * lokal dan `https://` untuk host lain.
 */
export function normalizeBrowserUrl(input: unknown): string {
  if (typeof input !== "string") throw invalid("URL harus berupa teks.");
  const raw = input.trim();
  if (raw === "") throw invalid("URL tidak boleh kosong.");
  if (raw === "about:blank") return raw;

  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
    return parsed.toString();
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (schemeMatch !== null) {
    const name = (schemeMatch[1] ?? "").toLowerCase();
    const rest = raw.slice(schemeMatch[0].length);
    // "localhost:3000" dan "host:8080" adalah host+port, bukan skema.
    if (!/^\d+(\/|$|\?|#)/.test(rest)) {
      if (!ALLOWED_SCHEMES.has(name)) {
        throw invalid(`Skema "${name}:" tidak diizinkan. Gunakan http: atau https:.`);
      }
      if (!rest.startsWith("//")) {
        throw invalid("URL harus diawali http:// atau https://.");
      }
      const parsed = new URL(raw);
      if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
      return parsed.toString();
    }
  }

  if (!looksLikeHost(raw)) {
    throw invalid("URL harus berupa alamat http/https, misalnya https://example.com.");
  }
  const host = hostNameOf(raw) ?? "";
  const schemePrefix = LOCAL_HOSTS.has(host) ? "http" : "https";
  const parsed = new URL(`${schemePrefix}://${raw}`);
  if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
  return parsed.toString();
}

/** Baca port dan jalur WebSocket dari berkas `DevToolsActivePort`. */
export function readDevToolsPortFile(profileDir: string): DevToolsEndpoint | undefined {
  try {
    const content = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
    const lines = content.split("\n");
    const port = Number.parseInt((lines[0] ?? "").trim(), 10);
    const path = (lines[1] ?? "").trim();
    if (!Number.isInteger(port) || port <= 0 || path === "") return undefined;
    return { port, path };
  } catch {
    return undefined;
  }
}

/** Argumen Chrome untuk profil terpisah milik Jejak. */
export function chromeArgs(profileDir: string): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--window-size=1280,800",
    "about:blank",
  ];
}

interface Subscriber {
  listener: BrowserFrameListener;
  busy: boolean;
  pending?: BrowserFrame;
}

/**
 * Manajer browser: satu Chromium per proses Jejak, satu tab halaman utama,
 * dan screencast untuk panel.
 */
export class BrowserManager {
  private readonly env: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly exists: ChromeExists;
  private readonly spawn: (command: string, args: string[]) => BrowserProcess;
  private readonly connect: (wsUrl: string) => Promise<CdpConnection>;
  private readonly readPort: (profileDir: string) => DevToolsEndpoint | undefined;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly idleScreenshotMs: number;
  private readonly portTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  private client: CdpConnection | undefined;
  private process: BrowserProcess | undefined;
  private sessionId: string | undefined;
  private targetId: string | undefined;
  private url = "";
  private title = "";
  private lastFrame: BrowserFrame | undefined;
  private screencastOn = false;
  /** Waktu frame terakhir yang diterima (ms); undefined bila belum ada. */
  private lastFrameAt: number | undefined;
  /** True saat permintaan screenshot sedang berjalan. */
  private capturePending = false;
  /** Pembatal detak pengaman; undefined bila detak tidak dijadwalkan. */
  private cancelTick: (() => void) | undefined;
  private readonly subscribers = new Set<Subscriber>();

  constructor(options: BrowserManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.exists = options.exists ?? existsSync;
    this.spawn =
      options.spawn ??
      ((command, args) =>
        Bun.spawn([command, ...args], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }));
    this.connect = options.connect ?? ((wsUrl) => CdpClient.connect(wsUrl));
    this.readPort = options.readDevToolsPort ?? readDevToolsPortFile;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        (timer as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
      });
    this.idleScreenshotMs = options.idleScreenshotMs ?? DEFAULT_IDLE_SCREENSHOT_MS;
    this.portTimeoutMs = options.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  /** PID proses Chrome yang sedang berjalan (undefined bila belum ada). */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** Keadaan browser sekarang; tidak pernah Repliesan Chrome. */
  state(): BrowserState {    return {
      status: this.client !== undefined ? "menyala" : "mati",
      url: this.url,
      title: this.title,
      canGoBack: false,
      canGoForward: false,
    };
  }

  /** Pastikan Chrome berjalan; luncurkan bila belum. */
  async ensure(): Promise<void> {
    if (this.client !== undefined) return;
    await this.start();
  }

  private async start(): Promise<void> {
    const command = locateChrome(this.env, this.platform, this.exists);
    if (command === undefined) {
      throw new BrowserError(
        "Chrome atau Chromium tidak ditemukan. Pasang Google Chrome atau set JEJAK_CHROME_PATH.",
        "tidak-ditemukan",
      );
    }
    const profileDir = join(jejakHome(this.env), "browser-profile");
    try {
      mkdirSync(profileDir, { recursive: true });
    } catch {
      throw new BrowserError("Folder profil browser tidak dapat dibuat.", "gagal");
    }

    let proc: BrowserProcess;
    try {
      proc = this.spawn(command, chromeArgs(profileDir));
    } catch {
      throw new BrowserError("Chrome tidak dapat dijalankan.", "gagal");
    }
    this.process = proc;
    void proc.exited
      .then(() => this.handleExit())
      .catch(() => this.handleExit());

    const endpoint = await this.waitForPort(profileDir);
    if (endpoint === undefined) {
      await this.terminate(proc);
      this.process = undefined;
      throw new BrowserError("Browser tidak siap; port DevTools tak terbaca.", "gagal");
    }

    let client: CdpConnection;
    try {
      // URL CDP hanya dipakai di dalam proses ini; tak pernah ke log atau klien.
      client = await this.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
    } catch {
      await this.terminate(proc);
      this.process = undefined;
      throw new BrowserError("Gagal terhubung ke browser.", "gagal");
    }
    this.client = client;
    try {
      await this.attach(client);
    } catch (error) {
      this.client = undefined;
      await this.terminate(proc);
      this.process = undefined;
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("Browser tidak dapat disiapkan.", "gagal");
    }
  }

  private async waitForPort(profileDir: string): Promise<DevToolsEndpoint | undefined> {
    const deadline = Date.now() + this.portTimeoutMs;
    while (Date.now() < deadline) {
      const endpoint = this.readPort(profileDir);
      if (endpoint !== undefined) return endpoint;
      await Bun.sleep(PORT_POLL_MS);
    }
    return undefined;
  }

  /** Pasang sesi CDP pada tab halaman utama. */
  private async attach(client: CdpConnection): Promise<void> {
    const targets = (await client.send("Target.getTargets")) as
      | { targetInfos?: Array<{ targetId?: string; type?: string }> }
      | undefined;
    const infos = targets?.targetInfos ?? [];
    const page = infos.find((info) => info.type === "page" && typeof info.targetId === "string");
    let targetId = page?.targetId;
    if (targetId === undefined) {
      const created = (await client.send("Target.createTarget", { url: "about:blank" })) as
        | { targetId?: string }
        | undefined;
      targetId = created?.targetId;
    }
    if (targetId === undefined) {
      throw new BrowserError("Tab halaman utama tidak ditemukan.", "gagal");
    }
    const attached = (await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string } | undefined;
    const sessionId = attached?.sessionId;
    if (sessionId === undefined) {
      throw new BrowserError("Sesi browser tidak dapat dipasang.", "gagal");
    }
    this.targetId = targetId;
    this.sessionId = sessionId;
    await client.send("Page.enable", undefined, sessionId);
    client.on(
      "Page.frameNavigated",
      (params) => {
        const frame = (params as { frame?: { url?: string } }).frame;
        const next = frame?.url;
        if (typeof next === "string") this.url = next;
      },
      sessionId,
    );
    client.on(
      "Page.loadEventFired",
      () => {
        void this.refreshInfo();
      },
      sessionId,
    );
    client.on(
      "Page.screencastFrame",
      (params) => {
        this.onFrame(
          params as {
            data?: string;
            sessionId?: number;
            metadata?: { deviceWidth?: number; deviceHeight?: number };
          },
        );
      },
      sessionId,
    );
    await this.refreshInfo();
  }

  /** Ambil URL dan judul tab terbaru (best effort). */
  private async refreshInfo(): Promise<void> {
    const client = this.client;
    const targetId = this.targetId;
    if (client === undefined || targetId === undefined) return;
    try {
      const result = (await client.send("Target.getTargetInfo", { targetId })) as
        | { targetInfo?: { url?: unknown; title?: unknown } }
        | undefined;
      const info = result?.targetInfo;
      if (info === undefined) return;
      if (typeof info.url === "string") this.url = info.url;
      if (typeof info.title === "string") this.title = info.title;
    } catch {
      // Info target bersifat tambahan; kegagalan tidak berwarna galat.
    }
  }

  /** Navigasi tab utama ke URL yang sudah dinormalisasi. */
  async navigate(input: unknown): Promise<BrowserState> {
    const url = normalizeBrowserUrl(input);
    await this.ensure();
    const client = this.client;
    const sessionId = this.sessionId;
    if (client === undefined || sessionId === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    try {
      await client.send("Page.navigate", { url }, sessionId);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "mati") {
        this.client = undefined;
      }
      throw error;
    }
    this.url = url;
    await this.refreshInfo();
    // URL yang diminta tampil lebih dulu; info target bisa tertinggal.
    this.url = url;
    return this.state();
  }

  /**
   * Dengarkan frame screencast. Screencast mulai saat pelanggan pertama dan
   * berhenti saat pelanggan terakhir pergi. Frame terakhir tersimpan dan
   * dikirim ke pelanggan baru.
   */
  subscribe(listener: BrowserFrameListener): () => void {
    const subscriber: Subscriber = { listener, busy: false };
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) void this.startScreencast();
    const last = this.lastFrame;
    if (last !== undefined) this.deliver(subscriber, last);
    return () => {
      if (!this.subscribers.delete(subscriber)) return;
      subscriber.pending = undefined;
      if (this.subscribers.size === 0) void this.stopScreencast();
    };
  }

  private async startScreencast(): Promise<void> {
    const client = this.client;
    const sessionId = this.sessionId;
    if (client === undefined || sessionId === undefined || this.screencastOn) return;
    try {
      await client.send(
        "Page.startScreencast",
        { format: "jpeg", quality: SCREENSHOT_QUALITY, maxWidth: 1280 },
        sessionId,
      );
      this.screencastOn = true;
    } catch {
      // Tanpa screencast, panel hanya menampilkan pesan "menunggu frame".
    }
    this.lastFrameAt = this.now();
    // Benih: screencast tak selalu mengirim frame untuk halaman statis.
    await this.captureScreenshot();
    this.scheduleTick();
  }

  private async stopScreencast(): Promise<void> {
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.lastFrameAt = undefined;
    const client = this.client;
    const sessionId = this.sessionId;
    if (client === undefined || sessionId === undefined || !this.screencastOn) {
      this.screencastOn = false;
      return;
    }
    this.screencastOn = false;
    try {
      await client.send("Page.stopScreencast", undefined, sessionId);
    } catch {
      // Browser mungkin sudah tertutup.
    }
  }

  /**
   * Ambil satu frame lewat `Page.captureScreenshot` lalu salurkan sebagai frame.
   *
   * Best effort: kegagalan diabaikan agar panel tak terkunci.
   */
  private async captureScreenshot(): Promise<void> {
    if (this.capturePending) return;
    const client = this.client;
    const sessionId = this.sessionId;
    if (client === undefined || sessionId === undefined) return;
    this.capturePending = true;
    try {
      const result = (await client.send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: SCREENSHOT_QUALITY },
        sessionId,
      )) as { data?: string } | undefined;
      const data = result?.data;
      if (typeof data !== "string" || data === "") return;
      const size = await this.viewportSize();
      this.emitFrame({ data, width: size.width, height: size.height, ts: this.now() });
    } catch {
      // Pengambilan yang gagal tak boleh menghentikan screencast.
    } finally {
      this.capturePending = false;
    }
  }

  /** Ukuran area tampilan dari metrik layout halaman. */
  private async viewportSize(): Promise<{ width: number; height: number }> {
    const client = this.client;
    const sessionId = this.sessionId;
    if (client === undefined || sessionId === undefined) return { width: 0, height: 0 };
    try {
      const metrics = (await client.send("Page.getLayoutMetrics", undefined, sessionId)) as
        | {
            cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
            cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
            layoutViewport?: { clientWidth?: number; clientHeight?: number };
          }
        | undefined;
      const view =
        metrics?.cssLayoutViewport ?? metrics?.cssVisualViewport ?? metrics?.layoutViewport;
      return {
        width: view?.clientWidth ?? 0,
        height: view?.clientHeight ?? 0,
      };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  /** Jadwalkan detak pengaman: screenshot lagi bila halaman lama diam. */
  private scheduleTick(delayMs?: number): void {
    if (this.subscribers.size === 0) return;
    const last = this.lastFrameAt;
    const delay =
      delayMs ??
      (last === undefined
        ? this.idleScreenshotMs
        : Math.max(0, this.idleScreenshotMs - (this.now() - last)));
    this.cancelTick = this.schedule(() => this.handleTick(), delay);
  }

  /** Detak pengaman: kirim frame baru saat tak ada frame screencast terbaru. */
  private handleTick(): void {
    this.cancelTick = undefined;
    if (this.subscribers.size === 0) return;
    if (this.capturePending) {
      // Permintaan sebelumnya belum selesai; jangan menumpuk.
      this.scheduleTick(this.idleScreenshotMs);
      return;
    }
    const last = this.lastFrameAt;
    if (last !== undefined && this.now() - last < this.idleScreenshotMs) {
      this.scheduleTick();
      return;
    }
    void this.captureScreenshot().then(() => this.scheduleTick());
  }

  private onFrame(params: {
    data?: string;
    sessionId?: number;
    metadata?: { deviceWidth?: number; deviceHeight?: number };
  }): void {
    const client = this.client;
    const sessionId = this.sessionId;
    if (client !== undefined && sessionId !== undefined) {
      const ack = params.sessionId === undefined ? {} : { sessionId: params.sessionId };
      void client
        .send("Page.screencastFrameAck", ack, sessionId)
        .catch(() => undefined);
    }
    if (typeof params.data !== "string" || params.data === "") return;
    this.emitFrame({
      data: params.data,
      width: params.metadata?.deviceWidth ?? 0,
      height: params.metadata?.deviceHeight ?? 0,
      ts: this.now(),
    });
  }

  /** Simpan frame terakhir lalu kirim ke semua pelanggan. */
  private emitFrame(frame: BrowserFrame): void {
    this.lastFrame = frame;
    this.lastFrameAt = frame.ts;
    for (const subscriber of this.subscribers) this.deliver(subscriber, frame);
  }

  /** Kirim frame; bila pelanggan lambat, hanya frame terbaru yang ditahan. */
  private deliver(subscriber: Subscriber, frame: BrowserFrame): void {
    if (subscriber.busy) {
      subscriber.pending = frame;
      return;
    }
    subscriber.busy = true;
    void (async () => {
      try {
        await subscriber.listener(frame);
      } catch {
        // Pelanggan yang rusak tidak boleh menghentikan screencast.
      }
      subscriber.busy = false;
      const next = subscriber.pending;
      subscriber.pending = undefined;
      if (next !== undefined) this.deliver(subscriber, next);
    })();
  }

  /** Tutup browser: hentikan screencast, tutup soket, lalu bunuh Chrome. */
  async close(): Promise<void> {
    await this.stopScreencast();
    this.subscribers.clear();
    this.lastFrame = undefined;
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.targetId = undefined;
    this.url = "";
    this.title = "";
    if (client !== undefined) {
      try {
        client.close();
      } catch {
        // Soket sudah tertutup.
      }
    }
    const proc = this.process;
    this.process = undefined;
    if (proc !== undefined) await this.terminate(proc);
  }

  /** Bunuh proses Chrome; tunggu keluar, lalu paksa. */
  private async terminate(proc: BrowserProcess): Promise<void> {
    try {
      proc.kill();
    } catch {
      // Proses sudah berhenti.
    }
    const exited = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      Bun.sleep(this.closeTimeoutMs).then(() => false),
    ]);
    if (exited) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Proses sudah berhenti.
    }
  }

  /** Chrome berhenti sendiri; state kembali "mati" supaya bisa diyalakan ulang. */
  private handleExit(): void {
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.targetId = undefined;
    this.screencastOn = false;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.lastFrameAt = undefined;
    if (client !== undefined) {
      try {
        client.close();
      } catch {
        // Soket sudah tertutup.
      }
    }
  }
}
