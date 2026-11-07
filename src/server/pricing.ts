import type { ModelPrice } from "./provider";

export function estimateCostUsd(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  price: ModelPrice,
): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;

  const cost =
    (input * price.input +
      output * price.output +
      cacheRead * (price.cacheRead ?? price.input) +
      cacheWrite * (price.cacheWrite ?? price.input)) /
    1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
