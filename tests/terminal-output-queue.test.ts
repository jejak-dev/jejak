import { describe, expect, test } from "bun:test";
import {
  OUTPUT_FLUSH_BYTES,
  OUTPUT_FLUSH_MS,
  createOutputQueue,
} from "../src/server/terminal/output-queue";

const decoder = new TextDecoder();

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waktu habis menunggu flush");
    await Bun.sleep(5);
  }
}

describe("createOutputQueue", () => {
  test("menggabungkan potongan kecil menjadi satu frame", async () => {
    const frames: Uint8Array[] = [];
    const queue = createOutputQueue((frame) => frames.push(frame));
    queue.push(new TextEncoder().encode("ha"));
    queue.push(new TextEncoder().encode("lo"));
    expect(frames).toHaveLength(0);
    await waitFor(() => frames.length === 1);
    expect(frames).toHaveLength(1);
    expect(decoder.decode(frames[0])).toBe("halo");
    queue.dispose();
  });

  test("flush seketika saat ambang byte tercapai", () => {
    const frames: Uint8Array[] = [];
    const queue = createOutputQueue((frame) => frames.push(frame));
    queue.push(new Uint8Array(OUTPUT_FLUSH_BYTES));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(OUTPUT_FLUSH_BYTES);
    queue.dispose();
  });

  test("flush() mengirim sisa tertunda tanpa menunggu timer", () => {
    const frames: Uint8Array[] = [];
    const queue = createOutputQueue((frame) => frames.push(frame));
    queue.push(new TextEncoder().encode("sisa"));
    queue.flush();
    expect(frames).toHaveLength(1);
    expect(decoder.decode(frames[0])).toBe("sisa");
    queue.dispose();
  });

  test("timer mengirim frame parsial setelah jeda", async () => {
    const frames: Uint8Array[] = [];
    const queue = createOutputQueue((frame) => frames.push(frame));
    queue.push(new TextEncoder().encode("tunggu"));
    expect(frames).toHaveLength(0);
    await waitFor(() => frames.length === 1, OUTPUT_FLUSH_MS * 50);
    expect(decoder.decode(frames[0])).toBe("tunggu");
    queue.dispose();
  });

  test("dispose membuang sisa dan membatalkan timer", async () => {
    const frames: Uint8Array[] = [];
    const queue = createOutputQueue((frame) => frames.push(frame));
    queue.push(new TextEncoder().encode("buang"));
    queue.dispose();
    await Bun.sleep(OUTPUT_FLUSH_MS * 5);
    expect(frames).toHaveLength(0);
  });
});
