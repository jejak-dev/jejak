import { describe, expect, test } from "bun:test";
import {
  isMermaidLang,
  MAX_MERMAID_SOURCE,
  renderMermaid,
  type MermaidApi,
  type MermaidConfig,
} from "../src/client/lib/mermaid";

interface FakeCalls {
  initialize: MermaidConfig[];
  render: string[];
  parse: string[];
}

function fakeApi(overrides: Partial<MermaidApi> = {}): { api: MermaidApi; calls: FakeCalls } {
  const calls: FakeCalls = { initialize: [], render: [], parse: [] };
  const api: MermaidApi = {
    initialize(config: MermaidConfig): void {
      calls.initialize.push(config);
    },
    async parse(source: string): Promise<boolean | { diagramType?: string }> {
      calls.parse.push(source);
      return { diagramType: "flowchart" };
    },
    async render(id: string): Promise<{ svg: string }> {
      calls.render.push(id);
      return { svg: "<svg><g>diagram</g></svg>" };
    },
    ...overrides,
  };
  return { api, calls };
}

describe("isMermaidLang", () => {
  test("mengenali mermaid tanpa memperhatikan huruf besar/kecil", () => {
    expect(isMermaidLang("mermaid")).toBe(true);
    expect(isMermaidLang("Mermaid")).toBe(true);
    expect(isMermaidLang("MERMAID")).toBe(true);
  });

  test("menolak bahasa lain dan nilai kosong", () => {
    expect(isMermaidLang("ts")).toBe(false);
    expect(isMermaidLang("mermaid-js")).toBe(false);
    expect(isMermaidLang("")).toBe(false);
    expect(isMermaidLang(undefined)).toBe(false);
  });
});

describe("renderMermaid", () => {
  test("berhasil mengembalikan svg", async () => {
    const { api, calls } = fakeApi();
    const result = await renderMermaid("flowchart TD\nA-->B", {
      dark: false,
      id: "mermaid-1",
      load: async () => api,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("harus berhasil");
    expect(result.svg).toContain("<svg>");
    expect(calls.render).toEqual(["mermaid-1"]);
    expect(calls.parse).toEqual(["flowchart TD\nA-->B"]);
  });

  test("sintaks tidak valid menghasilkan galat tanpa merender", async () => {
    const { api, calls } = fakeApi({ parse: async () => false });
    const result = await renderMermaid("bukan diagram", {
      dark: false,
      id: "mermaid-2",
      load: async () => api,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("harus gagal");
    expect(result.error).toBe("Sintaks diagram tidak valid");
    expect(calls.render).toHaveLength(0);
  });

  test("galat render dikembalikan sebagai pesan ringkas tanpa stack", async () => {
    const { api } = fakeApi({
      render: async () => {
        throw new Error("gagal merender\n    di somewhere.js:1:1");
      },
    });
    const result = await renderMermaid("flowchart TD\nA-->B", {
      dark: false,
      id: "mermaid-3",
      load: async () => api,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("harus gagal");
    expect(result.error).toBe("gagal merender di somewhere.js:1:1");
    expect(result.error).not.toContain("\n");
  });

  test("galat pemuat ditangani tanpa melempar", async () => {
    const result = await renderMermaid("flowchart TD\nA-->B", {
      dark: false,
      id: "mermaid-4",
      load: async () => {
        throw new Error("modul tidak termuat");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("harus gagal");
    expect(result.error).toContain("modul tidak termuat");
  });

  test("sumber terlalu panjang ditolak sebelum memuat mermaid", async () => {
    let dimuat = false;
    const result = await renderMermaid("x".repeat(MAX_MERMAID_SOURCE + 1), {
      dark: false,
      id: "mermaid-5",
      load: async () => {
        dimuat = true;
        return fakeApi().api;
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("harus gagal");
    expect(result.error.length).toBeGreaterThan(0);
    expect(dimuat).toBe(false);
  });

  test("initialize memakai securityLevel strict dan tema sesuai", async () => {
    const terang = fakeApi();
    await renderMermaid("flowchart TD\nA-->B", {
      dark: false,
      id: "mermaid-6",
      load: async () => terang.api,
    });
    expect(terang.calls.initialize).toHaveLength(1);
    expect(terang.calls.initialize[0]).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
    });

    const gelap = fakeApi();
    await renderMermaid("flowchart TD\nA-->B", {
      dark: true,
      id: "mermaid-7",
      load: async () => gelap.api,
    });
    expect(gelap.calls.initialize).toHaveLength(1);
    expect(gelap.calls.initialize[0]).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
  });

  test("initialize cukup sekali per tema pada instans yang sama", async () => {
    const { api, calls } = fakeApi();
    await renderMermaid("flowchart TD\nA-->B", { dark: false, id: "m8", load: async () => api });
    await renderMermaid("flowchart TD\nA-->C", { dark: false, id: "m9", load: async () => api });
    expect(calls.initialize).toHaveLength(1);

    await renderMermaid("flowchart TD\nA-->C", { dark: true, id: "m10", load: async () => api });
    expect(calls.initialize).toHaveLength(2);
    expect(calls.initialize[1]?.theme).toBe("dark");
  });
});
