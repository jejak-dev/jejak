import { afterEach, describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import { CopyButton } from "../src/client/components/CopyButton";

interface FakeButton {
  classList: { toggle: (name: string, on: boolean) => void };
  querySelector: (selector: string) => { textContent: string } | null;
  classes: Set<string>;
  note: { textContent: string };
}

function fakeButton(): FakeButton {
  const classes = new Set<string>();
  const note = { textContent: "" };
  return {
    classes,
    note,
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
    },
    querySelector: (selector: string) => (selector === ".jk-copy-text" ? note : null),
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

describe("CopyButton", () => {
  test("merender tombol type=button dengan aria-label Salin", () => {
    const vnode = CopyButton({ text: "halo" }) as VNode;
    const props = vnode.props as Record<string, unknown>;
    expect(vnode.type).toBe("button");
    expect(props.type).toBe("button");
    expect(props.class).toBe("jk-copy");
    expect(props["aria-label"]).toBe("Salin");
  });

  test("klik menyalin teks lalu menampilkan Disalin", async () => {
    const written: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { clipboard: { writeText: async (text: string) => void written.push(text) } },
    });
    restores.push(() => {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>).navigator;
      else Object.defineProperty(globalThis, "navigator", descriptor);
    });

    const vnode = CopyButton({ text: () => "teks malas" }) as VNode;
    const button = fakeButton();
    const cleanup = (vnode.ref as (node: unknown) => (() => void) | undefined)(button);
    ((vnode.props as Record<string, unknown>).onClick as (event: unknown) => void)({
      currentTarget: button,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(written).toEqual(["teks malas"]);
    expect(button.note.textContent).toBe("Disalin");
    expect(button.classes.has("jk-copy-done")).toBe(true);
    cleanup?.();
  });
});
