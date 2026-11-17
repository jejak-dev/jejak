import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_HIDDEN_KEY,
  loadSidebarHidden,
  parseSidebarHidden,
  saveSidebarHidden,
} from "../src/client/lib/sidebar-hidden";

/** Penyimpanan tiruan sederhana. */
function storageAwal(nilai: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(nilai));
  return {
    get length(): number {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => data.delete(key),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function storageMelempar(): Storage {
  return {
    get length(): number {
      throw new Error("diblokir");
    },
    clear: () => {
      throw new Error("diblokir");
    },
    getItem: () => {
      throw new Error("diblokir");
    },
    key: () => {
      throw new Error("diblokir");
    },
    removeItem: () => {
      throw new Error("diblokir");
    },
    setItem: () => {
      throw new Error("diblokir");
    },
  };
}

describe("parseSidebarHidden", () => {
  test("hanya \"1\" berarti tersembunyi", () => {
    expect(parseSidebarHidden("1")).toBe(true);
    expect(parseSidebarHidden(null)).toBe(false);
    expect(parseSidebarHidden(undefined)).toBe(false);
    expect(parseSidebarHidden("0")).toBe(false);
    expect(parseSidebarHidden("x")).toBe(false);
  });
});

describe("loadSidebarHidden", () => {
  test("membaca nilai tersimpan", () => {
    expect(loadSidebarHidden(storageAwal({ [SIDEBAR_HIDDEN_KEY]: "1" }))).toBe(true);
    expect(loadSidebarHidden(storageAwal({ [SIDEBAR_HIDDEN_KEY]: "0" }))).toBe(false);
  });

  test("tanpa storage atau storage rusak berarti tetap tampil", () => {
    expect(loadSidebarHidden()).toBe(false);
    expect(loadSidebarHidden(storageMelempar())).toBe(false);
  });
});

describe("saveSidebarHidden", () => {
  test("menulis \"1\" atau \"0\"", () => {
    const storage = storageAwal();
    saveSidebarHidden(storage, true);
    expect(storage.getItem(SIDEBAR_HIDDEN_KEY)).toBe("1");
    saveSidebarHidden(storage, false);
    expect(storage.getItem(SIDEBAR_HIDDEN_KEY)).toBe("0");
  });

  test("storage yang melempar tidak membuat galat", () => {
    expect(() => saveSidebarHidden(storageMelempar(), true)).not.toThrow();
  });
});
