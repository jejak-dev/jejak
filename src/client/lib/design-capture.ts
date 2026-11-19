/**
 * Pelaksana permintaan tangkapan layar desain. Murni terhadap DOM dan
 * jaringan: penangkap dan pengunggah disuntikkan, jadi bisa diuji tanpa
 * peramban. Satu permintaan diproses paling banyak sekali dan kegagalan
 * selalu dilaporkan ke server sebagai alasan, bukan dilempar.
 */

import type { CaptureFailure, DesignCaptureRequest } from "./api";

/**
 * Hasil tangkapan. `width`/`height` adalah ukuran piksel gambar (bukan
 * ukuran perangkat); dipakai pengekspor PNG di kanvas.
 */
export type CaptureOutcome =
  | { dataUrl: string; width?: number; height?: number }
  | { error: CaptureFailure };

/** Menangkap satu halaman di kanvas; `requestId` dipakai sebagai id pesan. */
export type CaptureFn = (
  slug: string,
  scale: 1 | 2,
  requestId: string,
) => Promise<CaptureOutcome>;

/** Selang bawaan sebelum tangkapan dianggap gagal. */
export const CAPTURE_TIMEOUT_MS = 12000;
/** Batas tangkapan serentak; kelebihan menunggu giliran. */
export const MAX_PARALLEL_CAPTURES = 3;
/** Batas ingatan id yang sudah diproses. */
export const MAX_SEEN_CAPTURES = 200;

export interface CaptureRunnerOptions {
  /** Diambil saat permintaan diproses; undefined berarti kanvas tak terpasang. */
  capture: () => CaptureFn | undefined;
  /** Unggah hasil atau alasan gagal; galatnya ditelan. */
  upload: (requestId: string, body: CaptureOutcome) => Promise<void>;
  timeoutMs?: number;
  /** Timer yang bisa disuntikkan untuk tes. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CaptureRunner {
  /** Antrekan permintaan; tak menunggu dan tak pernah melempar. */
  handle(requests: DesignCaptureRequest[]): void;
}

const SYSTEM_SET_TIMER = (callback: () => void, ms: number): unknown =>
  globalThis.setTimeout(callback, ms);
const SYSTEM_CLEAR_TIMER = (handle: unknown): void =>
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);

export function createCaptureRunner(options: CaptureRunnerOptions): CaptureRunner {
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const setTimer = options.setTimer ?? SYSTEM_SET_TIMER;
  const clearTimer = options.clearTimer ?? SYSTEM_CLEAR_TIMER;

  // Urutan penyisipan dipakai membuang id tertua saat batas tercapai.
  const seen = new Set<string>();
  const antrean: DesignCaptureRequest[] = [];
  let berjalan = 0;

  const tandai = (id: string): void => {
    seen.add(id);
    if (seen.size <= MAX_SEEN_CAPTURES) return;
    const tertua = seen.values().next().value;
    if (tertua !== undefined) seen.delete(tertua);
  };

  const unggahAman = async (
    requestId: string,
    body: CaptureOutcome,
  ): Promise<void> => {
    try {
      // Server punya batas waktu sendiri; kegagalan unggah tak perlu ditindak.
      await options.upload(requestId, body);
    } catch {
      // Ditelan dengan sengaja.
    }
  };

  const tangkap = async (request: DesignCaptureRequest): Promise<void> => {
    const capture = options.capture();
    if (capture === undefined) {
      await unggahAman(request.id, { error: "no-frame" });
      return;
    }

    let selesai = false;
    let handle: unknown;
    const batas = new Promise<CaptureOutcome>((resolve) => {
      handle = setTimer(() => {
        if (selesai) return;
        selesai = true;
        resolve({ error: "failed" });
      }, timeoutMs);
    });
    const hasil = Promise.resolve()
      .then(() => capture(request.slug, request.scale, request.id))
      .catch((): CaptureOutcome => ({ error: "failed" }))
      .then((outcome): CaptureOutcome => (selesai ? { error: "failed" } : outcome));

    let outcome: CaptureOutcome;
    try {
      outcome = await Promise.race([hasil, batas]);
    } finally {
      selesai = true;
      clearTimer(handle);
    }
    await unggahAman(request.id, outcome);
  };

  const jalan = (): void => {
    while (berjalan < MAX_PARALLEL_CAPTURES && antrean.length > 0) {
      const request = antrean.shift();
      if (request === undefined) return;
      berjalan += 1;
      void tangkap(request).finally(() => {
        berjalan -= 1;
        jalan();
      });
    }
  };

  return {
    handle(requests) {
      for (const request of requests) {
        if (seen.has(request.id)) continue;
        tandai(request.id);
        antrean.push(request);
      }
      jalan();
    },
  };
}
