import type { TimelineItem } from "./timeline";

export interface ContextUsage {
  tokens: number;
  /** Jendela konteks bila diketahui; `undefined` berarti hanya jumlah token yang tampil. */
  window?: number;
  /** 0–100, dibulatkan; hanya ada bila `window` ada. */
  percent?: number;
  level: "ok" | "warn" | "high";
}

/** Penggunaan konteks dari event hasil terakhir yang memuatnya. */
export function contextUsage(items: readonly TimelineItem[]): ContextUsage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "result" || item.contextTokens === undefined) continue;
    const usage: ContextUsage = { tokens: item.contextTokens, level: "ok" };
    if (item.contextWindow !== undefined && item.contextWindow > 0) {
      usage.window = item.contextWindow;
      usage.percent = Math.min(100, Math.round((item.contextTokens / item.contextWindow) * 100));
      usage.level = usage.percent >= 90 ? "high" : usage.percent >= 70 ? "warn" : "ok";
    }
    return usage;
  }
  return undefined;
}

/** 950 -> "950", 1.234 -> "1,2 rb", 42.000 -> "42 rb", 1.500.000 -> "1,5 jt". */
export function formatTokens(value: number): string {
  const trim = (n: number): string => (Math.round(n * 10) / 10).toString().replace(".", ",");
  if (value >= 1_000_000) return `${trim(value / 1_000_000)} jt`;
  if (value >= 10_000) return `${Math.round(value / 1000)} rb`;
  if (value >= 1000) return `${trim(value / 1000)} rb`;
  return String(Math.round(value));
}
