import { describe, expect, it } from "bun:test";
import type { ModelPrice } from "../src/server/provider";
import { estimateCostUsd } from "../src/server/pricing";

// Test estimateCostUsd function
describe("estimateCostUsd", () => {
  it("should calculate cost correctly with input and output tokens", () => {
    const price: ModelPrice = { input: 10, output: 20 };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    const result = estimateCostUsd(usage, price);
    expect(result).toBe(20); // (1M * 10 + 500K * 20) / 1M = (10 + 10) = 20
  });

  it("should use input price for cacheRead when cacheRead is not provided", () => {
    const price: ModelPrice = { input: 10, output: 20 };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000 };
    const result = estimateCostUsd(usage, price);
    expect(result).toBe(21); // (1M * 10 + 500K * 20 + 100K * 10) / 1M = (10 + 10 + 1) = 21
  });

  it("should use input price for cacheWrite when cacheWrite is not provided", () => {
    const price: ModelPrice = { input: 10, output: 20 };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheWriteTokens: 200_000 };
    const result = estimateCostUsd(usage, price);
    expect(result).toBe(22); // (1M * 10 + 500K * 20 + 200K * 10) / 1M = (10 + 10 + 2) = 22
  });

  it("should handle cacheRead and cacheWrite with their own prices", () => {
    const price: ModelPrice = { input: 10, output: 20, cacheRead: 5, cacheWrite: 15 };
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 200_000
    };
    const result = estimateCostUsd(usage, price);
    // (1M*10 + 500K*20 + 100K*5 + 200K*15)/1M = (10 + 10 + 0.5 + 3) = 23.5
    expect(result).toBe(23.5);
  });

  it("should return 0 when no tokens are provided", () => {
    const price: ModelPrice = { input: 10, output: 20 };
    const usage = {};
    const result = estimateCostUsd(usage, price);
    expect(result).toBe(0);
  });

  it("should round to 6 decimal places", () => {
    const price: ModelPrice = { input: 1, output: 1 };
    const usage = { inputTokens: 1234567, outputTokens: 7654321 };
    const result = estimateCostUsd(usage, price);
    // (1234567 + 7654321) / 1M = 8.888888
    expect(result).toBeCloseTo(8.888888, 6);
  });
});
