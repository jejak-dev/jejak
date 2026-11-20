import { describe, expect, test } from "bun:test";
import {
  DESIGN_CHANNEL,
  MAX_FRAME_HEIGHT,
  MAX_HTML_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SHOT_CHARS,
  MIN_FRAME_HEIGHT,
  SHOT_DATA_URL_PREFIX,
  captureMessage,
  sceneMessage,
  clearSelectionMessage,
  highlightMessage,
  isFromFrame,
  modeMessage,
  parseFrameMessage,
  pinsMessage,
} from "../src/client/lib/design-protocol";

const BOUNDS = { x: 1, y: 2, width: 3, height: 4 };
const PNG_KECIL = `${SHOT_DATA_URL_PREFIX}iVBORw0KGgo=`;

function shot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: DESIGN_CHANNEL,
    type: "shot",
    id: "tangkapan-1",
    width: 800,
    height: 600,
    dataUrl: PNG_KECIL,
    ...extra,
  };
}

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

describe("parseFrameMessage: shot dan shot-error", () => {
  test("shot sah", () => {
    expect(parseFrameMessage(shot())).toEqual({
      channel: DESIGN_CHANNEL,
      type: "shot",
      id: "tangkapan-1",
      width: 800,
      height: 600,
      dataUrl: PNG_KECIL,
    });
  });

  test("dataUrl bukan PNG ditolak", () => {
    expect(parseFrameMessage(shot({ dataUrl: "data:image/jpeg;base64,abcd" }))).toBeUndefined();
    expect(parseFrameMessage(shot({ dataUrl: "data:image/png,abcd" }))).toBeUndefined();
  });

  test("dataUrl berisi karakter non-base64 ditolak", () => {
    expect(parseFrameMessage(shot({ dataUrl: `${SHOT_DATA_URL_PREFIX}ab cd` }))).toBeUndefined();
    expect(parseFrameMessage(shot({ dataUrl: `${SHOT_DATA_URL_PREFIX}ab!cd` }))).toBeUndefined();
    expect(parseFrameMessage(shot({ dataUrl: `${SHOT_DATA_URL_PREFIX}ab==cd` }))).toBeUndefined();
  });

  test("dataUrl terlalu panjang ditolak", () => {
    expect(
      parseFrameMessage(shot({ dataUrl: `${SHOT_DATA_URL_PREFIX}${"A".repeat(MAX_SHOT_CHARS)}` })),
    ).toBeUndefined();
  });

  test("id tak sah ditolak", () => {
    expect(parseFrameMessage(shot({ id: "" }))).toBeUndefined();
    expect(parseFrameMessage(shot({ id: "a".repeat(65) }))).toBeUndefined();
    expect(parseFrameMessage(shot({ id: "ada spasi" }))).toBeUndefined();
    expect(parseFrameMessage(shot({ id: 5 }))).toBeUndefined();
  });

  test("width/height di luar rentang ditolak", () => {
    expect(parseFrameMessage(shot({ width: 0 }))).toBeUndefined();
    expect(parseFrameMessage(shot({ width: 8193 }))).toBeUndefined();
    expect(parseFrameMessage(shot({ height: 1.5 }))).toBeUndefined();
    expect(parseFrameMessage(shot({ height: NaN }))).toBeUndefined();
  });

  test("pesan shot besar tidak ditolak batas 64 KB", () => {
    const besar = `${SHOT_DATA_URL_PREFIX}${"A".repeat(200_000)}`;
    const pesan = parseFrameMessage(shot({ dataUrl: besar }));
    expect(pesan?.type).toBe("shot");
    if (pesan?.type === "shot") expect(pesan.dataUrl.length).toBe(besar.length);
  });

  test("shot-error sah dan tak sah", () => {
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "shot-error", id: "x", reason: "tainted" }),
    ).toEqual({ channel: DESIGN_CHANNEL, type: "shot-error", id: "x", reason: "tainted" });
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "shot-error", id: "x", reason: "besok" }),
    ).toBeUndefined();
    expect(
      parseFrameMessage({ channel: DESIGN_CHANNEL, type: "shot-error", id: "", reason: "failed" }),
    ).toBeUndefined();
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

  test("capture: id sah, skala bawaan 1", () => {
    expect(captureMessage("abc_123-XYZ")).toEqual({
      channel: DESIGN_CHANNEL,
      type: "capture",
      id: "abc_123-XYZ",
      scale: 1,
    });
    expect(captureMessage("a")).toEqual({ channel: DESIGN_CHANNEL, type: "capture", id: "a", scale: 1 });
  });

  test("capture: skala 2", () => {
    expect(captureMessage("id", 2)).toEqual({
      channel: DESIGN_CHANNEL,
      type: "capture",
      id: "id",
      scale: 2,
    });
  });

  test("capture: id tak sah menghasilkan undefined", () => {
    expect(captureMessage("")).toBeUndefined();
    expect(captureMessage("a".repeat(65))).toBeUndefined();
    expect(captureMessage("ada spasi")).toBeUndefined();
    expect(captureMessage("salah!")).toBeUndefined();
  });
});

describe("pinsMessage", () => {
  const PIN = { id: "c_1", selector: '[id="judul"]', n: 1, done: false };

  test("pin sah diteruskan apa adanya", () => {
    expect(pinsMessage([PIN])).toEqual({
      channel: DESIGN_CHANNEL,
      type: "pins",
      pins: [{ id: "c_1", selector: '[id="judul"]', n: 1, done: false }],
    });
  });

  test("daftar kosong sah", () => {
    expect(pinsMessage([])).toEqual({ channel: DESIGN_CHANNEL, type: "pins", pins: [] });
  });

  test("id, selector, n, dan done tak sah dibuang", () => {
    const hasil = pinsMessage([
      { ...PIN, id: "ada spasi" },
      { ...PIN, id: "a".repeat(65) },
      { ...PIN, selector: "" },
      { ...PIN, selector: "x".repeat(501) },
      { ...PIN, n: 0 },
      { ...PIN, n: 1000 },
      { ...PIN, n: 1.5 },
      { ...PIN, done: "ya" as unknown as boolean },
      PIN,
    ]);
    expect(hasil).toEqual({
      channel: DESIGN_CHANNEL,
      type: "pins",
      pins: [{ id: "c_1", selector: '[id="judul"]', n: 1, done: false }],
    });
  });

  test("maksimal 50 pin, sisanya dibuang", () => {
    const banyak = Array.from({ length: 60 }, (_, i) => ({
      id: `c_${i}`,
      selector: "#a",
      n: (i % 999) + 1,
      done: false,
    }));
    const hasil = pinsMessage(banyak);
    if (hasil.type !== "pins") throw new Error("tipe salah");
    expect(hasil.pins).toHaveLength(50);
    expect(hasil.pins[49]!.id).toBe("c_49");
  });
});

describe("parseFrameMessage: pin", () => {
  test("pin sah", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pin", id: "c_1" })).toEqual({
      channel: DESIGN_CHANNEL,
      type: "pin",
      id: "c_1",
    });
  });

  test("pin tak sah ditolak", () => {
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pin", id: "" })).toBeUndefined();
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pin", id: "ada spasi" })).toBeUndefined();
    expect(parseFrameMessage({ channel: DESIGN_CHANNEL, type: "pin" })).toBeUndefined();
    expect(parseFrameMessage({ channel: "lain", type: "pin", id: "c_1" })).toBeUndefined();
  });
});

describe("pesan scene (ekspor Figma)", () => {
  test("sceneMessage membentuk pesan dan menolak id tak sah", () => {
    expect(sceneMessage("fig-beranda")).toEqual({
      channel: DESIGN_CHANNEL,
      type: "scene",
      id: "fig-beranda",
    });
    expect(sceneMessage("ada spasi")).toBeUndefined();
  });

  test("parseFrameMessage menerima scene sah dan menolak yang cacat", () => {
    const sah = {
      channel: DESIGN_CHANNEL,
      type: "scene",
      id: "fig-a",
      width: 1440,
      height: 900,
      root: { kind: "box", name: "body" },
    };
    expect(parseFrameMessage(sah)).toEqual(sah as unknown as ReturnType<typeof parseFrameMessage>);
    expect(parseFrameMessage({ ...sah, id: "tak sah!" })).toBeUndefined();
    expect(parseFrameMessage({ ...sah, width: 0 })).toBeUndefined();
    expect(parseFrameMessage({ ...sah, height: 9000 })).toBeUndefined();
    expect(parseFrameMessage({ ...sah, root: "bukan objek" })).toBeUndefined();
    expect(parseFrameMessage({ ...sah, root: [] })).toBeUndefined();
  });
});
