export interface ContextUsage {
  tokens: number;
  /** Jendela konteks bila diketahui; `undefined` berarti hanya jumlah token yang tampil. */
  window?: number;
  /** 0–100, dibulatkan; hanya ada bila `window` ada. */
  percent?: number;
  level: "ok" | "warn" | "high";
}

/** Keadaan konteks mentah dari aliran event; `window` bertahan dari hasil sebelumnya. */
export interface ContextState {
  tokens: number;
  window?: number;
}

/** Perbarui keadaan konteks dari satu event (`context` di tengah giliran, `result` di akhir). */
export function reduceContext(
  previous: ContextState | undefined,
  event: { type: string; tokens?: number; contextTokens?: number; contextWindow?: number },
): ContextState | undefined {
  let tokens: number | undefined;
  if (event.type === "context") tokens = event.tokens;
  else if (event.type === "result") tokens = event.contextTokens;
  const window = event.type === "result" ? event.contextWindow : undefined;
  if (tokens === undefined && window === undefined) return previous;
  const next: ContextState = { tokens: tokens ?? previous?.tokens ?? 0 };
  const keptWindow = window ?? previous?.window;
  if (keptWindow !== undefined) next.window = keptWindow;
  return next.tokens > 0 ? next : previous;
}

export function contextUsage(state: ContextState | undefined): ContextUsage | undefined {
  if (state === undefined) return undefined;
  const usage: ContextUsage = { tokens: state.tokens, level: "ok" };
  if (state.window !== undefined && state.window > 0) {
    usage.window = state.window;
    usage.percent = Math.min(100, Math.round((state.tokens / state.window) * 100));
    usage.level = usage.percent >= 90 ? "high" : usage.percent >= 70 ? "warn" : "ok";
  }
  return usage;
}

/** 950 -> "950", 1.234 -> "1,2 rb", 42.000 -> "42 rb", 1.500.000 -> "1,5 jt". */
export function formatTokens(value: number): string {
  const trim = (n: number): string => (Math.round(n * 10) / 10).toString().replace(".", ",");
  if (value >= 1_000_000) return `${trim(value / 1_000_000)} jt`;
  if (value >= 10_000) return `${Math.round(value / 1000)} rb`;
  if (value >= 1000) return `${trim(value / 1000)} rb`;
  return String(Math.round(value));
}
