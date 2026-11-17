import { describe, expect, test } from "bun:test";
import {
  SHORTCUT_LIST,
  adjacentSession,
  matchShortcut,
  targetKindOf,
  type KeyEventLike,
  type TargetKind,
} from "../src/client/lib/shortcuts";

function key(k: string, overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    targetKind: "other",
    ...overrides,
  };
}

describe("matchShortcut di luar input", () => {
  test("Ctrl+K dan Cmd+K membuka palette", () => {
    expect(matchShortcut(key("k", { ctrlKey: true }))).toBe("palette");
    expect(matchShortcut(key("k", { metaKey: true }))).toBe("palette");
    expect(matchShortcut(key("K", { ctrlKey: true }))).toBe("palette");
  });

  test("? membuka bantuan (dengan atau tanpa shift)", () => {
    expect(matchShortcut(key("?"))).toBe("help");
    expect(matchShortcut(key("?", { shiftKey: true }))).toBe("help");
  });

  test("/ memfokus kolom cari", () => {
    expect(matchShortcut(key("/"))).toBe("search");
  });

  test("n sesi baru dan p toggle panel", () => {
    expect(matchShortcut(key("n"))).toBe("new-session");
    expect(matchShortcut(key("p"))).toBe("toggle-panel");
  });

  test("Alt+panah memindah sesi", () => {
    expect(matchShortcut(key("ArrowUp", { altKey: true }))).toBe("prev-session");
    expect(matchShortcut(key("ArrowDown", { altKey: true }))).toBe("next-session");
  });

  test("Escape dikenali", () => {
    expect(matchShortcut(key("Escape"))).toBe("escape");
  });

  test("tombol lain tidak memicu apa pun", () => {
    expect(matchShortcut(key("a"))).toBe(undefined);
    expect(matchShortcut(key("ArrowUp"))).toBe(undefined);
    expect(matchShortcut(key("k"))).toBe(undefined);
  });
});

describe("matchShortcut saat fokus di input", () => {
  const input: TargetKind = "input";

  test("Ctrl/Cmd+K tetap membuka palette", () => {
    expect(matchShortcut(key("k", { ctrlKey: true, targetKind: input }))).toBe("palette");
    expect(matchShortcut(key("k", { metaKey: true, targetKind: input }))).toBe("palette");
    expect(matchShortcut(key("b", { ctrlKey: true, targetKind: input }))).toBe("toggle-sidebar");
  });

  test("Alt+panah tetap memindah sesi", () => {
    expect(matchShortcut(key("ArrowUp", { altKey: true, targetKind: input }))).toBe("prev-session");
    expect(matchShortcut(key("ArrowDown", { altKey: true, targetKind: input }))).toBe("next-session");
  });

  test("huruf biasa tidak mencuri ketikan", () => {
    expect(matchShortcut(key("n", { targetKind: input }))).toBe(undefined);
    expect(matchShortcut(key("p", { targetKind: input }))).toBe(undefined);
    expect(matchShortcut(key("/", { targetKind: input }))).toBe(undefined);
    expect(matchShortcut(key("?", { shiftKey: true, targetKind: input }))).toBe(undefined);
  });

  test("Escape tidak ditangani global saat di input", () => {
    expect(matchShortcut(key("Escape", { targetKind: input }))).toBe(undefined);
  });
});

describe("modifier tak terduga dan isComposing", () => {
  test("Shift pada huruf biasa diabaikan", () => {
    expect(matchShortcut(key("n", { shiftKey: true }))).toBe(undefined);
  });

  test("Ctrl+Shift+K diabaikan", () => {
    expect(matchShortcut(key("k", { ctrlKey: true, shiftKey: true }))).toBe(undefined);
  });

  test("Ctrl+Alt+K diabaikan", () => {
    expect(matchShortcut(key("k", { ctrlKey: true, altKey: true }))).toBe(undefined);
  });

  test("Ctrl+tombol lain diabaikan", () => {
    expect(matchShortcut(key("j", { ctrlKey: true }))).toBe(undefined);
  });

  test("Ctrl/Cmd+B mengalihkan sidebar", () => {
    expect(matchShortcut(key("b", { ctrlKey: true }))).toBe("toggle-sidebar");
    expect(matchShortcut(key("b", { metaKey: true }))).toBe("toggle-sidebar");
  });

  test("Alt+Shift+panah diabaikan", () => {
    expect(matchShortcut(key("ArrowUp", { altKey: true, shiftKey: true }))).toBe(undefined);
  });

  test("isComposing mengabaikan semua pintasan", () => {
    expect(matchShortcut(key("k", { ctrlKey: true, isComposing: true }))).toBe(undefined);
    expect(matchShortcut(key("?", { isComposing: true }))).toBe(undefined);
  });
});

describe("targetKindOf", () => {
  test("input, textarea, select dianggap input", () => {
    expect(targetKindOf({ tagName: "INPUT" })).toBe("input");
    expect(targetKindOf({ tagName: "TEXTAREA" })).toBe("input");
    expect(targetKindOf({ tagName: "SELECT" })).toBe("input");
  });

  test("contenteditable dianggap input", () => {
    expect(targetKindOf({ tagName: "DIV", isContentEditable: true })).toBe("input");
    expect(
      targetKindOf({ tagName: "SPAN", closest: (selector: string) => (selector === "[contenteditable]" ? {} : null) }),
    ).toBe("input");
  });

  test("tombol dan target kosong dianggap other", () => {
    expect(targetKindOf({ tagName: "BUTTON" })).toBe("other");
    expect(targetKindOf(null)).toBe("other");
    expect(targetKindOf(undefined)).toBe("other");
  });
});

describe("adjacentSession", () => {
  const ids = ["a", "b", "c"];

  test("di tengah daftar bergerak dua arah", () => {
    expect(adjacentSession(ids, "b", "next")).toBe("c");
    expect(adjacentSession(ids, "b", "prev")).toBe("a");
  });

  test("berhenti di ujung (tidak melingkar)", () => {
    expect(adjacentSession(ids, "c", "next")).toBe(undefined);
    expect(adjacentSession(ids, "a", "prev")).toBe(undefined);
  });

  test("id tidak ada mengembalikan undefined", () => {
    expect(adjacentSession(ids, "z", "next")).toBe(undefined);
    expect(adjacentSession(ids, undefined, "next")).toBe(undefined);
  });

  test("daftar kosong mengembalikan undefined", () => {
    expect(adjacentSession([], "a", "next")).toBe(undefined);
  });
});

describe("SHORTCUT_LIST", () => {
  test("memuat label dan tombol yang ditampilkan bantuan", () => {
    expect(SHORTCUT_LIST.length).toBeGreaterThanOrEqual(7);
    expect(SHORTCUT_LIST.every((item) => item.label !== "" && item.keys !== "")).toBe(true);
  });
});
