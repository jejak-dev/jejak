import { describe, expect, test } from "bun:test";
import { contextUsage, formatTokens, reduceContext } from "../src/client/lib/context";
import { contextTokensOf, contextWindowOf } from "../src/server/agent/sdk-mapper";

describe("reduceContext dan contextUsage", () => {
  test("event context di tengah giliran memperbarui token dan mempertahankan jendela", () => {
    let state = reduceContext(undefined, { type: "result", contextTokens: 1000, contextWindow: 200000 });
    expect(state).toEqual({ tokens: 1000, window: 200000 });
    state = reduceContext(state, { type: "context", tokens: 5000 });
    expect(state).toEqual({ tokens: 5000, window: 200000 });
    expect(reduceContext(state, { type: "text" })).toBe(state);
    expect(reduceContext(state, { type: "result" })).toBe(state);
  });

  test("sebelum ada jendela hanya token; token nol diabaikan", () => {
    const state = reduceContext(undefined, { type: "context", tokens: 4200 });
    expect(contextUsage(state)).toEqual({ tokens: 4200, level: "ok" });
    expect(reduceContext(undefined, { type: "context", tokens: 0 })).toBeUndefined();
    expect(contextUsage(undefined)).toBeUndefined();
  });

  test("persen dan tingkat peringatan", () => {
    expect(contextUsage({ tokens: 1000, window: 200000 })).toEqual({
      tokens: 1000,
      window: 200000,
      percent: 1,
      level: "ok",
    });
    expect(contextUsage({ tokens: 150000, window: 200000 })?.level).toBe("warn");
    expect(contextUsage({ tokens: 190000, window: 200000 })?.level).toBe("high");
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

describe("perintah compact di palette", () => {
  test("hanya ada saat ada sesi terpilih", async () => {
    const { buildCommands } = await import("../src/client/lib/commands");
    const withSession = buildCommands({ sessions: [], hasSession: true, panelOpen: false });
    const without = buildCommands({ sessions: [], hasSession: false, panelOpen: false });
    expect(withSession.some((command) => command.run === "compact")).toBe(true);
    expect(without.some((command) => command.run === "compact")).toBe(false);
  });
});
