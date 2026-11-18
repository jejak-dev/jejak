import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { CodeEditor } from "../src/client/components/CodeEditor";
import { findAll, fire, installDom, mount } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

function byClass(root: ReturnType<typeof mount>, name: string) {
  return findAll(root, (node) => node.className.split(/\s+/).includes(name));
}

/** Nilai textarea: Preact menyetel atribut bila elemen tiruan tak punya properti `value`. */
function nilai(elemen: ReturnType<typeof mount> | undefined): string {
  if (elemen === undefined) return "";
  const sebagaiProperti = (elemen as unknown as { value?: string }).value;
  if (typeof sebagaiProperti === "string") return sebagaiProperti;
  return elemen.getAttribute("value") ?? "";
}

describe("CodeEditor", () => {
  test("merender token, gutter, dan textarea", () => {
    const root = mount(
      h(CodeEditor, {
        path: "a.ts",
        value: "const x = 1;\n// catatan",
        onInput: () => {},
        ariaLabel: "Sunting a.ts",
      }),
    );
    const keyword = byClass(root, "tok-keyword");
    expect(keyword.length).toBeGreaterThan(0);
    expect(keyword[0]?.textContent).toBe("const");
    expect(byClass(root, "tok-comment").length).toBeGreaterThan(0);

    const gutter = byClass(root, "jk-ce-gutter")[0];
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    expect(gutter?.textContent).toBe("1\n2");

    const input = byClass(root, "jk-ce-input")[0];
    expect(input?.getAttribute("aria-label")).toBe("Sunting a.ts");
    expect(nilai(input)).toBe("const x = 1;\n// catatan");

    const pre = byClass(root, "jk-ce-hl")[0];
    expect(pre?.getAttribute("aria-hidden")).toBe("true");
    expect(pre?.textContent?.endsWith("\n")).toBe(true);
  });

  test("nilai kosong tidak melempar dan gutter tetap satu baris", () => {
    const root = mount(
      h(CodeEditor, { path: "a.ts", value: "", onInput: () => {}, ariaLabel: "Sunting a.ts" }),
    );
    expect(byClass(root, "jk-ce-gutter")[0]?.textContent).toBe("1");
    expect(byClass(root, "jk-ce-input").length).toBe(1);
  });

  test("baris terakhir berakhir newline tetap punya tinggi", () => {
    const root = mount(
      h(CodeEditor, {
        path: "a.ts",
        value: "satu\ndua\n",
        onInput: () => {},
        ariaLabel: "Sunting a.ts",
      }),
    );
    expect(byClass(root, "jk-ce-gutter")[0]?.textContent).toBe("1\n2\n3");
    const pre = byClass(root, "jk-ce-hl")[0];
    expect(pre?.textContent?.endsWith("\n")).toBe(true);
  });

  test("mengetik meneruskan nilai ke onInput", () => {
    const nilai: string[] = [];
    const root = mount(
      h(CodeEditor, {
        path: "a.ts",
        value: "x",
        onInput: (value: string) => nilai.push(value),
        ariaLabel: "Sunting a.ts",
      }),
    );
    const input = byClass(root, "jk-ce-input")[0];
    if (input === undefined) throw new Error("textarea tidak ada");
    input.setAttribute("value", "xy");
    (input as unknown as { value: string }).value = "xy";
    fire(input, "input");
    expect(nilai).toEqual(["xy"]);
  });
});
