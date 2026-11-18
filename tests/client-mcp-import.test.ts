import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { McpImportForm } from "../src/client/components/McpImportForm";
import { McpPage } from "../src/client/components/McpPage";
import { ApiError, type ApiClient, type McpServerInput } from "../src/client/lib/api";
import type { McpJsonEntry } from "../src/client/lib/mcp";
import { find, findAll, fire, flushEffects, installDom, mount, type FakeNode } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

function byClass(root: FakeNode, name: string): FakeNode[] {
  return findAll(root, (node) => node.className.split(/\s+/).includes(name));
}

function textarea(root: FakeNode): FakeNode {
  const found = findAll(
    root,
    (node) => node.localName === "textarea" && node.getAttribute("aria-label") === "JSON konfigurasi MCP",
  )[0];
  if (found === undefined) throw new Error("textarea JSON tidak ada");
  return found;
}

async function type(root: FakeNode, value: string): Promise<void> {
  const input = textarea(root);
  input.setAttribute("value", value);
  (input as unknown as { value: string }).value = value;
  fire(input, "input");
  await flushEffects();
}

function apiPalsu(
  options: { failFor?: string[] } = {},
): { api: ApiClient; calls: McpServerInput[] } {
  const calls: McpServerInput[] = [];
  const base = {
    listMcpServers: async () => ({ items: [], problems: [] }),
    createMcpServer: async (input: McpServerInput) => {
      calls.push(input);
      if (options.failFor !== undefined && input.name !== undefined && options.failFor.includes(input.name)) {
        throw new ApiError(`gagal ${input.name}`, 400);
      }
      return { id: input.name ?? "id" };
    },
  };
  return { api: base as unknown as ApiClient, calls };
}

const CONTOH = JSON.stringify({
  mcpServers: {
    github: {
      command: "npx",
      args: ["-y", "server-github"],
      env: { GITHUB_TOKEN: "nilai-sangat-rahasia" },
    },
    docs: {
      url: "https://x.test/mcp",
      headers: { Authorization: "Bearer token-rahasia" },
    },
  },
});

describe("McpImportForm", () => {
  test("pratinjau muncul dan nilai rahasia tidak ada di DOM", async () => {
    const { api } = apiPalsu();
    void api;
    const submitted: McpJsonEntry[][] = [];
    const root = mount(
      h(McpImportForm, {
        existingNames: [],
        busy: false,
        failures: {},
        onSubmit: (entries) => submitted.push(entries),
        onCancel: () => {},
      }),
    );
    await type(root, CONTOH);

    expect(root.textContent).toContain("github");
    expect(root.textContent).toContain("docs");
    expect(root.textContent).toContain("1 kunci rahasia: GITHUB_TOKEN");
    expect(root.textContent).toContain("1 kunci rahasia: Authorization");
    expect(root.textContent).not.toContain("nilai-sangat-rahasia");
    expect(root.textContent).not.toContain("token-rahasia");
    expect(find(root, (node) => node.localName === "button" && node.getAttribute("type") === "submit")?.textContent).toBe(
      "Tambahkan 2 server",
    );
  });

  test("teks kosong: tombol nonaktif tanpa error", () => {
    const root = mount(
      h(McpImportForm, {
        existingNames: [],
        busy: false,
        failures: {},
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    const submit = find(root, (node) => node.localName === "button" && node.getAttribute("type") === "submit");
    expect(submit?.getAttribute("disabled")).not.toBeNull();
    expect(byClass(root, "jk-error-line").length).toBe(0);
  });

  test("nama duplikat dilewati", async () => {
    const submitted: McpJsonEntry[][] = [];
    const root = mount(
      h(McpImportForm, {
        existingNames: ["github"],
        busy: false,
        failures: {},
        onSubmit: (entries) => submitted.push(entries),
        onCancel: () => {},
      }),
    );
    await type(root, CONTOH);
    expect(root.textContent).toContain("Sudah ada, dilewati");
    expect(
      find(root, (node) => node.localName === "button" && node.getAttribute("type") === "submit")?.textContent,
    ).toBe("Tambahkan 1 server");

    const submit = find(root, (node) => node.localName === "button" && node.getAttribute("type") === "submit");
    if (submit === undefined) throw new Error("tombol submit tidak ada");
    const form = find(root, (node) => node.localName === "form");
    fire(form ?? submit, "submit");
    expect(submitted.length).toBe(1);
    expect(submitted[0]?.map((entry) => entry.name)).toEqual(["docs"]);
  });

  test("galat baris gagal ditampilkan", async () => {
    const root = mount(
      h(McpImportForm, {
        existingNames: [],
        busy: false,
        failures: { github: "sudah dipakai" },
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    await type(root, CONTOH);
    expect(root.textContent).toContain("sudah dipakai");
  });
});

describe("McpPage impor JSON", () => {
  test("tombol Tempel JSON ada dan membuka panel", async () => {
    const { api } = apiPalsu();
    const root = mount(h(McpPage, { api }));
    await flushEffects();

    const tempel = find(
      root,
      (node) => node.localName === "button" && node.textContent === "Tempel JSON",
    );
    expect(tempel).not.toBeUndefined();
    fire(tempel as FakeNode, "click");
    await flushEffects();

    expect(textarea(root)).not.toBeUndefined();
    expect(root.textContent).toContain("Tempel konfigurasi dari dokumentasi server MCP.");
  });

  test("kirim memanggil createMcpServer berurutan, lalu menutup panel", async () => {
    const { api, calls } = apiPalsu();
    const root = mount(h(McpPage, { api }));
    await flushEffects();

    fire(
      find(root, (node) => node.localName === "button" && node.textContent === "Tempel JSON") as FakeNode,
      "click",
    );
    await flushEffects();
    await type(root, CONTOH);

    const form = find(root, (node) => node.localName === "form");
    fire(form as FakeNode, "submit");
    await flushEffects();

    expect(calls.map((input) => input.name)).toEqual(["github", "docs"]);
    expect(calls[0]?.transport).toBe("stdio");
    expect(calls[1]?.transport).toBe("http");
    expect(
      find(root, (node) => node.localName === "textarea" && node.getAttribute("aria-label") === "JSON konfigurasi MCP"),
    ).toBeUndefined();
  });

  test("gagal sebagian: panel tetap terbuka dengan baris gagal", async () => {
    const { api, calls } = apiPalsu({ failFor: ["github"] });
    const root = mount(h(McpPage, { api }));
    await flushEffects();

    fire(
      find(root, (node) => node.localName === "button" && node.textContent === "Tempel JSON") as FakeNode,
      "click",
    );
    await flushEffects();
    await type(root, CONTOH);

    const form = find(root, (node) => node.localName === "form");
    fire(form as FakeNode, "submit");
    await flushEffects();

    expect(calls.map((input) => input.name)).toEqual(["github", "docs"]);
    expect(root.textContent).toContain("gagal github");
    expect(
      find(root, (node) => node.localName === "textarea" && node.getAttribute("aria-label") === "JSON konfigurasi MCP"),
    ).not.toBeUndefined();
  });
});
