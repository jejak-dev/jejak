import { expect, test } from "bun:test";
import { mapSdkMessage } from "../src/server/agent/sdk-mapper";

test("pesan system init menjadi event session", () => {
  expect(
    mapSdkMessage({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet" }),
  ).toEqual([{ type: "session", sessionId: "s-1", model: "claude-sonnet" }]);
});

test("system non-init dan session tanpa session_id diabaikan", () => {
  expect(mapSdkMessage({ type: "system", subtype: "status", session_id: "s-1" })).toEqual([]);
  expect(mapSdkMessage({ type: "system", subtype: "init", model: "m" })).toEqual([]);
});

test("assistant dengan blok campuran dipetakan berurutan", () => {
  const message = {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "Saya pikir dulu." },
        { type: "text", text: "Saya akan membaca berkas." },
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.ts" } },
        { type: "image", source: {} },
      ],
    },
  };

  expect(mapSdkMessage(message)).toEqual([
    { type: "thinking", text: "Saya pikir dulu." },
    { type: "text", text: "Saya akan membaca berkas." },
    { type: "tool_call", id: "tu-1", name: "Read", input: { file_path: "a.ts" } },
  ]);
});

test("parent_tool_use_id berupa string diteruskan ke event subagent", () => {
  const events = mapSdkMessage({
    type: "assistant",
    parent_tool_use_id: "parent-1",
    message: { content: [{ type: "text", text: "dari subagent" }] },
  });

  expect(events).toEqual([{ type: "text", text: "dari subagent", parentToolUseId: "parent-1" }]);
});

test("blok teks kosong atau berspasi dilewati", () => {
  expect(
    mapSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
          { type: "thinking", thinking: "" },
        ],
      },
    }),
  ).toEqual([]);
});

test("tool_result dari string dipetakan", () => {
  expect(
    mapSdkMessage({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "isi berkas" }],
      },
    }),
  ).toEqual([{ type: "tool_result", id: "tu-1", output: "isi berkas", isError: false }]);
});

test("tool_result dari array blok teks digabung dengan newline", () => {
  expect(
    mapSdkMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: [
              { type: "text", text: "baris satu" },
              { type: "image", source: {} },
              { type: "text", text: "baris dua" },
            ],
          },
        ],
      },
    }),
  ).toEqual([
    {
      type: "tool_result",
      id: "tu-2",
      output: "baris satu\n[bukan teks]\nbaris dua",
      isError: false,
    },
  ]);
});

test("is_error hanya true bila bernilai boolean true", () => {
  const events = mapSdkMessage({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "a", content: "gagal", is_error: true },
        { type: "tool_result", tool_use_id: "b", content: "ok", is_error: "true" },
      ],
    },
  });

  expect(events).toEqual([
    { type: "tool_result", id: "a", output: "gagal", isError: true },
    { type: "tool_result", id: "b", output: "ok", isError: false },
  ]);
});

test("output tool_result dipotong pada 4000 karakter", () => {
  const output = "x".repeat(4500);
  const [event] = mapSdkMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t", content: output }] },
  });

  expect(event?.type).toBe("tool_result");
  if (event?.type === "tool_result") {
    expect(event.output).toBe(`${"x".repeat(4000)}\n…(dipotong)`);
  }
});

test("output tool_result tepat 4000 karakter tidak dipotong", () => {
  const output = "y".repeat(4000);
  const [event] = mapSdkMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t", content: output }] },
  });

  if (event?.type === "tool_result") {
    expect(event.output).toBe(output);
  }
});

test("user dengan content string biasa diabaikan", () => {
  expect(mapSdkMessage({ type: "user", message: { content: "prompt pengguna" } })).toEqual([]);
});

test("result sukses memetakan ringkasan, biaya, dan token", () => {
  expect(
    mapSdkMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "selesai",
      total_cost_usd: 0.0123,
      num_turns: 3,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  ).toEqual([
    {
      type: "result",
      ok: true,
      summary: "selesai",
      costUsd: 0.0123,
      inputTokens: 100,
      outputTokens: 50,
      numTurns: 3,
    },
  ]);
});

test("result sukses tanpa result string tidak memuat summary", () => {
  expect(mapSdkMessage({ type: "result", subtype: "success" })).toEqual([
    { type: "result", ok: true },
  ]);
});

test("result gagal error_max_turns memakai errors bila ada", () => {
  expect(
    mapSdkMessage({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["melebihi batas", "coba lagi"],
      usage: { input_tokens: 10 },
    }),
  ).toEqual([
    {
      type: "result",
      ok: false,
      error: "melebihi batas; coba lagi",
      inputTokens: 10,
    },
  ]);
});

test("result gagal tanpa errors memakai subtype", () => {
  expect(mapSdkMessage({ type: "result", subtype: "error_during_execution" })).toEqual([
    { type: "result", ok: false, error: "eksekusi gagal (error_during_execution)" },
  ]);
});

test("result tidak memuat properti opsional yang salah tipe", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    total_cost_usd: "0.5",
    num_turns: "3",
    usage: { input_tokens: "10", output_tokens: null },
  });

  expect(event).toEqual({ type: "result", ok: true });
});

test("tipe pesan lain dan input sampah menghasilkan array kosong", () => {
  expect(mapSdkMessage({ type: "stream_event", event: {} })).toEqual([]);
  expect(mapSdkMessage({ type: "status" })).toEqual([]);
  expect(mapSdkMessage(null)).toEqual([]);
  expect(mapSdkMessage(undefined)).toEqual([]);
  expect(mapSdkMessage("teks")).toEqual([]);
  expect(mapSdkMessage(42)).toEqual([]);
  expect(mapSdkMessage([])).toEqual([]);
  expect(mapSdkMessage({})).toEqual([]);
  expect(mapSdkMessage({ type: "assistant" })).toEqual([]);
  expect(mapSdkMessage({ type: "assistant", message: { content: "bukan array" } })).toEqual([]);
});

test("result memuat cacheReadTokens dan cacheWriteTokens dari usage", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 15
    },
  });

  expect(event).toEqual({
    type: "result",
    ok: true,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 15,
  });
});

test("result tidak memuat cache tokens bila tidak ada di usage", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
  });

  expect(event).toEqual({
    type: "result",
    ok: true,
    inputTokens: 100,
    outputTokens: 50,
  });
});

test("result tidak memuat cache tokens bila bukan angka", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: "invalid",
      cache_creation_input_tokens: null
    },
  });

  expect(event).toEqual({
    type: "result",
    ok: true,
    inputTokens: 100,
    outputTokens: 50,
  });
});
