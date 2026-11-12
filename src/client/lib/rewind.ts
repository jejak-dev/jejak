import type { AgentEvent } from "../../server/agent/events";

/** Satu event sesi beserta nomor urutnya (dari SSE). */
export interface RewindEvent {
  seq: number;
  event: AgentEvent;
}

/**
 * Nomor urut pesan pengguna yang bisa dimundurkan: giliran sebelumnya harus
 * punya jangkar (uuid pesan assistant terakhir pada `result` sebelumnya).
 *
 * Prompt awal tidak punya nomor urut event sehingga tidak termasuk; pesan
 * pertama setelahnya baru bisa dimundurkan bila giliran pertama punya jangkar.
 * Pesan otomatis (mode Goal) tidak bisa dimundurkan.
 */
export function rewindableSeqs(events: readonly RewindEvent[]): number[] {
  let anchor = false;
  const seqs: number[] = [];
  for (const item of events) {
    const event = item.event;
    if (event.type === "result") {
      anchor = event.anchorUuid !== undefined;
      continue;
    }
    if (event.type !== "user_message" || !anchor) continue;
    if (event.auto !== undefined) continue;
    seqs.push(item.seq);
  }
  return seqs;
}
