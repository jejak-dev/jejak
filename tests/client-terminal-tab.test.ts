import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, render } from "preact";
import { TerminalTab } from "../src/client/components/TerminalTab";
import type { ApiClient } from "../src/client/lib/api";
import { asElement, FakeNode, find, findAll, flushEffects, installDom } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Bantuan ---------- */

function apiPalsu(create: () => Promise<unknown> = async () => ({ id: "t1" })) {
  const calls: string[] = [];
  const api = {
    createTerminal: async () => {
      calls.push("create");
      return create();
    },
    closeTerminal: async () => {
      calls.push("close");
    },
    getFeatures: async () => ({ terminal: { enabled: true, locked: false } }),
  } as unknown as ApiClient;
  return { api, calls };
}

/** Aliran keluaran kosong: `follow` selesai tanpa frame. */
function pasangFetch(): () => void {
  const sebelumnya = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = sebelumnya;
  };
}

function tombol(root: FakeNode): FakeNode[] {
  return findAll(root, (node) => node.localName === "button");
}

function teksTombol(root: FakeNode, teks: string): FakeNode | undefined {
  return tombol(root).find((node) => node.textContent.trim() === teks);
}

/* ---------- Tes ---------- */

describe("TerminalTab buka otomatis", () => {
  test("cwd terisi: createTerminal dipanggil sekali tanpa klik", async () => {
    const pulihkan = pasangFetch();
    const { api, calls } = apiPalsu();
    const root = asElement(new FakeNode("div"));
    render(h(TerminalTab, { api, cwd: "/tmp/proyek" }), root as unknown as HTMLElement);
    await flushEffects();
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    render(null, root as unknown as HTMLElement);
    pulihkan();
  });

  test("tanpa cwd: tidak membuat terminal dan tombol Buka terminal tampil", async () => {
    const pulihkan = pasangFetch();
    const { api, calls } = apiPalsu();
    const root = asElement(new FakeNode("div"));
    render(h(TerminalTab, { api, cwd: "" }), root as unknown as HTMLElement);
    await flushEffects();
    expect(calls).not.toContain("create");
    expect(teksTombol(root, "Buka terminal")).toBeDefined();
    render(null, root as unknown as HTMLElement);
    pulihkan();
  });

  test("attachId: tidak membuat terminal baru", async () => {
    const pulihkan = pasangFetch();
    const { api, calls } = apiPalsu();
    const root = asElement(new FakeNode("div"));
    render(h(TerminalTab, { api, cwd: "/tmp/proyek", attachId: "t9" }), root as unknown as HTMLElement);
    await flushEffects();
    expect(calls).not.toContain("create");
    render(null, root as unknown as HTMLElement);
    pulihkan();
  });
});

describe("TerminalTab markup", () => {
  test("permukaan log, tombol tutup berlabel, dan catatan terlipat", async () => {
    const pulihkan = pasangFetch();
    const { api } = apiPalsu();
    const root = asElement(new FakeNode("div"));
    render(h(TerminalTab, { api, cwd: "/tmp/proyek" }), root as unknown as HTMLElement);
    await flushEffects();

    const layar = find(root, (node) => node.getAttribute("class") === "jk-terminal-screen");
    expect(layar?.getAttribute("role")).toBe("log");

    const tutup = find(root, (node) => node.getAttribute("aria-label") === "Tutup terminal");
    expect(tutup?.textContent.trim()).toBe("Tutup");

    const info = find(root, (node) => node.getAttribute("class") === "jk-terminal-info");
    expect(info?.localName).toBe("details");
    expect(info?.textContent).toContain("Tentang terminal ini");

    render(null, root as unknown as HTMLElement);
    pulihkan();
  });
});

/* ---------- CSS ---------- */

const css = readFileSync(join(import.meta.dir, "..", "src", "client", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function isiAturan(selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(css);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((s) => s.trim() === selektor)) return cocok[2] ?? "";
    cocok = pola.exec(css);
  }
  return undefined;
}

function blokMedia(kondisi: string): string {
  const penanda = `@media (${kondisi})`;
  let dari = 0;
  for (;;) {
    const mulai = css.indexOf(penanda, dari);
    if (mulai === -1) return "";
    const buka = css.indexOf("{", mulai);
    let kedalaman = 0;
    let i = buka;
    for (; i < css.length; i++) {
      if (css[i] === "{") kedalaman += 1;
      else if (css[i] === "}") {
        kedalaman -= 1;
        if (kedalaman === 0) break;
      }
    }
    const isi = css.slice(buka + 1, i);
    if (isi.includes(".jk-terminal-screen")) return isi;
    dari = i + 1;
  }
}

describe("CSS terminal polos", () => {
  test("permukaan tanpa kotak dan berlatar panel", () => {
    const aturan = isiAturan(".jk-terminal-screen") ?? "";
    expect(aturan).toContain("border: 0");
    expect(aturan).toContain("background: var(--bg)");
    expect(aturan).toContain("outline: 0");
  });

  test("kursor blok berkedip", () => {
    expect(isiAturan(".jk-terminal-screen::after") ?? "").toContain("content:");
    expect(css).toContain("@keyframes jk-term-blink");
  });

  test("gerak dikurangi mematikan kedipan", () => {
    const blok = blokMedia("prefers-reduced-motion: reduce");
    expect(blok).toContain(".jk-terminal-screen::after");
    expect(blok).toContain("animation: none");
  });
});
