import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/server/agent/events";
import {
  reduceTimeline,
  startTimeline,
  summarizeToolInput,
  type TimelineItem,
} from "../src/client/lib/timeline";

function reduceAll(events: AgentEvent[], initial: TimelineItem[] = []): TimelineItem[] {
  return events.reduce(reduceTimeline, initial);
}

describe("startTimeline", () => {
  test("membuat item user dari prompt", () => {
    expect(startTimeline("Halo")).toEqual([{ kind: "user", text: "Halo" }]);
  });
});

describe("summarizeToolInput", () => {
  test("file_path lalu path", () => {
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Read", { path: "/c/d.ts" })).toBe("/c/d.ts");
    expect(summarizeToolInput("Read", { file_path: "/a", path: "/b" })).toBe("/a");
  });

  test("command memakai baris pertama", () => {
    expect(summarizeToolInput("Bash", { command: "bun test\nbun run typecheck" })).toBe("bun test");
  });

  test("pattern dan url", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeToolInput("WebFetch", { url: "https://contoh.test" })).toBe(
      "https://contoh.test",
    );
  });

  test("selain itu kosong", () => {
    expect(summarizeToolInput("X", { foo: 1 })).toBe("");
    expect(summarizeToolInput("X", null)).toBe("");
    expect(summarizeToolInput("X", undefined)).toBe("");
  });

  test("memotong 80 karakter dengan elipsis", () => {
    const long = "a".repeat(100);
    const summary = summarizeToolInput("X", { path: long });
    expect(summary).toBe(`${"a".repeat(80)}…`);
    expect(summarizeToolInput("X", { path: "a".repeat(80) })).toBe("a".repeat(80));
  });

  test("command panjang dipotong setelah baris pertama", () => {
    const long = `bun x ${"b".repeat(100)}\nkedua`;
    expect(summarizeToolInput("Bash", { command: long })).toBe(
      `${`bun x ${"b".repeat(100)}`.slice(0, 80)}…`,
    );
  });
});

describe("reduceTimeline", () => {
  test("session tidak mengubah isi tetapi mengembalikan salinan", () => {
    const items: TimelineItem[] = [{ kind: "user", text: "Halo" }];
    const next = reduceTimeline(items, { type: "session", sessionId: "s1" });

    expect(next).toEqual(items);
    expect(next).not.toBe(items);
  });

  test("text dan thinking dengan depth dari parentToolUseId", () => {
    const next = reduceAll([
      { type: "text", text: "a" },
      { type: "thinking", text: "b" },
      { type: "text", text: "c", parentToolUseId: "t1" },
      { type: "thinking", text: "d", parentToolUseId: "t1" },
    ]);

    expect(next).toEqual([
      { kind: "text", text: "a", depth: 0 },
      { kind: "thinking", text: "b", depth: 0 },
      { kind: "text", text: "c", depth: 1 },
      { kind: "thinking", text: "d", depth: 1 },
    ]);
  });

  test("tool_call membuat item berjalan dengan summary", () => {
    const next = reduceAll([
      { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
    ]);

    expect(next).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "Read",
        input: { file_path: "/a.ts" },
        summary: "/a.ts",
        status: "berjalan",
        depth: 0,
      },
    ]);
  });

  test("tool_result menempel ke tool yang tepat pada dua tool paralel", () => {
    const next = reduceAll([
      { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_call", id: "t2", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", id: "t2", output: "isi", isError: false },
    ]);

    const tools = next.filter((item) => item.kind === "tool");
    expect(tools).toEqual([
      expect.objectContaining({ id: "t1", status: "berjalan" }),
      expect.objectContaining({ id: "t2", status: "selesai", output: "isi" }),
    ]);
  });

  test("tool_result error menjadi gagal", () => {
    const next = reduceAll([
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "x" } },
      { type: "tool_result", id: "t1", output: "gagal", isError: true },
    ]);

    expect(next[0]).toMatchObject({ kind: "tool", status: "gagal", output: "gagal" });
  });

  test("tool_result yatim menambah item tool", () => {
    const next = reduceAll([{ type: "tool_result", id: "x", output: "out", isError: false }]);

    expect(next).toEqual([
      {
        kind: "tool",
        id: "x",
        name: "(tidak diketahui)",
        input: undefined,
        summary: "",
        status: "selesai",
        output: "out",
        depth: 0,
      },
    ]);
  });

  test("error menambah item error", () => {
    expect(reduceAll([{ type: "error", message: "rusak" }])).toEqual([
      { kind: "error", message: "rusak" },
    ]);
  });

  test("result menutup tool yang menggantung dan hanya ada satu result", () => {
    const next = reduceAll([
      { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/a" } },
      {
        type: "tool_call",
        id: "t2",
        name: "Read",
        input: { file_path: "/b" },
        parentToolUseId: "t1",
      },
      { type: "tool_result", id: "t1", output: "ok", isError: false },
      { type: "result", ok: true, summary: "selesai", costUsd: 0.01, numTurns: 2 },
      { type: "result", ok: false, error: "gagal", inputTokens: 3, outputTokens: 4 },
    ]);

    const results = next.filter((item) => item.kind === "result");
    expect(results).toEqual([
      { kind: "result", ok: false, error: "gagal", inputTokens: 3, outputTokens: 4 },
    ]);
    expect(next.filter((item) => item.kind === "tool")).toEqual([
      expect.objectContaining({ id: "t1", status: "selesai" }),
      expect.objectContaining({ id: "t2", status: "gagal" }),
    ]);
  });

  test("result membawa field opsional yang ada saja", () => {
    const next = reduceAll([{ type: "result", ok: true }]);
    expect(next).toEqual([{ kind: "result", ok: true }]);
    expect(next[0]).not.toHaveProperty("summary");
  });

  test("tidak memutasi input", () => {
    const items: readonly TimelineItem[] = [
      { kind: "user", text: "Halo" },
      { kind: "tool", id: "t1", name: "Read", input: {}, summary: "", status: "berjalan", depth: 0 },
    ];
    const snapshot = JSON.parse(JSON.stringify(items)) as TimelineItem[];

    reduceTimeline(items, { type: "text", text: "a" });
    reduceTimeline(items, { type: "tool_result", id: "t1", output: "o", isError: false });
    reduceTimeline(items, { type: "result", ok: true });
    reduceTimeline(items, { type: "error", message: "e" });

    expect(items).toEqual(snapshot);
    expect((items[1] as { status: string }).status).toBe("berjalan");
  });
});

describe("reduceTimeline: izin", () => {
  const request: AgentEvent = {
    type: "permission_request",
    id: "p1",
    name: "Write",
    input: { file_path: "a.txt" },
    expiresAt: "2026-11-08T10:10:00.000Z",
  };

  test("permission_request menambah kartu berstatus menunggu", () => {
    expect(reduceAll([request])).toEqual([
      {
        kind: "permission",
        id: "p1",
        name: "Write",
        input: { file_path: "a.txt" },
        expiresAt: "2026-11-08T10:10:00.000Z",
        status: "menunggu",
      },
    ]);
  });

  test("allow menjadi diizinkan", () => {
    const items = reduceAll([request, { type: "permission_resolved", id: "p1", decision: "allow" }]);
    expect(items[0]).toMatchObject({ kind: "permission", status: "diizinkan" });
  });

  test("deny membawa alasan pengguna", () => {
    const items = reduceAll([
      request,
      { type: "permission_resolved", id: "p1", decision: "deny", message: "pakai tests/ saja" },
    ]);
    expect(items[0]).toMatchObject({ status: "ditolak", message: "pakai tests/ saja" });
  });

  test("pesan sistem dipetakan ke kedaluwarsa dan dihentikan tanpa alasan", () => {
    const expired = reduceAll([
      request,
      { type: "permission_resolved", id: "p1", decision: "deny", message: "waktu izin habis" },
    ]);
    expect(expired[0]).toMatchObject({ status: "kedaluwarsa" });
    expect(expired[0]).not.toHaveProperty("message");

    const stopped = reduceAll([
      request,
      { type: "permission_resolved", id: "p1", decision: "deny", message: "sesi dihentikan" },
    ]);
    expect(stopped[0]).toMatchObject({ status: "dihentikan" });
  });

  test("resolved untuk id lain tidak mengubah kartu", () => {
    const items = reduceAll([request, { type: "permission_resolved", id: "lain", decision: "allow" }]);
    expect(items[0]).toMatchObject({ status: "menunggu" });
  });
});
