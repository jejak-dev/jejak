import { describe, expect, test } from "bun:test";
import { contextUsage, formatTokens } from "../src/client/lib/context";
import type { TimelineItem } from "../src/client/lib/timeline";
import { contextTokensOf, contextWindowOf } from "../src/server/agent/sdk-mapper";

const result = (extra: Partial<Extract<TimelineItem, { kind: "result" }>>): TimelineItem => ({
  kind: "result",
  ok: true,
  ...extra,
});

describe("contextUsage", () => {
  test("memakai hasil terakhir yang punya data konteks", () => {
    const items: TimelineItem[] = [
      result({ contextTokens: 1000, contextWindow: 200000 }),
      { kind: "text", text: "x", depth: 0 },
      result({}),
    ];
    expect(contextUsage(items)).toEqual({ tokens: 1000, window: 200000, percent: 1, level: "ok" });
  });

  test("tingkat peringatan dan tanpa jendela", () => {
    expect(contextUsage([result({ contextTokens: 150000, contextWindow: 200000 })])?.level).toBe("warn");
    expect(contextUsage([result({ contextTokens: 190000, contextWindow: 200000 })])?.level).toBe("high");
    expect(contextUsage([result({ contextTokens: 5000 })])).toEqual({ tokens: 5000, level: "ok" });
    expect(contextUsage([])).toBeUndefined();
  });

  test("format token", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1,2 rb");
    expect(formatTokens(42_000)).toBe("42 rb");
    expect(formatTokens(1_500_000)).toBe("1,5 jt");
  });
});

describe("pemetaan konteks SDK", () => {
  test("token dari usage assistant agent utama saja", () => {
    const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 };
    expect(contextTokensOf({ type: "assistant", message: { content: [], usage } })).toBe(135);
    expect(
      contextTokensOf({ type: "assistant", parent_tool_use_id: "t1", message: { content: [], usage } }),
    ).toBeUndefined();
    expect(contextTokensOf({ type: "user" })).toBeUndefined();
    expect(contextTokensOf({ type: "assistant", message: { content: [], usage: {} } })).toBeUndefined();
  });

  test("jendela terbesar dari modelUsage", () => {
    expect(
      contextWindowOf({
        type: "result",
        modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 }, c: {} },
      }),
    ).toBe(1000000);
    expect(contextWindowOf({ type: "result" })).toBeUndefined();
  });
});
