import { describe, expect, test } from "bun:test";
import {
  DESIGN_CHANNEL,
  MAX_FRAME_HEIGHT,
  MAX_HTML_CHARS,
  MAX_MESSAGE_BYTES,
  MIN_FRAME_HEIGHT,
  clearSelectionMessage,
  highlightMessage,
  isFromFrame,
  modeMessage,
  parseFrameMessage,
} from "../src/client/lib/design-protocol";

const BOUNDS = { x: 1, y: 2, width: 3, height: 4 };

describe("parseFrameMessage: tipe yang sah", () => {
  test("ready", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "ready", slug: "beranda" })).toEqual({
      channel: DESIGN_CHANNEL,
      type: "ready",
      slug: "beranda",
    });
  });

  test("size", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: 812 })).toEqual({
      channel: DESIGN_CHANNEL,
      type: "size",
      height: 812,
    });
  });

  test("hover", () => {
    expect(
      parseFrameMessage({
        channel: DESIGN_CHANNEL,
        type: "hover",
        bounds: BOUNDS,
        tag: "button",
        label: "Tombol",
      }),
    ).toEqual({
      channel: DESIGN_CHANNEL,
      type: "hover",
      bounds: BOUNDS,
      tag: "button",
      label: "Tombol",
    });
  });

  test("select", () => {
    const pesan = parseFrameMessage({
      channel: DESIGN_CHANNEL,
      type: "select",
      selector: "#a",
      tag: "div",
      text: "Halo",
      html: "<div>Halo</div>",
      bounds: BOUNDS,
      style: { color: "red", display: "block" },
    });
    expect(pesan).toEqual({
      channel: DESIGN_CHANNEL,
      type: "select",
      selector: "#a",
      tag: "div",
      text: "Halo",
      html: "<div>Halo</div>",
      bounds: BOUNDS,
      style: { color: "red", display: "block" },
    });
  });

  test("route", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "route", hash: "#/a" })).toEqual({
      channel: DESIGN_CHANNEL,
      type: "route",
      hash: "#/a",
    });
  });

  test("wheel", () => {
    expect(
      parseFrameMessage({
        channel: DESIGN_CHANNEL,
        type: "wheel",
        deltaX: 1,
        deltaY: 2,
        ctrlKey: true,
        clientX: 3,
        clientY: 4,
      }),
    ).toEqual({
      channel: DESIGN_CHANNEL,
      type: "wheel",
      deltaX: 1,
      deltaY: 2,
      ctrlKey: true,
      clientX: 3,
      clientY: 4,
    });
  });

  test("pan", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pan", dx: 5, dy: -5 })).toEqual({
      channel: DESIGN_CHANNEL,
      type: "pan",
      dx: 5,
      dy: -5,
    });
  });
});

describe("parseFrameMessage: penolakan", () => {
  test("bukan objek", () => {
    expect(parseFrameMessage(null)).toBeUndefined();
    expect(parseFrameMessage("x")).toBeUndefined();
    expect(parseFrameMessage(42)).toBeUndefined();
    expect(parseFrameMessage([1, 2])).toBeUndefined();
  });

  test("channel salah", () => {
    expect(parseFrameMessage({ channel: "lain", type: "ready", slug: "a" })).toBeUndefined();
  });

  test("type tak dikenal", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "hapus" })).toBeUndefined();
  });

  test("NaN dan Infinity ditolak", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: NaN })).toBeUndefined();
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: Infinity }),
    ).toBeUndefined();
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pan", dx: NaN, dy: 0 }),
    ).toBeUndefined();
  });

  test("bounds kurang", () => {
    expect(
      parseFrameMessage({
        channel: DESIGN_CHANNEL,
        type: "hover",
        bounds: { x: 1, y: 2, width: 3 },
        tag: "div",
        label: "Grup",
      }),
    ).toBeUndefined();
  });

  test("pesan lebih dari 64 KB ditolak", () => {
    const besar = "a".repeat(MAX_MESSAGE_BYTES + 10);
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "select", selector: besar }),
    ).toBeUndefined();
  });

  test("objek siklik tidak melempar", () => {
    const siklik: Record<string, unknown> = { channel: DESIGN_CHANNEL, type: "ready" };
    siklik.self = siklik;
    expect(() => parseFrameMessage(siklik)).not.toThrow();
    expect(parseFrameMessage(siklik)).toBeUndefined();
  });
});

describe("parseFrameMessage: pemotongan dan penjepitan", () => {
  test("html dipotong 2048", () => {
    const pesan = parseFrameMessage({
      channel: DESIGN_CHANNEL,
      type: "select",
      selector: "#a",
      tag: "div",
      text: "x",
      html: "h".repeat(5000),
      bounds: BOUNDS,
      style: {},
    });
    expect(pesan?.type).toBe("select");
    if (pesan?.type === "select") expect(pesan.html.length).toBe(MAX_HTML_CHARS);
  });

  test("height dijepit 200..6000 dan dibulatkan", () => {
    const rendah = parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: 10 });
    const tinggi = parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: 99999 });
    const pecahan = parseFrameMessage({ channel: DESIGN_CHANNEL, type: "size", height: 812.6 });
    if (rendah?.type === "size") expect(rendah.height).toBe(MIN_FRAME_HEIGHT);
    if (tinggi?.type === "size") expect(tinggi.height).toBe(MAX_FRAME_HEIGHT);
    if (pecahan?.type === "size") expect(pecahan.height).toBe(813);
  });

  test("style kunci asing dibuang", () => {
    const pesan = parseFrameMessage({
      channel: DESIGN_CHANNEL,
      type: "select",
      selector: "#a",
      tag: "div",
      text: "x",
      html: "<div></div>",
      bounds: BOUNDS,
      style: { color: "red", rahasia: "x", display: 5 },
    });
    if (pesan?.type === "select") expect(pesan.style).toEqual({ color: "red" });
  });
});

describe("isFromFrame", () => {
  test("hanya sumber yang sama", () => {
    const jendela = {};
    expect(isFromFrame({ source: jendela }, jendela)).toBe(true);
    expect(isFromFrame({ source: {} }, jendela)).toBe(false);
    expect(isFromFrame({ source: jendela }, null)).toBe(false);
  });
});

describe("pembuat pesan", () => {
  test("mode, clear-selection, highlight", () => {
    expect(modeMessage("select")).toEqual({ channel: DESIGN_CHANNEL, type: "mode", tool: "select" });
    expect(clearSelectionMessage()).toEqual({ channel: DESIGN_CHANNEL, type: "clear-selection" });
    expect(highlightMessage("x".repeat(600))).toEqual({
      channel: DESIGN_CHANNEL,
      type: "highlight",
      selector: "x".repeat(500),
    });
  });
});
