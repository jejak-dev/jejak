import { describe, expect, test } from "bun:test";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  loadTheme,
  nextTheme,
  parseTheme,
  saveTheme,
  themeAttribute,
  themeLabel,
} from "../src/client/lib/theme";

describe("tema", () => {
  test("parseTheme hanya menerima light/dark, selain itu sistem", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme("ungu")).toBe("system");
    expect(parseTheme(null)).toBe("system");
  });

  test("nextTheme berputar sistem -> terang -> gelap -> sistem", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  test("label dan atribut", () => {
    expect(themeLabel("system")).toBe("Sistem");
    expect(themeLabel("light")).toBe("Terang");
    expect(themeLabel("dark")).toBe("Gelap");
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("dark")).toBe("dark");
  });

  test("applyTheme memasang dan menghapus data-theme", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    applyTheme(root, "dark");
    expect(attrs.get("data-theme")).toBe("dark");
    applyTheme(root, "system");
    expect(attrs.has("data-theme")).toBe(false);
  });

  test("load/save tahan penyimpanan yang melempar galat", () => {
    const store = new Map<string, string>();
    const ok = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveTheme(ok, "dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(loadTheme(ok)).toBe("dark");
    const broken = {
      getItem: () => {
        throw new Error("diblokir");
      },
      setItem: () => {
        throw new Error("diblokir");
      },
    };
    expect(loadTheme(broken)).toBe("system");
    expect(() => saveTheme(broken, "light")).not.toThrow();
    expect(loadTheme(undefined)).toBe("system");
  });
});
