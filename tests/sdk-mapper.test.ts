import { expect, test } from "bun:test";
import { mapSdkMessage, reconcileContextTokens } from "../src/server/agent/sdk-mapper";

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
      output: "baris satu\n[gambar]\nbaris dua",
      isError: false,
    },
  ]);
});

test("blok gambar diganti penanda; data base64 tak ikut ke event tersimpan", () => {
  const data = "A".repeat(2048);
  const events = mapSdkMessage({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-3",
          content: [
            { type: "image", data, mimeType: "image/jpeg" },
            { type: "text", text: "[Screenshot 1280x800, 2 KB]" },
          ],
        },
      ],
    },
  });

  const output = String((events[0] as { output?: string } | undefined)?.output ?? "");
  expect(output).toContain("[gambar 2 KB]");
  expect(output).toContain("[Screenshot 1280x800, 2 KB]");
  expect(output).not.toContain(data);
});

test("gambar yang diratakan jadi teks base64 tetap tak ikut tersimpan", () => {
  const data = "ABCDEF0123456789+/".repeat(100);
  const events = mapSdkMessage({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-4",
          content: [{ type: "text", text: `gambar: ${data}` }],
        },
      ],
    },
  });

  const output = String((events[0] as { output?: string } | undefined)?.output ?? "");
  expect(output).toContain("[data biner dipotong]");
  expect(output).not.toContain(data);
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

test("result sukses kosong dianggap gagal", () => {
  const [event] = mapSdkMessage({ type: "result", subtype: "success" });
  expect(event?.type).toBe("result");
  if (event?.type === "result") {
    expect(event.ok).toBe(false);
    expect(event.error).toContain("Giliran kosong");
  }
});

test("result sukses kosong dengan num_turns 0 dan output 0 dianggap gagal", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    result: "",
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  expect(event?.type).toBe("result");
  if (event?.type === "result") {
    expect(event.ok).toBe(false);
    expect(event.error).toContain("Giliran kosong");
  }
});

test("result sukses dengan teks walau num_turns 0 tetap sukses", () => {
  expect(
    mapSdkMessage({
      type: "result",
      subtype: "success",
      result: "perintah slash selesai",
      num_turns: 0,
      usage: { output_tokens: 0 },
    }),
  ).toEqual([
    { type: "result", ok: true, summary: "perintah slash selesai", outputTokens: 0, numTurns: 0 },
  ]);
});

test("result sukses normal tetap sukses", () => {
  expect(
    mapSdkMessage({
      type: "result",
      subtype: "success",
      result: "selesai",
      num_turns: 3,
      usage: { output_tokens: 50 },
    }),
  ).toEqual([
    { type: "result", ok: true, summary: "selesai", outputTokens: 50, numTurns: 3 },
  ]);
});

test("result berisi galat kompaksi dianggap gagal", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    result: "Error during compaction: API Error: 503 Service Unavailable",
    num_turns: 1,
    usage: { output_tokens: 10 },
  });
  expect(event?.type).toBe("result");
  if (event?.type === "result") {
    expect(event.ok).toBe(false);
    expect(event.error).toContain("Error during compaction: API Error: 503");
  }
});

test("result sukses kosong setelah compact tetap sukses", () => {
  expect(
    mapSdkMessage(
      {
        type: "result",
        subtype: "success",
        result: "",
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { compacted: true },
    ),
  ).toEqual([{ type: "result", ok: true, inputTokens: 0, outputTokens: 0, numTurns: 0 }]);
});

test("result sukses kosong tanpa opts compacted tetap dianggap gagal", () => {
  const [event] = mapSdkMessage({
    type: "result",
    subtype: "success",
    result: "",
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  expect(event?.type).toBe("result");
  if (event?.type === "result") {
    expect(event.ok).toBe(false);
    expect(event.error).toContain("Giliran kosong");
  }
});

test("galat kompaksi tetap gagal walau compacted true", () => {
  const [event] = mapSdkMessage(
    {
      type: "result",
      subtype: "success",
      result: "Error during compaction: API Error: 503 Service Unavailable",
      num_turns: 1,
      usage: { output_tokens: 10 },
    },
    { compacted: true },
  );
  expect(event?.type).toBe("result");
  if (event?.type === "result") {
    expect(event.ok).toBe(false);
    expect(event.error).toContain("Error during compaction: API Error: 503");
  }
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
    result: "selesai",
    total_cost_usd: "0.5",
    num_turns: "3",
    usage: { input_tokens: "10", output_tokens: null },
  });

  expect(event).toEqual({ type: "result", ok: true, summary: "selesai" });
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

test("stream_event text_delta menjadi event text_delta, delta lain diabaikan", () => {
  const delta = (d: unknown, parent?: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: d },
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
  });
  expect(mapSdkMessage(delta({ type: "text_delta", text: "ha" }))).toEqual([
    { type: "text_delta", text: "ha" },
  ]);
  expect(mapSdkMessage(delta({ type: "text_delta", text: "lo" }, "tu9"))).toEqual([
    { type: "text_delta", text: "lo", parentToolUseId: "tu9" },
  ]);
  expect(mapSdkMessage(delta({ type: "input_json_delta", partial_json: "{" }))).toEqual([]);
  expect(mapSdkMessage(delta({ type: "text_delta", text: "" }))).toEqual([]);
  expect(mapSdkMessage({ type: "stream_event", event: { type: "message_start" } })).toEqual([]);
});

test("prompt_suggestion menjadi event suggestion", () => {
  expect(
    mapSdkMessage({
      type: "prompt_suggestion",
      suggestion: "Jalankan tesnya",
      uuid: "u-1",
      session_id: "s-1",
    }),
  ).toEqual([{ type: "suggestion", text: "Jalankan tesnya" }]);
});

test("saran prompt dipotong 300 karakter dan saran kosong diabaikan", () => {
  const panjang = "x".repeat(400);
  const events = mapSdkMessage({ type: "prompt_suggestion", suggestion: panjang });
  expect(events).toHaveLength(1);
  expect((events[0] as { text: string }).text).toHaveLength(300);
  expect(mapSdkMessage({ type: "prompt_suggestion", suggestion: "   " })).toEqual([]);
  expect(mapSdkMessage({ type: "prompt_suggestion" })).toEqual([]);
});

test("reconcileContextTokens mengoreksi angka per pesan yang menggelembung", () => {
  const usage = { inputTokens: 13_531, cacheReadTokens: 1_995_136, cacheWriteTokens: 0, numTurns: 17 };
  const approx = Math.round((13_531 + 1_995_136) / 17);
  expect(reconcileContextTokens(1_501_288, usage, 1_000_000)).toEqual({ tokens: approx, estimated: true });
  expect(approx).toBeGreaterThan(117_000);
  expect(approx).toBeLessThan(119_000);
});

test("reconcileContextTokens membiarkan angka normal", () => {
  expect(
    reconcileContextTokens(100_000, { inputTokens: 900_000, numTurns: 10 }, 1_000_000),
  ).toEqual({ tokens: 100_000, estimated: false });
});

test("reconcileContextTokens memakai perkiraan bila angka per pesan tak ada", () => {
  expect(reconcileContextTokens(undefined, { inputTokens: 900_000, numTurns: 10 })).toEqual({
    tokens: 90_000,
    estimated: true,
  });
});

test("reconcileContextTokens membuang angka mustahil tanpa perkiraan", () => {
  expect(reconcileContextTokens(1_500_000, {}, 1_000_000)).toEqual({ tokens: undefined, estimated: false });
  expect(reconcileContextTokens(1_500_000, { inputTokens: 500, numTurns: 0 }, 1_000_000)).toEqual({
    tokens: undefined,
    estimated: false,
  });
});

test("reconcileContextTokens ambang 2,5x perkiraan", () => {
  const usage = { inputTokens: 1_000_000, numTurns: 10 }; // approx 100_000
  expect(reconcileContextTokens(240_000, usage, 1_000_000)).toEqual({ tokens: 240_000, estimated: false });
  expect(reconcileContextTokens(260_000, usage, 1_000_000)).toEqual({ tokens: 100_000, estimated: true });
});
