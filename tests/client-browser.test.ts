import { describe, expect, test } from "bun:test";
import {
  BROWSER_DISABLED_MESSAGE,
  browserErrorText,
  browserFrameUrl,
  browserStatusText,
  browserView,
  fitFrameSize,
  parseBrowserEvent,
  parseBrowserFrame,
  parseBrowserState,
} from "../src/client/lib/browser";

describe("parseBrowserEvent", () => {
  test("peristiwa state dan frame diterjemahkan", () => {
    const state = parseBrowserEvent(
      "state",
      JSON.stringify({ status: "menyala", url: "https://a.test", title: "A" }),
    );
    expect(state).toEqual({
      kind: "state",
      state: {
        status: "menyala",
        url: "https://a.test",
        title: "A",
        canGoBack: false,
        canGoForward: false,
      },
    });

    const frame = parseBrowserEvent(
      "frame",
      JSON.stringify({ data: "aW1n", width: 1280, height: 800 }),
    );
    expect(frame).toEqual({ kind: "frame", frame: { data: "aW1n", width: 1280, height: 800 } });
  });

  test("peristiwa asing dan data rusak diabaikan", () => {
    expect(parseBrowserEvent("ping", "{}")).toBeUndefined();
    expect(parseBrowserEvent("state", "{bukan json")).toBeUndefined();
    expect(parseBrowserEvent("state", JSON.stringify({ status: "aneh" }))).toBeUndefined();
    expect(parseBrowserEvent("frame", JSON.stringify({ data: "" }))).toBeUndefined();
  });
});

describe("parseBrowserState dan parseBrowserFrame", () => {
  test("bentuk asing ditolak", () => {
    expect(parseBrowserState(undefined)).toBeUndefined();
    expect(parseBrowserState({ status: "menyala" })).toBeDefined();
    expect(parseBrowserState("bukan objek")).toBeUndefined();
    expect(parseBrowserFrame({ data: "x" })?.width).toBe(0);
    expect(parseBrowserFrame({})).toBeUndefined();
  });
});

describe("browserFrameUrl", () => {
  test("menambahkan prefiks data JPEG", () => {
    expect(browserFrameUrl("aW1n")).toBe("data:image/jpeg;base64,aW1n");
  });
});

describe("fitFrameSize", () => {
  test("lebar mengikuti panel dan rasio tetap", () => {
    const size = fitFrameSize({ width: 1280, height: 800 }, { width: 300, height: 0 });
    expect(size.width).toBe(300);
    expect(size.height).toBe(188);
  });

  test("tinggi dibatasi panel dengan rasio tetap", () => {
    const size = fitFrameSize({ width: 1280, height: 800 }, { width: 800, height: 200 });
    expect(size.height).toBe(200);
    expect(size.width).toBe(320);
  });

  test("ukuran tak dikenal memakai rasio bawaan", () => {
    const size = fitFrameSize({ width: 0, height: 0 }, { width: 200, height: 0 });
    expect(size.width).toBe(200);
    expect(size.height).toBe(125);
  });
});

describe("browserErrorText", () => {
  test("503 memakai pesan baku", () => {
    expect(browserErrorText(503, "apa saja")).toBe(BROWSER_DISABLED_MESSAGE);
  });

  test("pesan server dipakai apa adanya", () => {
    expect(browserErrorText(404, "Chrome atau Chromium tidak ditemukan.")).toBe(
      "Chrome atau Chromium tidak ditemukan.",
    );
  });

  test("pesan kosong memakai bawaan", () => {
    expect(browserErrorText(404, "")).toBe("Chrome atau Chromium tidak ditemukan.");
    expect(browserErrorText(409, undefined)).toBe("Browser sudah mati.");
    expect(browserErrorText(undefined, undefined)).toBe("Permintaan gagal.");
  });
});

describe("browserView", () => {
  test("status 503 berarti browser mati", () => {
    const view = browserView({ status: 503, adaFrame: false });
    expect(view.kind).toBe("mati");
    expect(view.pesan).toBe(BROWSER_DISABLED_MESSAGE);
  });

  test("pesan galat ditampilkan", () => {
    const view = browserView({
      status: 404,
      message: "Chrome atau Chromium tidak ditemukan.",
      adaFrame: false,
    });
    expect(view.kind).toBe("galat");
    expect(view.pesan).toBe("Chrome atau Chromium tidak ditemukan.");
  });

  test("menunggu frame sebelum frame datang", () => {
    const view = browserView({ adaFrame: false });
    expect(view.kind).toBe("menunggu");
    expect(view.pesan).toBe("Menunggu frame pertama…");
  });

  test("siap setelah frame datang", () => {
    const view = browserView({ adaFrame: true });
    expect(view.kind).toBe("siap");
  });
});

describe("browserStatusText", () => {
  test("judul, url, atau status mati", () => {
    expect(
      browserStatusText({ status: "menyala", url: "https://a.test", title: "Judul", canGoBack: false, canGoForward: false }),
    ).toBe("Judul");
    expect(
      browserStatusText({ status: "menyala", url: "https://a.test", title: "", canGoBack: false, canGoForward: false }),
    ).toBe("https://a.test");
    expect(
      browserStatusText({ status: "mati", url: "", title: "", canGoBack: false, canGoForward: false }),
    ).toBe("Browser mati");
    expect(browserStatusText(undefined)).toBe("");
  });
});
