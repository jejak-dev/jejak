import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient, DesignResult } from "./api";
import { shouldRefetch } from "./design-ui";

/** Selang polling cap perubahan folder `design/`. */
export const DESIGN_POLL_MS = 1500;

/** Penanganan timer yang bisa disuntikkan supaya pengatur bisa diuji murni. */
export interface DesignTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYSTEM_TIMERS: DesignTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface DesignPollerOptions {
  /** Ambil model desain penuh. */
  load: () => Promise<DesignResult>;
  /** Ambil cap perubahan folder desain. */
  stamp: () => Promise<string>;
  /** Dipanggil setiap model desain baru berhasil dimuat. */
  onDesign: (design: DesignResult) => void;
  /** Dipanggil saat jaringan gagal; polling tetap jalan. */
  onError: (message: string) => void;
  intervalMs?: number;
  timers?: DesignTimers;
}

export interface DesignPoller {
  /** Muat sekali lalu mulai polling; true bila putaran baru dimulai. */
  start(): boolean;
  /** Hentikan timer; hasil yang datang setelahnya diabaikan. */
  stop(): void;
  /** Muat ulang penuh (tombol Segarkan). */
  refresh(): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "desain tidak dapat dimuat";
}

/**
 * Pengatur polling desain. Murni terhadap DOM: timer disuntikkan, jadi bisa
 * diuji tanpa peramban. Satu putaran dilewati bila putaran sebelumnya belum
 * selesai, dan `stop` menaikkan generasi sehingga hasil lama tidak dipakai.
 */
export function createDesignPoller(options: DesignPollerOptions): DesignPoller {
  const intervalMs = options.intervalMs ?? DESIGN_POLL_MS;
  const timers = options.timers ?? SYSTEM_TIMERS;
  let handle: unknown;
  let running = false;
  let busy = false;
  let stamp: string | undefined;
  let generation = 0;

  const loadInto = async (gen: number): Promise<boolean> => {
    try {
      const design = await options.load();
      if (gen !== generation) return false;
      options.onDesign(design);
      return true;
    } catch (error) {
      if (gen !== generation) return false;
      options.onError(messageOf(error));
      return false;
    }
  };

  const poll = async (): Promise<void> => {
    if (!running || busy) return;
    busy = true;
    const gen = generation;
    try {
      const next = await options.stamp();
      if (gen !== generation) return;
      if (!shouldRefetch(stamp, next)) return;
      if (await loadInto(gen)) stamp = next;
    } catch (error) {
      if (gen !== generation) return;
      options.onError(messageOf(error));
    } finally {
      busy = false;
    }
  };

  const refresh = async (): Promise<void> => {
    const gen = generation;
    try {
      const next = await options.stamp();
      if (gen !== generation) return;
      const design = await options.load();
      if (gen !== generation) return;
      stamp = next;
      options.onDesign(design);
    } catch (error) {
      if (gen !== generation) return;
      options.onError(messageOf(error));
    }
  };

  return {
    start() {
      if (running) return false;
      running = true;
      generation += 1;
      void refresh();
      handle = timers.setInterval(() => {
        void poll();
      }, intervalMs);
      return true;
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      busy = false;
    },
    refresh,
  };
}

export interface DesignState {
  design: DesignResult | undefined;
  loading: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
}

/**
 * Model desain satu sesi. Polling hanya berjalan saat tab aktif dan dokumen
 * terlihat; cap berubah memicu muat ulang penuh.
 */
export function useDesign(
  api: ApiClient,
  sessionId: string,
  repo: string | undefined,
  active: boolean,
): DesignState {
  const [design, setDesign] = useState<DesignResult | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const pollerRef = useRef<DesignPoller | undefined>(undefined);

  useEffect(() => {
    if (!active) return;

    const poller = createDesignPoller({
      load: () => api.getDesign(sessionId, repo),
      stamp: async () => (await api.getDesignStamp(sessionId, repo)).stamp,
      onDesign: (next) => {
        setDesign(next);
        setError(undefined);
        setLoading(false);
      },
      onError: (message) => {
        setError(message);
        setLoading(false);
      },
    });
    pollerRef.current = poller;

    const visible = (): boolean =>
      typeof document === "undefined" || document.visibilityState === "visible";
    const start = (): void => {
      if (!visible()) return;
      if (poller.start()) setLoading(true);
    };
    const stop = (): void => poller.stop();
    const onVisibility = (): void => {
      if (visible()) start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      pollerRef.current = undefined;
    };
  }, [api, sessionId, repo, active]);

  const refresh = useCallback(async (): Promise<void> => {
    const poller = pollerRef.current;
    if (poller !== undefined) {
      await poller.refresh();
      return;
    }
    try {
      const next = await api.getDesign(sessionId, repo);
      setDesign(next);
      setError(undefined);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [api, sessionId, repo]);

  return { design, loading, error, refresh };
}
