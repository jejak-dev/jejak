import { describe, expect, test } from "bun:test";
import { copyText } from "../src/client/lib/clipboard";

/** Jalankan body dengan global sementara; selalu kembalikan global di finally. */
async function withGlobals(
  entries: Partial<Record<"navigator" | "document", unknown>>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    await body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  }
}

function fakeDocument(execCommand: unknown): unknown {
  return {
    createElement: () => ({
      value: "",
      style: {} as Record<string, string>,
      setAttribute: () => undefined,
      select: () => undefined,
      parentNode: { removeChild: () => undefined },
    }),
    body: { appendChild: () => undefined },
    execCommand,
  };
}

describe("copyText", () => {
  test("memakai navigator.clipboard.writeText dan mengembalikan true", async () => {
    const written: string[] = [];
    await withGlobals(
      { navigator: { clipboard: { writeText: async (text: string) => void written.push(text) } } },
      async () => {
        expect(await copyText("halo")).toBe(true);
        expect(written).toEqual(["halo"]);
      },
    );
    expect(typeof navigator).toBe("object");
  });

  test("clipboard menolak -> false bila tidak ada document untuk fallback", async () => {
    await withGlobals(
      {
        navigator: {
          clipboard: {
            writeText: async () => {
              throw new Error("izin ditolak");
            },
          },
        },
        document: undefined,
      },
      async () => {
        expect(await copyText("halo")).toBe(false);
      },
    );
  });

  test("tanpa clipboard dan tanpa document.execCommand -> false tanpa melempar", async () => {
    await withGlobals(
      { navigator: {}, document: fakeDocument(undefined) },
      async () => {
        await expect(copyText("halo")).resolves.toBe(false);
      },
    );
  });

  test("fallback textarea memakai document.execCommand bila ada", async () => {
    const calls: string[] = [];
    const area = { value: "", style: {}, setAttribute: () => undefined, select: () => undefined, parentNode: { removeChild: () => undefined } };
    const doc = {
      ...(fakeDocument((command: string) => {
        calls.push(command);
        return true;
      }) as Record<string, unknown>),
      createElement: () => area,
    };
    await withGlobals({ navigator: {}, document: doc }, async () => {
      expect(await copyText("isi panjang")).toBe(true);
      expect(calls).toEqual(["copy"]);
      expect(area.value).toBe("isi panjang");
    });
  });

  test("execCommand yang melempar tetap menghasilkan false", async () => {
    await withGlobals(
      {
        navigator: {},
        document: fakeDocument(() => {
          throw new Error("tidak didukung");
        }),
      },
      async () => {
        await expect(copyText("x")).resolves.toBe(false);
      },
    );
  });
});
