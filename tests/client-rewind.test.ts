import { describe, expect, test } from "bun:test";
import { rewindableSeqs, type RewindEvent } from "../src/client/lib/rewind";

function events(...items: RewindEvent[]): RewindEvent[] {
  return items;
}

function user(seq: number): RewindEvent {
  return { seq, event: { type: "user_message", text: `pesan ${seq}` } };
}

function result(seq: number, anchorUuid?: string): RewindEvent {
  return {
    seq,
    event: {
      type: "result",
      ok: true,
      ...(anchorUuid === undefined ? {} : { anchorUuid }),
    },
  };
}

describe("rewindableSeqs", () => {
  test("pesan pengguna setelah jangkar bisa dimundurkan", () => {
    const list = events(result(1, "anchor-1"), user(2), result(3, "anchor-2"), user(4));

    expect(rewindableSeqs(list)).toEqual([2, 4]);
  });

  test("pesan tanpa jangkar giliran sebelumnya tidak bisa dimundurkan", () => {
    const list = events(result(1), user(2));

    expect(rewindableSeqs(list)).toEqual([]);
  });

  test("pesan pertama tanpa giliran sebelumnya tidak bisa dimundurkan", () => {
    const list = events(user(1), result(2, "anchor-1"));

    expect(rewindableSeqs(list)).toEqual([]);
  });

  test("hasil tanpa jangkar membatalkan jangkar giliran sebelumnya", () => {
    const list = events(result(1, "anchor-1"), user(2), result(3), user(4));

    expect(rewindableSeqs(list)).toEqual([2]);
  });

  test("event lain tidak memengaruhi daftar", () => {
    const list = events(
      { seq: 1, event: { type: "session", sessionId: "sdk-1" } },
      { seq: 2, event: { type: "text", text: "halo" } },
      result(3, "anchor-1"),
      user(4),
      { seq: 5, event: { type: "tool_call", id: "t1", name: "Read", input: {} } },
    );

    expect(rewindableSeqs(list)).toEqual([4]);
  });

  test("daftar kosong untuk sesi tanpa pesan pengguna", () => {
    expect(rewindableSeqs(events(result(1, "anchor-1")))).toEqual([]);
    expect(rewindableSeqs([])).toEqual([]);
  });
});
