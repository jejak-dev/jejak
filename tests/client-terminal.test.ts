import { describe, expect, test } from "bun:test";
import { applyOutput, base64ToText, emptyScreen, keyToInput, MAX_SCREEN_LINES, screenText } from "../src/client/lib/terminal";

const feed = (...chunks: string[]) => screenText(chunks.reduce((screen, chunk) => applyOutput(screen, chunk), emptyScreen()));

describe("applyOutput", () => {
  test("baris, CR menimpa, backspace, tab", () => {
    expect(feed("satu\r\ndua\r\n")).toBe("satu\ndua\n");
    expect(feed("abc\rXY")).toBe("XYc");
    expect(feed("abc\b\bX")).toBe("aXc");
    expect(feed("a\tb")).toBe("a       b");
  });

  test("SGR dan OSC dibuang, termasuk yang terpotong antar-chunk", () => {
    expect(feed("\x1b[1;32mhijau\x1b[0m biasa")).toBe("hijau biasa");
    expect(feed("\x1b]0;judul\x07teks")).toBe("teks");
    expect(feed("\x1b[3", "1mmerah\x1b[0m")).toBe("merah");
    expect(feed("\x1b", "[0mx")).toBe("x");
    expect(feed("\x1b]0;jud", "ul\x07y")).toBe("y");
  });

  test("EL, kursor, hapus/sisip karakter, bersihkan layar", () => {
    expect(feed("abcdef\x1b[3D\x1b[K")).toBe("abc");
    expect(feed("abcdef\x1b[2D\x1b[1P")).toBe("abcdf");
    expect(feed("ac\x1b[1D\x1b[1@b")).toBe("abc");
    expect(feed("x\ny\x1b[2Jz")).toBe("z");
    expect(feed("abc\x1b[2G\x1b[0K")).toBe("a");
  });

  test("batas baris dan masukan tidak dimutasi", () => {
    const base = emptyScreen();
    const next = applyOutput(base, "a\nb\n");
    expect(base.lines).toEqual([]);
    expect(next.lines).toEqual(["a", "b"]);
    const big = applyOutput(emptyScreen(), "x\n".repeat(MAX_SCREEN_LINES + 10));
    expect(big.lines).toHaveLength(MAX_SCREEN_LINES);
  });
});

describe("keyToInput", () => {
  const k = (key: string, extra: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    keyToInput({ key, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  test("karakter, kontrol, panah, tombol khusus", () => {
    expect(k("a")).toBe("a");
    expect(k("Enter")).toBe("\r");
    expect(k("Backspace")).toBe("\x7f");
    expect(k("c", { ctrlKey: true })).toBe("\x03");
    expect(k("d", { ctrlKey: true })).toBe("\x04");
    expect(k("ArrowUp")).toBe("\x1b[A");
    expect(k("f", { altKey: true })).toBe("\x1bf");
    expect(k("Shift")).toBeUndefined();
    expect(k("c", { metaKey: true })).toBeUndefined();
  });
});

test("base64ToText mengurai UTF-8", () => {
  expect(base64ToText(Buffer.from("héllo ✓").toString("base64"))).toBe("héllo ✓");
});

import { createApiClient } from "../src/client/lib/api";
import { parsePanelPrefs } from "../src/client/lib/panel-prefs";

describe("ApiClient terminal dan panel", () => {
  test("metode dan jalur", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ id: "t1", cwd: "/p", cols: 100, rows: 28, createdAt: "x", exited: false }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const api = createApiClient({ fetch: fetchImpl });
    expect((await api.createTerminal("/p", { cols: 100, rows: 28 })).id).toBe("t1");
    await api.sendTerminalInput("t 1", "ls\r");
    await api.resizeTerminal("t1", 90, 30);
    await api.closeTerminal("t1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/terminal",
      "POST /api/terminal/t%201/input",
      "POST /api/terminal/t1/resize",
      "DELETE /api/terminal/t1",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ cwd: "/p", cols: 100, rows: 28 });
  });

  test("panel-prefs menerima tab terminal", () => {
    expect(parsePanelPrefs(JSON.stringify({ open: true, tab: "terminal" })).tab).toBe("terminal");
  });
});
