import { describe, expect, test } from "bun:test";
import type { McpServerItem, McpTestOutcome } from "../src/client/lib/api";
import {
  MCP_NAME_PATTERN,
  buildCreateInput,
  buildUpdateInput,
  describeTest,
  parseKeyValueLines,
  parseLines,
  summarizeServer,
  type McpFormValues,
} from "../src/client/lib/mcp";

function item(overrides: Partial<McpServerItem> = {}): McpServerItem {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    envKeys: ["TOKEN", "LOG_LEVEL"],
    headerNames: [],
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function form(overrides: Partial<McpFormValues> = {}): McpFormValues {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: "",
    env: "",
    url: "",
    headers: "",
    removedEnvKeys: [],
    removedHeaderNames: [],
    ...overrides,
  };
}

describe("summarizeServer", () => {
  test("stdio: command dan args dipisah spasi", () => {
    expect(summarizeServer(item())).toBe("npx -y server");
  });

  test("stdio tanpa args", () => {
    expect(summarizeServer(item({ args: [] }))).toBe("npx");
  });

  test("dipotong pada ~60 karakter dengan elipsis", () => {
    const long = summarizeServer(item({ command: "bin", args: ["a".repeat(80)] }));
    expect(long.length).toBe(61);
    expect(long.endsWith("…")).toBe(true);
  });

  test("http memakai url", () => {
    expect(
      summarizeServer(item({ transport: "http", url: "https://mcp.test/sse" })),
    ).toBe("https://mcp.test/sse");
  });

  test("http tanpa url menghasilkan teks kosong", () => {
    expect(summarizeServer(item({ transport: "http", url: undefined }))).toBe("");
  });
});

describe("parseLines", () => {
  test("membuang baris kosong dan trim", () => {
    expect(parseLines("  satu \n\n dua\n   \n")).toEqual(["satu", "dua"]);
  });

  test("teks kosong menghasilkan array kosong", () => {
    expect(parseLines("")).toEqual([]);
  });
});

describe("parseKeyValueLines", () => {
  test("env memakai pemisah pertama", () => {
    const parsed = parseKeyValueLines("TOKEN=abc=def\nEMPTY=\n\nLOG=debug", "env");
    expect(parsed.pairs).toEqual({ TOKEN: "abc=def", EMPTY: "", LOG: "debug" });
    expect(parsed.errors).toEqual([]);
  });

  test("header memakai titik dua pertama", () => {
    const parsed = parseKeyValueLines("Authorization: Bearer x:y\nX-Trace: 1", "header");
    expect(parsed.pairs).toEqual({
      Authorization: "Bearer x:y",
      "X-Trace": "1",
    });
    expect(parsed.errors).toEqual([]);
  });

  test("kunci kosong dan baris tanpa pemisah menghasilkan galat", () => {
    const parsed = parseKeyValueLines("=nilai\ntanpa-pemisah", "env");
    expect(parsed.errors).toEqual([
      "Kunci env pada baris 1 kosong.",
      "Baris 2 harus berformat KUNCI=nilai.",
    ]);
    expect(parsed.pairs).toEqual({});
  });

  test("galat header berbahasa Indonesia", () => {
    const parsed = parseKeyValueLines(": nilainya", "header");
    expect(parsed.errors[0]).toBe("Nama header pada baris 1 kosong.");
  });
});

describe("buildCreateInput", () => {
  test("stdio hanya mengirim field milik transport", () => {
    expect(
      buildCreateInput(
        form({
          args: " -y \n server \n",
          env: "TOKEN=abc",
          url: "https://abaikan.test",
          headers: "A: b",
        }),
      ),
    ).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: "abc" },
    });
  });

  test("http hanya url dan headers", () => {
    expect(
      buildCreateInput(
        form({
          name: "remote",
          transport: "http",
          command: "abaikan",
          url: " https://mcp.test/sse ",
          headers: "Authorization: Bearer x",
        }),
      ),
    ).toEqual({
      name: "remote",
      transport: "http",
      url: "https://mcp.test/sse",
      headers: { Authorization: "Bearer x" },
    });
  });
});

describe("buildUpdateInput", () => {
  test("tidak mengirim apa pun bila tidak berubah", () => {
    const original = item();
    expect(
      buildUpdateInput(
        form({ command: "npx", args: "-y\nserver", env: "" }),
        original,
      ),
    ).toEqual({});
  });

  test("env yang dihapus menjadi null dan kunci lain dipertahankan", () => {
    const original = item();
    const patch = buildUpdateInput(
      form({ args: "-y\nserver", removedEnvKeys: ["LOG_LEVEL"] }),
      original,
    );
    expect(patch).toEqual({ env: { LOG_LEVEL: null } });
  });

  test("nilai tersimpan tidak pernah dikirim ulang", () => {
    const original = item();
    const patch = buildUpdateInput(
      form({ args: "-y\nserver", env: "TOKEN=\nBARU=nilai" }),
      original,
    );
    expect(patch).toEqual({ env: { BARU: "nilai" } });
  });

  test("nilai baru menggantikan kunci tersimpan", () => {
    const patch = buildUpdateInput(
      form({ args: "-y\nserver", env: "TOKEN=baru" }),
      item(),
    );
    expect(patch).toEqual({ env: { TOKEN: "baru" } });
  });

  test("field yang berubah saja yang dikirim", () => {
    const patch = buildUpdateInput(
      form({ name: "github-baru", command: "uvx", args: "-y\nserver" }),
      item(),
    );
    expect(patch).toEqual({ name: "github-baru", command: "uvx" });
  });

  test("args kosong mengirim daftar kosong", () => {
    expect(buildUpdateInput(form({ args: "" , env: ""}), item())).toEqual({ args: [] });
  });

  test("http: header dihapus dan url berubah", () => {
    const original = item({
      transport: "http",
      command: undefined,
      args: undefined,
      envKeys: [],
      url: "https://lama.test",
      headerNames: ["Authorization", "X-Trace"],
    });
    const patch = buildUpdateInput(
      form({
        transport: "http",
        url: "https://baru.test",
        removedHeaderNames: ["X-Trace"],
        headers: "X-Baru: 1",
      }),
      original,
    );
    expect(patch).toEqual({
      url: "https://baru.test",
      headers: { "X-Trace": null, "X-Baru": "1" },
    });
  });

  test("transport lain tidak pernah menjadi bagian patch", () => {
    const patch = buildUpdateInput(
      form({ url: "https://abaikan.test", headers: "A: b" }),
      item(),
    );
    expect("url" in patch).toBe(false);
    expect("headers" in patch).toBe(false);
  });
});

describe("describeTest", () => {
  test("sukses dengan jumlah tool dan durasi", () => {
    const result: McpTestOutcome = { ok: true, tools: [{ name: "a" }, { name: "b" }], ms: 320 };
    expect(describeTest(result)).toBe("Tersambung · 2 tool · 320 ms");
  });

  test("sukses tanpa daftar tool dihitung nol", () => {
    expect(describeTest({ ok: true, ms: 5 })).toBe("Tersambung · 0 tool · 5 ms");
  });

  test("gagal menampilkan galat", () => {
    expect(describeTest({ ok: false, error: "batas waktu", ms: 12 })).toBe("Gagal · batas waktu");
  });

  test("gagal tanpa pesan tetap punya ringkasan", () => {
    expect(describeTest({ ok: false, ms: 12 })).toBe("Gagal · 12 ms");
  });
});

describe("MCP_NAME_PATTERN", () => {
  test("menerima huruf kecil, angka, strip, garis bawah", () => {
    for (const name of ["a", "github", "my-server_2", "0abc"]) {
      expect(MCP_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  test("menolak huruf besar, spasi, dan lebih dari 32 karakter", () => {
    for (const name of ["GitHub", "my server", "_abc", "a".repeat(33), ""]) {
      expect(MCP_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});
