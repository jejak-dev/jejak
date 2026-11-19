import { randomBytes } from "node:crypto";

export type CaptureFailure = "tainted" | "too-large" | "failed" | "no-frame";

/** Galat permintaan tangkapan layar; pesannya aman ditampilkan ke agent. */
export class CaptureError extends Error {
  constructor(
    message: string,
    readonly reason: CaptureFailure | "timeout" | "no-viewer",
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface PendingCapture {
  id: string;
  slug: string;
  scale: 1 | 2;
}

export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
}

const MSG_NO_VIEWER = "Buka kanvas desain di Jejak agar tangkapan layar tersedia.";
const MSG_BUSY = "Terlalu banyak tangkapan layar tertunda.";
const MSG_INVALID = "Gambar tangkapan tidak valid.";

const MSG_FAILURE: Record<CaptureFailure, string> = {
  tainted: "Browser ini tidak mengizinkan tangkapan layar frame desain.",
  "too-large": "Halaman terlalu besar untuk ditangkap.",
  "no-frame": "Frame halaman belum tampil di kanvas.",
  failed: "Tangkapan layar gagal.",
};

/** Pesan id tak dikenal; rute memetakannya ke 404. */
export const NOT_FOUND = "Permintaan tidak ditemukan.";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MIN_PNG_BYTES = 33;
const MAX_SIDE = 8192;
const MAX_PER_SESSION = 3;
const MAX_GLOBAL = 20;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_VIEWER_TTL_MS = 5000;

interface PendingEntry {
  info: PendingCapture;
  resolve: (result: CaptureResult) => void;
  reject: (error: CaptureError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Membaca dimensi dari IHDR PNG; undefined bila gambar tidak valid. */
function readPng(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < MIN_PNG_BYTES || png.length > MAX_PNG_BYTES) return undefined;
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  // Byte 8..11 panjang chunk IHDR, 12..15 tipe "IHDR", 16..23 lebar/tinggi.
  if (png.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE) return undefined;
  return { width, height };
}

/**
 * Perantara permintaan tangkapan layar: agent meminta, klien (yang mem-poll
 * stamp) menangkap lalu mengunggah PNG. Isi PNG tak pernah masuk pesan galat.
 */
export class CaptureBroker {
  private readonly timeoutMs: number;
  private readonly viewerTtlMs: number;
  private readonly now: () => number;
  private readonly viewers = new Map<string, number>();
  private readonly sessions = new Map<string, Map<string, PendingEntry>>();

  constructor(options: {
    timeoutMs?: number;
    viewerTtlMs?: number;
    now?: () => number;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.viewerTtlMs = options.viewerTtlMs ?? DEFAULT_VIEWER_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Klien menandai ada penonton kanvas; dipanggil tiap polling stamp. */
  touch(sessionId: string): void {
    this.viewers.set(sessionId, this.now());
  }

  request(sessionId: string, slug: string, scale: 1 | 2): Promise<CaptureResult> {
    const touched = this.viewers.get(sessionId);
    if (touched === undefined || this.now() - touched > this.viewerTtlMs) {
      return Promise.reject(new CaptureError(MSG_NO_VIEWER, "no-viewer"));
    }
    if (this.totalPending() >= MAX_GLOBAL) {
      return Promise.reject(new CaptureError(MSG_BUSY, "failed"));
    }
    const entries = this.entriesFor(sessionId);
    if (entries.size >= MAX_PER_SESSION) {
      return Promise.reject(new CaptureError(MSG_BUSY, "failed"));
    }

    const id = `k_${randomBytes(8).toString("hex")}`;
    return new Promise<CaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        entries.delete(id);
        reject(new CaptureError(MSG_NO_VIEWER, "timeout"));
      }, this.timeoutMs);
      // Timer tak boleh menahan proses.
      (timer as unknown as { unref?: () => void }).unref?.();
      entries.set(id, { info: { id, slug, scale }, resolve, reject, timer });
    });
  }

  pending(sessionId: string): PendingCapture[] {
    const entries = this.sessions.get(sessionId);
    if (entries === undefined) return [];
    return [...entries.values()].map((entry) => ({ ...entry.info }));
  }

  /** Dipanggil klien dengan PNG hasil tangkapan; dimensi dibaca dari IHDR. */
  complete(sessionId: string, id: string, png: Buffer): CaptureResult {
    const entry = this.take(sessionId, id);
    if (entry === undefined) throw new CaptureError(NOT_FOUND, "failed");
    const size = readPng(png);
    if (size === undefined) {
      const error = new CaptureError(MSG_INVALID, "failed");
      entry.reject(error);
      throw error;
    }
    const result: CaptureResult = { png, width: size.width, height: size.height };
    entry.resolve(result);
    return result;
  }

  /** Klien melaporkan kegagalan tangkapan; false bila id tak dikenal. */
  fail(sessionId: string, id: string, reason: CaptureFailure): boolean {
    const entry = this.take(sessionId, id);
    if (entry === undefined) return false;
    entry.reject(new CaptureError(MSG_FAILURE[reason], reason));
    return true;
  }

  /** Ambil entri tertunda dan bersihkan timernya. */
  private take(sessionId: string, id: string): PendingEntry | undefined {
    const entries = this.sessions.get(sessionId);
    const entry = entries?.get(id);
    if (entry === undefined) return undefined;
    entries?.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  private entriesFor(sessionId: string): Map<string, PendingEntry> {
    let entries = this.sessions.get(sessionId);
    if (entries === undefined) {
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    return entries;
  }

  private totalPending(): number {
    let total = 0;
    for (const entries of this.sessions.values()) total += entries.size;
    return total;
  }
}
