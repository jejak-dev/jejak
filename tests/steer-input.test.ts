import { expect, test } from "bun:test";
import { createSteerInput, queuedTurnCountOf } from "../src/server/agent/steer-input";

/** Ambil satu pesan dari iterable prompt. */
async function next<T>(iterator: AsyncIterator<T>): Promise<T | undefined> {
  const langkah = await iterator.next();
  return langkah.done ? undefined : langkah.value;
}

test("pesan pertama tak memakai priority", async () => {
  const input = createSteerInput("halo");
  const iterator = input.iterable[Symbol.asyncIterator]();

  const pertama = await next(iterator);
  expect(pertama?.type).toBe("user");
  expect(pertama?.message).toEqual({ role: "user", content: "halo" });
  expect(pertama?.priority).toBeUndefined();
});

test("pesan steer memakai priority next", async () => {
  const input = createSteerInput("halo");
  const iterator = input.iterable[Symbol.asyncIterator]();
  await next(iterator);

  expect(input.steer("tambahan")).toBe(true);
  const kedua = await next(iterator);
  expect(kedua?.priority).toBe("next");
  expect(kedua?.message).toEqual({ role: "user", content: "tambahan" });
  expect(kedua?.parent_tool_use_id).toBeNull();
});

test("steer setelah close ditolak", async () => {
  const input = createSteerInput("halo");
  input.close();
  expect(input.steer("tambahan")).toBe(false);
});

test("generator selesai setelah close bila antrean kosong", async () => {
  const input = createSteerInput("halo");
  const iterator = input.iterable[Symbol.asyncIterator]();
  await next(iterator);

  input.close();
  const langkah = await iterator.next();
  expect(langkah.done).toBe(true);
});

test("generator menunggu lalu melanjutkan saat steer", async () => {
  const input = createSteerInput("halo");
  const iterator = input.iterable[Symbol.asyncIterator]();
  await next(iterator);

  const menunggu = iterator.next();
  // Generator sudah menunggu pesan baru.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(input.pendingCount()).toBe(0);

  expect(input.steer("tambahan")).toBe(true);
  const langkah = await menunggu;
  expect(langkah.value?.message.content).toBe("tambahan");
});

test("pendingCount menghitung pesan yang belum dibaca iterator", async () => {
  const input = createSteerInput("halo");
  const iterator = input.iterable[Symbol.asyncIterator]();
  expect(input.pendingCount()).toBe(1);

  await next(iterator);
  expect(input.pendingCount()).toBe(0);

  input.steer("tambahan");
  expect(input.pendingCount()).toBe(1);
  await next(iterator);
  expect(input.pendingCount()).toBe(0);
});

test("queuedTurnCountOf membaca jumlah giliran yang menunggu", () => {
  expect(queuedTurnCountOf({ type: "result" })).toBe(0);
  expect(queuedTurnCountOf({ type: "result", queued_turn_count: 0 })).toBe(0);
  expect(queuedTurnCountOf({ type: "result", queued_turn_count: 2 })).toBe(2);
  expect(queuedTurnCountOf(null)).toBe(0);
});
