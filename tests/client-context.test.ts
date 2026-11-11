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

describe("setelah compact", () => {
  test("compact_boundary memberi post_tokens, atau 0 bila tak diketahui", () => {
    const boundary = (meta: Record<string, unknown>) => ({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 9000, ...meta },
    });
    expect(contextTokensOf(boundary({ post_tokens: 1200 }))).toBe(1200);
    expect(contextTokensOf(boundary({}))).toBe(0);
  });

  test("event context 0 menyembunyikan cincin sampai balasan berikutnya", () => {
    const before = reduceContext(undefined, { type: "result", contextTokens: 7926, contextWindow: 200000 });
    expect(reduceContext(before, { type: "context", tokens: 0 })).toBeUndefined();
    expect(reduceContext(before, { type: "context", tokens: 1200 })?.tokens).toBe(1200);
  });
});

describe("jendela dari event context", () => {
  test("event context membawa jendela dan menggantikan angka lama", () => {
    const old = reduceContext(undefined, { type: "result", contextTokens: 27000, contextWindow: 200000 });
    const next = reduceContext(old, { type: "context", tokens: 28000, window: 1000000 });
    expect(next).toEqual({ tokens: 28000, window: 1000000 });
  });
});
