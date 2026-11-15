import { describe, expect, test } from "bun:test";
import {
  InputBatcher,
  browserRenderPlan,
  browserSendInput,
  browserSetViewport,
  canvasToPage,
  clampViewportSize,
  copySelectionToClipboard,
  keyEventFrom,
  modifiersOf,
  mouseEventFrom,
  textEvent,
  type BrowserCanvasRect,
  type BrowserInputEvent,
  type BrowserKeySource,
  type BrowserMouseSource,
  type BrowserViewportInfo,
} from "../src/client/lib/browser";

/* ---------- Bantuan ---------- */

const VIEWPORT: BrowserViewportInfo = { width: 1000, height: 500 };

const RECT: BrowserCanvasRect = { left: 10, top: 20, width: 500, height: 250 };

function sumberKey(over: Partial<BrowserKeySource> = {}): BrowserKeySource {
  return {
    type: "keydown",
    key: "a",
    code: "KeyA",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    keyCode: 65,
    ...over,
  };
}

function sumberMouse(over: Partial<BrowserMouseSource> = {}): BrowserMouseSource {
  return {
    clientX: 10,
    clientY: 20,
    button: 0,
    buttons: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...over,
  };
}

interface JamPalsu {
  now: () => number;
  maju(ms: number): void;
}

/** Jam palsu (waktu ms) buat menguji batas laju. */
function jamPalsu(): JamPalsu {
  let waktu = 1_000_000;
  return {
    now: (): number => waktu,
    maju: (ms: number): void => {
      waktu += ms;
    },
  };
}

interface JadwalPalsu {
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** Jalankan satu tick penjadwac terakhir. */
  jalankan(): void;
  /** Jumlah tick yang dijadwalkan. */
  readonly jumlah: number;
  /** Tunda terakhir yang dipakai (ms). */
  readonly tunda: number;
}

/** Penjadwac palsu: tick dijalankan manual. */
function jadwalPalsu(): JadwalPalsu {
  let tertunda: (() => void) | undefined;
  let jumlah = 0;
  let tunda = 0;
  return {
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      tertunda = callback;
      jumlah += 1;
      tunda = delayMs;
      return (): void => {
        tertunda = undefined;
      };
    },
    jalankan: (): void => {
      const callback = tertunda;
      tertunda = undefined;
      callback?.();
    },
    get jumlah(): number {
      return jumlah;
    },
    get tunda(): number {
      return tunda;
    },
  };
}

interface ClipboardPalsu {
  writeText(text: string): Promise<void>;
  isi: string[];
}

/** Clipboard palsu yang mencatat isi. */
function clipboardPalsu(gagal = false): ClipboardPalsu {
  const isi: string[] = [];
  return {
    isi,
    writeText: async (text: string): Promise<void> => {
      if (gagal) throw new Error("ditolak");
      isi.push(text);
    },
  };
}

function fetchPalsu(
  jawaban: () => Response,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return jawaban();
  };
  return { fetch: impl as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ---------- canvasToPage ---------- */

describe("canvasToPage", () => {
  test("koordinat CSS kanvas jadi koordinat halaman", () => {
    expect(canvasToPage(10, 20, RECT, VIEWPORT)).toEqual({ x: 0, y: 0 });
    expect(canvasToPage(260, 145, RECT, VIEWPORT)).toEqual({ x: 500, y: 250 });
  });

  test("koordinat diklem ke area tampilan", () => {
    expect(canvasToPage(-100, -50, RECT, VIEWPORT)).toEqual({ x: 0, y: 0 });
    expect(canvasToPage(9999, 9999, RECT, VIEWPORT)).toEqual({ x: 1000, y: 500 });
  });

  test("hasil dibulatkan dan ukuran 1:1 tak berubah", () => {
    const kecil: BrowserCanvasRect = { left: 0, top: 0, width: 300, height: 150 };
    expect(canvasToPage(100, 50, kecil, { width: 300, height: 150 })).toEqual({ x: 100, y: 50 });
    // Skala 10/3 menghasilkan pecahan yang dibulatkan.
    expect(canvasToPage(1, 2, { left: 0, top: 0, width: 3, height: 3 }, { width: 10, height: 10 })).toEqual({
      x: 3,
      y: 7,
    });
  });
});

/* ---------- modifiersOf ---------- */

describe("modifiersOf", () => {
  test("bitmask modifier CDP", () => {
    expect(modifiersOf({})).toBe(0);
    expect(modifiersOf({ altKey: true })).toBe(1);
    expect(modifiersOf({ ctrlKey: true })).toBe(2);
    expect(modifiersOf({ metaKey: true })).toBe(4);
    expect(modifiersOf({ shiftKey: true })).toBe(8);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

/* ---------- keyEventFrom ---------- */

describe("keyEventFrom", () => {
  test("huruf bringka teks yang dicetak", () => {
    const hasil = keyEventFrom(sumberKey());
    expect(hasil).toEqual({
      kind: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
      keyCode: 65,
    });
  });

  test("Enter dan panah tak membawa teks", () => {
    const enter = keyEventFrom(sumberKey({ key: "Enter", code: "Enter", keyCode: 13 }));
    expect(enter?.type).toBe("down");
    expect(enter?.text).toBeUndefined();
    const panah = keyEventFrom(sumberKey({ key: "ArrowUp", code: "ArrowUp", keyCode: 38 }));
    expect(panah?.key).toBe("ArrowUp");
    expect(panah?.text).toBeUndefined();
  });

  test("Shift menghasilkan huruf besar dan bitmask shift", () => {
    const hasil = keyEventFrom(sumberKey({ key: "A", code: "KeyA", shiftKey: true, keyCode: 65 }));
    expect(hasil?.text).toBe("A");
    expect(hasil?.modifiers).toBe(8);
  });

  test("Cmd/Ctrl+C dan Cmd/Ctrl+V tak diteruskan sebagai tombol", () => {
    expect(keyEventFrom(sumberKey({ key: "c", code: "KeyC", metaKey: true }))).toBeUndefined();
    expect(keyEventFrom(sumberKey({ key: "c", code: "KeyC", ctrlKey: true }))).toBeUndefined();
    expect(keyEventFrom(sumberKey({ key: "v", code: "KeyV", metaKey: true }))).toBeUndefined();
    expect(keyEventFrom(sumberKey({ key: "V", code: "KeyV", ctrlKey: true }))).toBeUndefined();
  });

  test("tombol lain tetap diteruskan", () => {
    const hasil = keyEventFrom(sumberKey({ key: "c", code: "KeyC" }));
    expect(hasil?.key).toBe("c");
    const escape = keyEventFrom(sumberKey({ key: "Escape", code: "Escape", keyCode: 27 }));
    expect(escape?.key).toBe("Escape");
  });

  test("keyup tak membawa teks", () => {
    const hasil = keyEventFrom(sumberKey({ type: "keyup" }));
    expect(hasil?.type).toBe("up");
    expect(hasil?.text).toBeUndefined();
  });

  test("jenis event lain ditolak", () => {
    expect(keyEventFrom(sumberKey({ type: "keypress" }))).toBeUndefined();
  });
});

/* ---------- mouseEventFrom ---------- */

describe("mouseEventFrom", () => {
  test("klik kiri dan kanan memakai koordinat halaman", () => {
    const kiri = mouseEventFrom("down", sumberMouse({ clientX: 10, clientY: 20 }), RECT, VIEWPORT);
    expect(kiri.kind).toBe("mouse");
    expect(kiri.type).toBe("down");
    expect(kiri.x).toBe(0);
    expect(kiri.y).toBe(0);
    expect(kiri.button).toBe("left");
    const kanan = mouseEventFrom("down", sumberMouse({ button: 2 }), RECT, VIEWPORT);
    expect(kanan.button).toBe("right");
    const tengah = mouseEventFrom("down", sumberMouse({ button: 1 }), RECT, VIEWPORT);
    expect(tengah.button).toBe("middle");
  });

  test("gerak tanpa tombol ditekan berarti none, dengan tombol berarti kiri", () => {
    const hover = mouseEventFrom("move", sumberMouse({ buttons: 0 }), RECT, VIEWPORT);
    expect(hover.button).toBe("none");
    const seret = mouseEventFrom("move", sumberMouse({ buttons: 1 }), RECT, VIEWPORT);
    expect(seret.button).toBe("left");
  });

  test("gulir memakai deltaX dan deltaY", () => {
    const hasil = mouseEventFrom(
      "wheel",
      sumberMouse({ deltaX: 3, deltaY: -12 }),
      RECT,
      VIEWPORT,
    );
    expect(hasil.type).toBe("wheel");
    expect(hasil.button).toBe("none");
    expect(hasil.deltaX).toBe(3);
    expect(hasil.deltaY).toBe(-12);
  });

  test("jumlah klik diteruskan bila ada", () => {
    const hasil = mouseEventFrom("up", sumberMouse(), RECT, VIEWPORT, 2);
    expect(hasil.clickCount).toBe(2);
    const tanpa = mouseEventFrom("up", sumberMouse(), RECT, VIEWPORT);
    expect(tanpa.clickCount).toBeUndefined();
  });

  test("modifier diteruskan ke bitmask", () => {
    const hasil = mouseEventFrom("down", sumberMouse({ metaKey: true }), RECT, VIEWPORT);
    expect(hasil.modifiers).toBe(4);
  });
});

/* ---------- InputBatcher ---------- */

describe("InputBatcher", () => {
  test("gerak berturut-turut digabung dan yang terakhir dipakai", () => {
    const terkirim: BrowserInputEvent[][] = [];
    const batcher = new InputBatcher({
      send: (events) => terkirim.push(events),
      now: (): number => 0,
      schedule: jadwalPalsu().schedule,
    });
    batcher.push(mouseEventFrom("move", sumberMouse({ clientX: 10 }), RECT, VIEWPORT));
    batcher.push(mouseEventFrom("move", sumberMouse({ clientX: 30 }), RECT, VIEWPORT));
    expect(batcher.panjang).toBe(1);
    batcher.flush();
    expect(terkirim.length).toBe(1);
    expect(terkirim[0]?.length).toBe(1);
    expect((terkirim[0]?.[0] as { x: number } | undefined)?.x).toBe(40);
  });

  test("batch dibatasi 100 event per kiriman", () => {
    const terkirim: BrowserInputEvent[][] = [];
    const batcher = new InputBatcher({
      send: (events) => terkirim.push(events),
      now: (): number => 0,
      schedule: jadwalPalsu().schedule,
    });
    for (let index = 0; index < 150; index += 1) {
      batcher.push({
        kind: "key",
        type: "down",
        key: "a",
        code: "KeyA",
        modifiers: 0,
        keyCode: 65,
      });
    }
    batcher.flush();
    expect(terkirim.map((batch) => batch.length)).toEqual([100, 50]);
  });

  test("batas laju membuang gerak tapi tak membuang tombol", () => {
    const terkirim: BrowserInputEvent[][] = [];
    const jam = jamPalsu();
    const batcher = new InputBatcher({
      send: (events) => terkirim.push(events),
      now: jam.now,
      schedule: jadwalPalsu().schedule,
    });
    for (let index = 0; index < 150; index += 1) {
      batcher.push({
        kind: "key",
        type: "down",
        key: "a",
        code: "KeyA",
        modifiers: 0,
        keyCode: 65,
      });
      batcher.push(mouseEventFrom("move", sumberMouse({ clientX: 10 + index }), RECT, VIEWPORT));
    }
    batcher.flush();
    const semua = terkirim.flat();
    const tombol = semua.filter((event) => event.kind === "key");
    const gerak = semua.filter((event) => event.kind === "mouse");
    // Semua tombol terkirim; gerakan dibuang saat laju terlampaui.
    expect(tombol.length).toBe(150);
    expect(gerak.length).toBeLessThan(150);
    // Jendela laju baru terbuka setelah satu detik.
    jam.maju(1000);
    terkirim.length = 0;
    batcher.push(mouseEventFrom("move", sumberMouse(), RECT, VIEWPORT));
    batcher.flush();
    expect(terkirim.flat().length).toBe(1);
  });

  test("peristiwa dikirim pada tick penjadwac", () => {
    const terkirim: BrowserInputEvent[][] = [];
    const jadwal = jadwalPalsu();
    const batcher = new InputBatcher({
      send: (events) => terkirim.push(events),
      now: (): number => 0,
      schedule: jadwal.schedule,
    });
    batcher.push({
      kind: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      keyCode: 65,
    });
    expect(jadwal.tunda).toBe(16);
    expect(terkirim.length).toBe(0);
    jadwal.jalankan();
    expect(terkirim.length).toBe(1);
    expect(terkirim[0]?.length).toBe(1);
  });

  test("dispose membuang antrean dan membatalkan tick", () => {
    const terkirim: BrowserInputEvent[][] = [];
    const jadwal = jadwalPalsu();
    const batcher = new InputBatcher({
      send: (events) => terkirim.push(events),
      now: (): number => 0,
      schedule: jadwal.schedule,
    });
    batcher.push({
      kind: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      keyCode: 65,
    });
    batcher.dispose();
    expect(batcher.panjang).toBe(0);
    jadwal.jalankan();
    expect(terkirim.length).toBe(0);
    batcher.push({
      kind: "key",
      type: "down",
      key: "b",
      code: "KeyB",
      modifiers: 0,
      keyCode: 66,
    });
    batcher.flush();
    expect(terkirim.length).toBe(0);
  });
});

/* ---------- Salin dan tempel ---------- */

describe("copySelectionToClipboard", () => {
  test("teks pilihan ditulis ke clipboard pengguna", async () => {
    const clipboard = clipboardPalsu();
    const palsu = fetchPalsu(() => json({ text: "halo dunia" }));
    const ok = await copySelectionToClipboard(palsu.fetch, clipboard);
    expect(ok).toBe(true);
    expect(clipboard.isi).toEqual(["halo dunia"]);
    expect(palsu.calls[0]?.url).toBe("/api/browser/copy");
    expect(palsu.calls[0]?.init.method).toBe("POST");
  });

  test("galat server tak sampai ke clipboard dan tak dilempar", async () => {
    const clipboard = clipboardPalsu();
    const palsu = fetchPalsu(() => json({ error: "gagal" }, 500));
    const ok = await copySelectionToClipboard(palsu.fetch, clipboard);
    expect(ok).toBe(false);
    expect(clipboard.isi).toEqual([]);
  });

  test("clipboard yang menolak diabaikan", async () => {
    const clipboard = clipboardPalsu(true);
    const palsu = fetchPalsu(() => json({ text: "halo" }));
    const ok = await copySelectionToClipboard(palsu.fetch, clipboard);
    expect(ok).toBe(false);
  });

  test("pemilih kosong berarti tak ada yang disalin", async () => {
    const clipboard = clipboardPalsu();
    const palsu = fetchPalsu(() => json({ text: "" }));
    const ok = await copySelectionToClipboard(palsu.fetch, clipboard);
    expect(ok).toBe(false);
    expect(clipboard.isi).toEqual([]);
  });
});

describe("textEvent", () => {
  test("teks tempel jadi event text, teks kosong diabaikan", () => {
    expect(textEvent("halo")).toEqual({ kind: "text", text: "halo" });
    expect(textEvent("")).toBeUndefined();
  });
});

describe("browserSendInput", () => {
  test("event dikirim sebagai {events} ke /api/browser/input", async () => {
    const palsu = fetchPalsu(() => json({ status: "menyala" }));
    const ok = await browserSendInput(
      [{ kind: "text", text: "halo" }],
      palsu.fetch,
    );
    expect(ok).toBe(true);
    expect(palsu.calls[0]?.url).toBe("/api/browser/input");
    const body = JSON.parse(String(palsu.calls[0]?.init.body)) as { events: unknown[] };
    expect(body.events.length).toBe(1);
  });

  test("galat tak melempar nilai yang memuat isi input", async () => {
    const palsu = fetchPalsu(() => json({ error: "Event input tidak valid." }, 400));
    const ok = await browserSendInput([{ kind: "text", text: "rahasia" }], palsu.fetch);
    expect(ok).toBe(false);
  });
});

describe("browserSetViewport", () => {
  test("ukuran tampilan dikirim sebagai lebar dan tinggi", async () => {
    const palsu = fetchPalsu(() => json({ status: "menyala" }));
    const ok = await browserSetViewport(800, 600, palsu.fetch);
    expect(ok).toBe(true);
    expect(palsu.calls[0]?.url).toBe("/api/browser/viewport");
    const body = JSON.parse(String(palsu.calls[0]?.init.body)) as { width: number; height: number };
    expect(body.width).toBe(800);
    expect(body.height).toBe(600);
  });
});

describe("clampViewportSize", () => {
  test("ukuran diklem ke batas server", () => {
    expect(clampViewportSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(clampViewportSize(100, 100)).toEqual({ width: 320, height: 240 });
    expect(clampViewportSize(5000, 5000)).toEqual({ width: 1920, height: 1200 });
    expect(clampViewportSize(800.4, 600.6)).toEqual({ width: 800, height: 601 });
  });
});

/* ---------- browserRenderPlan ---------- */

describe("browserRenderPlan", () => {
  test("ukuran tampilan mengikuti ukuran area layar dan gambar mengisi penuh", () => {
    const rencana = browserRenderPlan({ width: 800, height: 600 }, { width: 800, height: 600 });
    expect(rencana.viewport).toEqual({ width: 800, height: 600 });
    expect(rencana.page).toEqual({ width: 800, height: 600 });
    // Skala 1:1; tak ada huruf di tepi.
    expect(rencana.draw).toEqual({ offsetX: 0, offsetY: 0, width: 800, height: 600 });
  });

  test("area lebih besar dari batas server diklem dan gambar contain terpusat", () => {
    const rencana = browserRenderPlan({ width: 1920, height: 1200 }, { width: 2000, height: 1400 });
    expect(rencana.viewport).toEqual({ width: 1920, height: 1200 });
    // Seluruh gambar muat di dalam area dan proporsinya terjaga.
    expect(rencana.draw.width).toBeLessThanOrEqual(2000);
    expect(rencana.draw.height).toBeLessThanOrEqual(1400);
    expect(rencana.draw.width / rencana.draw.height).toBeCloseTo(1920 / 1200, 2);
    // Terpusat: sisa ruang sama di kiri dan kanan, serta di atas dan bawah.
    expect(rencana.draw.offsetX).toBe((2000 - rencana.draw.width) / 2);
    expect(rencana.draw.offsetY).toBe((1400 - rencana.draw.height) / 2);
  });

  test("area sempit diklem ke lebar minimum dan gambar diperkecil", () => {
    const rencana = browserRenderPlan({ width: 320, height: 600 }, { width: 300, height: 600 });
    expect(rencana.viewport).toEqual({ width: 320, height: 600 });
    expect(rencana.draw.width).toBe(300);
    expect(rencana.draw.height).toBe(563);
    expect(rencana.draw.offsetX).toBe(0);
    expect(rencana.draw.offsetY).toBe(19);
  });

  test("sudut gambar dipetakan ke sudut halaman saat klem", () => {
    const rencana = browserRenderPlan({ width: 320, height: 600 }, { width: 300, height: 600 });
    const rect: BrowserCanvasRect = { left: 0, top: 0, width: 300, height: 600 };
    // Sudut kiri atas gambar adalah sudut kiri atas halaman.
    expect(canvasToPage(0, 19, rect, rencana.page, rencana.draw)).toEqual({ x: 0, y: 0 });
    // Sudut kanan bawah gambar adalah sudut kanan bawah halaman.
    expect(canvasToPage(300, 582, rect, rencana.page, rencana.draw)).toEqual({ x: 320, y: 600 });
    // Huruf di tepi tak jadi koordinat halaman; diklem ke tepi halaman.
    expect(canvasToPage(150, 0, rect, rencana.page, rencana.draw)).toEqual({ x: 160, y: 0 });
  });

  test("koordinat mouse memakai kotak gambar", () => {
    const rencana = browserRenderPlan({ width: 320, height: 600 }, { width: 300, height: 600 });
    const rect: BrowserCanvasRect = { left: 0, top: 0, width: 300, height: 600 };
    const event = mouseEventFrom(
      "down",
      { clientX: 300, clientY: 582 },
      rect,
      rencana.page,
      undefined,
      rencana.draw,
    );
    expect(event.x).toBe(320);
    expect(event.y).toBe(600);
  });
});
