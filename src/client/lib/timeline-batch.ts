import type { AgentEvent } from "../../server/agent/events";
import { reduceContext, type ContextState } from "./context";
import type { RewindEvent } from "./rewind";
import { reduceTimeline, type TimelineItem } from "./timeline";

/** Satu event sesi bernomor urut, siap diproses dalam batch. */
export interface BatchEvent {
  seq: number;
  event: AgentEvent;
}

/** Bagian state timeline yang dipengaruhi event: isi, konteks, dan daftar event. */
export interface TimelineBatchState {
  items: TimelineItem[];
  context?: ContextState;
  events?: RewindEvent[];
  /** Nomor urut event terakhir yang sudah diterapkan (0 bila belum ada). */
  lastSeq?: number;
}

/**
 * Terapkan sekumpulan event sekaligus.
 *
 * Hasilnya sama persis dengan menerapkan event satu per satu: `items` dan
 * `context` dirantai seperti `reduceTimeline`/`reduceContext`, dan `events`
 * ditambahkan satu per satu dengan urutan terjaga. Batch kosong tidak
 * mengubah state (objek yang sama dikembalikan).
 */
export function applyEventBatch(
  state: TimelineBatchState,
  batch: readonly BatchEvent[],
): TimelineBatchState {
  if (batch.length === 0) return state;

  let items = state.items;
  let context = state.context;
  const events: RewindEvent[] = [...(state.events ?? [])];
  let lastSeq = state.lastSeq ?? 0;

  for (const entry of batch) {
    items = reduceTimeline(items, entry.event, { seq: entry.seq });
    context = reduceContext(context, entry.event);
    events.push({ seq: entry.seq, event: entry.event });
    lastSeq = entry.seq;
  }

  return { items, context, events, lastSeq };
}
