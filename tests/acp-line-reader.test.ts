import { describe, expect, test } from "bun:test";
import { createLineParser } from "../src/server/acp/line-reader";

describe("createLineParser", () => {
  test("potongan terbelah di tengah JSON ditahan sampai lengkap", () => {
    const pesan: unknown[] = [];
    const parse = createLineParser((msg) => pesan.push(msg));
    parse('{"id":1,"res');
    expect(pesan).toHaveLength(0);
    parse('ult":{"ok":true}}\n');
    expect(pesan).toEqual([{ id: 1, result: { ok: true } }]);
  });

  test("beberapa pesan dalam satu potongan", () => {
    const pesan: unknown[] = [];
    const parse = createLineParser((msg) => pesan.push(msg));
    parse('{"a":1}\n{"b":2}\n');
    expect(pesan).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("baris \\r\\n terurai, termasuk bila terbelah antar potongan", () => {
    const pesan: unknown[] = [];
    const parse = createLineParser((msg) => pesan.push(msg));
    parse('{"a":1}\r');
    parse('\n{"b":2}\r\n');
    expect(pesan).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("baris bukan JSON dilewati dan dilaporkan, tak melempar", () => {
    const pesan: unknown[] = [];
    const dilewati: string[] = [];
    const parse = createLineParser(
      (msg) => pesan.push(msg),
      (line) => dilewati.push(line),
    );
    expect(() => parse('plugin: log biasa\n{"a":1}\n')).not.toThrow();
    expect(dilewati).toEqual(["plugin: log biasa"]);
    expect(pesan).toEqual([{ a: 1 }]);
  });

  test("baris kosong diabaikan", () => {
    const pesan: unknown[] = [];
    const dilewati: string[] = [];
    const parse = createLineParser(
      (msg) => pesan.push(msg),
      (line) => dilewati.push(line),
    );
    parse('\n\r\n   \n{"a":1}\n');
    expect(pesan).toEqual([{ a: 1 }]);
    expect(dilewati).toEqual([]);
  });

  test("galat dari penerima pesan tidak ditelan sebagai baris rusak", () => {
    const dilewati: string[] = [];
    const parse = createLineParser(
      () => {
        throw new Error("penerima rusak");
      },
      (line) => dilewati.push(line),
    );
    expect(() => parse('{"a":1}\n')).toThrow("penerima rusak");
    expect(dilewati).toEqual([]);
  });
});
