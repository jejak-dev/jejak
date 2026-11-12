export interface ThrottleOptions {
  /** Sumber waktu (ms epoch); default `Date.now`. */
  now?: () => number;
  /** Jumlah kegagalan beruntun sebelum penundaan mulai; default 5. */
  maxFailures?: number;
  /** Batas atas penundaan; default 5 menit. */
  maxDelayMs?: number;
}

export type ThrottleCheck =
  | { blocked: false }
  | { blocked: true; retryAfterSec: number };

export interface Throttle {
  /** True bila kunci sedang ditunda. */
  check(key: string): ThrottleCheck;
  /** Catat satu kegagalan; menaikkan eskalasi. */
  fail(key: string): void;
  /** Reset counters setelah berhasil. */
  succeed(key: string): void;
}

interface Entry {
  failures: number;
  lastFailAt: number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_MAX_DELAY_MS = 300_000;

/**
 * Throttle login per kunci (alamat socket).
 * Setelah `maxFailures` kegagalan beruntun, penundaan 2^n detik (mulai 2 detik),
 * dibatasi `maxDelayMs`.
 */
export function createThrottle(options: ThrottleOptions = {}): Throttle {
  const now = options.now ?? (() => Date.now());
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const entries = new Map<string, Entry>();

  const delayFor = (failures: number): number => {
    const step = Math.min(20, Math.max(1, failures - maxFailures + 1));
    return Math.min(maxDelayMs, 2 ** step * 1000);
  };

  const prune = (): void => {
    if (entries.size < 1000) return;
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.lastFailAt + delayFor(entry.failures) <= time) entries.delete(key);
    }
  };

  return {
    check(key: string): ThrottleCheck {
      const entry = entries.get(key);
      if (entry === undefined) return { blocked: false };
      if (entry.failures < maxFailures) return { blocked: false };
      const until = entry.lastFailAt + delayFor(entry.failures);
      const remaining = until - now();
      if (remaining <= 0) return { blocked: false };
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
    },

    fail(key: string): void {
      prune();
      const entry = entries.get(key);
      if (entry === undefined) {
        entries.set(key, { failures: 1, lastFailAt: now() });
        return;
      }
      entry.failures += 1;
      entry.lastFailAt = now();
    },

    succeed(key: string): void {
      entries.delete(key);
    },
  };
}
