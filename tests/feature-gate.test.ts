import { describe, expect, test } from "bun:test";
import { FeatureGate } from "../src/server/features/feature-gate";

interface Palsu {
  id: number;
  ditutup: boolean;
}

function gerbang(): {
  gate: FeatureGate<Palsu>;
  dibuat: number[];
  ditutup: number[];
} {
  const dibuat: number[] = [];
  const ditutup: number[] = [];
  let nomor = 0;
  const gate = new FeatureGate<Palsu>({
    create: () => {
      nomor += 1;
      dibuat.push(nomor);
      return { id: nomor, ditutup: false };
    },
    close: (manager) => {
      manager.ditutup = true;
      ditutup.push(manager.id);
    },
  });
  return { gate, dibuat, ditutup };
}

describe("FeatureGate", () => {
  test("mati secara default: get() mengembalikan undefined", () => {
    const { gate, dibuat } = gerbang();
    expect(gate.isEnabled).toBe(false);
    expect(gate.get()).toBeUndefined();
    expect(dibuat).toEqual([]);
  });

  test("menyalakan membuat manajer sekali", () => {
    const { gate, dibuat } = gerbang();
    gate.enable();
    const pertama = gate.get();
    const kedua = gate.get();
    expect(pertama).toBeDefined();
    expect(kedua).toBe(pertama);
    expect(dibuat).toEqual([1]);
  });

  test("disable() menutup manajer dan melepasnya", async () => {
    const { gate, ditutup } = gerbang();
    gate.enable();
    const manager = gate.get()!;
    await gate.disable();
    expect(ditutup).toEqual([manager.id]);
    expect(manager.ditutup).toBe(true);
    expect(gate.isEnabled).toBe(false);
  });

  test("get() setelah dimatikan mengembalikan undefined", async () => {
    const { gate, dibuat } = gerbang();
    gate.enable();
    gate.get();
    await gate.disable();
    expect(gate.get()).toBeUndefined();
    expect(dibuat).toEqual([1]);
  });

  test("menyalakan lagi membuat manajer baru", async () => {
    const { gate, dibuat, ditutup } = gerbang();
    gate.enable();
    const lama = gate.get()!;
    await gate.disable();
    gate.enable();
    const baru = gate.get()!;
    expect(baru).not.toBe(lama);
    expect(dibuat).toEqual([1, 2]);
    expect(ditutup).toEqual([lama.id]);
  });

  test("disable() tanpa manajer tidak melempar", async () => {
    const { gate, ditutup } = gerbang();
    await gate.disable();
    expect(ditutup).toEqual([]);
  });

  test("shutdown() menutup manajer yang masih hidup", async () => {
    const { gate, ditutup } = gerbang();
    gate.enable();
    gate.get();
    await gate.shutdown();
    expect(ditutup).toEqual([1]);
    expect(gate.get()).toBeUndefined();
  });
});
