import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/server/agent/events";
import { reduceContext } from "../src/client/lib/context";
import {
  applyEventBatch,
  type BatchEvent,
  type TimelineBatchState,
} from "../src/client/lib/timeline-batch";
import { reduceTimeline, startTimeline } from "../src/client/lib/timeline";

const MIXED: AgentEvent[] = [
  { type: "session", sessionId: "s1" },
  { type: "user_message", text: "halo" },
  { type: "text_delta", text: "Ha" },
  { type: "text_delta", text: "lo" },
  { type: "thinking", text: "berpikir" },
  { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
  { type: "permission_request", id: "p1", toolUseId: "t1", name: "Read", input: {} },
  { type: "permission_resolved", id: "p1", decision: "allow" },
  { type: "tool_result", id: "t1", output: "isi", isError: false },
  { type: "context", tokens: 1200, window: 200000 },
  { type: "notice", text: "catatan", level: "warn" },
  { type: "text", text: "selesai" },
];

function batchOf(events: AgentEvent[], start = 1): BatchEvent[] {
  return events.map((event, index) => ({ seq: start + index, event }));
}

/** Terapkan event satu per satu seperti yang dilakukan hook sebelum batching. */
function applyOneByOne(
  state: TimelineBatchState,
  batch: readonly BatchEvent[],
): TimelineBatchState {
  let items = state.items;
  let context = state.context;
  const events = [...(state.events ?? [])];
  let lastSeq = state.lastSeq ?? 0;
  for (const entry of batch) {
    items = reduceTimeline(items, entry.event, { seq: entry.seq });
    context = reduceContext(context, entry.event);
    events.push({ seq: entry.seq, event: entry.event });
    lastSeq = entry.seq;
  }
  return { items, context, events, lastSeq };
}

function baseState(): TimelineBatchState {
  return { items: startTimeline("prompt awal"), events: [] };
}

describe("applyEventBatch", () => {
  test("hasil sama persis dengan menerapkan event satu per satu", () => {
    const state = baseState();
    const batch = batchOf(MIXED);

    const batched = applyEventBatch(state, batch);
    const stepwise = applyOneByOne(state, batch);

    expect(batched.items).toEqual(stepwise.items);
    expect(batched.context).toEqual(stepwise.context);
    expect(batched.events).toEqual(stepwise.events);
    expect(batched.lastSeq).toBe(stepwise.lastSeq);
  });

  test("isi timeline sama untuk urutan campuran yang memuat tool, izin, dan konteks", () => {
    const state = baseState();
    const result = applyEventBatch(state, batchOf(MIXED));

    expect(result.items.map((item) => item.kind)).toEqual([
      "user",
      "user",
      "text",
      "thinking",
      "tool",
      "permission",
      "notice",
      "text",
    ]);
    expect(result.context).toEqual({ tokens: 1200, window: 200000 });
    expect(result.events ?? []).toHaveLength(MIXED.length);
  });

  test("batch kosong tidak mengubah state", () => {
    const state = baseState();
    const result = applyEventBatch(state, []);
    expect(result).toBe(state);
  });

  test("seq terakhir benar", () => {
    const batch = batchOf(MIXED, 100);
    const result = applyEventBatch(baseState(), batch);
    const last = batch[batch.length - 1];
    expect(result.lastSeq).toBe(last?.seq);
    const events = result.events ?? [];
    expect(events[events.length - 1]?.seq).toBe(last?.seq);
  });

  test("nomor urut pesan pengguna ikut terbawa dari batch", () => {
    const result = applyEventBatch(baseState(), batchOf([{ type: "user_message", text: "halo" }], 7));
    const user = result.items[1];
    expect(user).toEqual({ kind: "user", text: "halo", seq: 7 });
  });

  test("membagi batch menjadi beberapa bagian tetap sama hasilnya", () => {
    const batch = batchOf(MIXED);
    const whole = applyEventBatch(baseState(), batch);

    const first = applyEventBatch(baseState(), batch.slice(0, 5));
    const second = applyEventBatch(first, batch.slice(5));

    expect(second.items).toEqual(whole.items);
    expect(second.context).toEqual(whole.context);
    expect(second.events).toEqual(whole.events);
    expect(second.lastSeq).toBe(whole.lastSeq);
  });

  test("event hasil menutup tool yang masih berjalan", () => {
    const result = applyEventBatch(baseState(), [
      { seq: 1, event: { type: "tool_call", id: "t9", name: "Bash", input: {} } },
      { seq: 2, event: { type: "result", ok: true } },
    ]);
    const tool = result.items.find((item) => item.kind === "tool");
    expect(tool?.status).toBe("gagal");
    expect(result.items[result.items.length - 1]?.kind).toBe("result");
  });
});
