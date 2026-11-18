import { describe, expect, test } from "bun:test";
import { parseMcpJson } from "../src/client/lib/mcp";

describe("parseMcpJson: bentuk masukan", () => {
  test("(a) mcpServers dengan stdio dan http", () => {
    const hasil = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "xxx" },
          },
          docs: {
            type: "http",
            url: "https://x.test/mcp",
            headers: { Authorization: "Bearer xxx" },
          },
        },
      }),
    );
    expect(hasil.errors).toEqual([]);
    expect(hasil.entries.map((entry) => entry.name)).toEqual(["github", "docs"]);
    expect(hasil.entries[0]?.input).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "xxx" },
      enabled: true,
    });
    expect(hasil.entries[1]?.input).toEqual({
      name: "docs",
      transport: "http",
      url: "https://x.test/mcp",
      headers: { Authorization: "Bearer xxx" },
      enabled: true,
    });
  });

  test("(b) servers", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ servers: { satu: { command: "uvx", args: ["a"] } } }),
    );
    expect(hasil.errors).toEqual([]);
    expect(hasil.entries[0]?.name).toBe("satu");
    expect(hasil.entries[0]?.transport).toBe("stdio");
  });

  test("(c) peta polos", () => {
    const hasil = parseMcpJson(
      JSON.stringify({
        satu: { command: "npx" },
        dua: { url: "https://dua.test/mcp" },
      }),
    );
    expect(hasil.errors).toEqual([]);
    expect(hasil.entries.map((entry) => entry.transport)).toEqual(["stdio", "http"]);
  });

  test("(d) satu server tanpa nama meminta nama", () => {
    const hasil = parseMcpJson(JSON.stringify({ command: "npx", args: ["-y", "x"] }));
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors).toEqual(['Beri nama server: bungkus dengan { "nama": { ... } }']);
  });

  test("(d) url tanpa nama juga meminta nama", () => {
    const hasil = parseMcpJson(JSON.stringify({ url: "https://x.test/mcp" }));
    expect(hasil.errors[0]).toContain("Beri nama server");
  });
});

describe("parseMcpJson: transport dan rahasia", () => {
  test("http dengan headers dan secretKeys tanpa nilai", () => {
    const hasil = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://x.test/mcp",
            headers: { Authorization: "Bearer rahasia-sekali", "X-Trace": "1" },
          },
        },
      }),
    );
    const entry = hasil.entries[0];
    expect(entry?.transport).toBe("http");
    expect(entry?.secretKeys).toEqual(["Authorization", "X-Trace"]);
    expect(JSON.stringify(entry?.secretKeys)).not.toContain("rahasia-sekali");
  });

  test("sse diperlakukan sebagai http dengan peringatan", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { lama: { type: "sse", url: "https://x.test/sse" } } }),
    );
    expect(hasil.entries[0]?.transport).toBe("http");
    expect(hasil.entries[0]?.warnings).toContain("SSE diperlakukan sebagai http");
  });

  test("transport streamable-http menjadi http", () => {
    const hasil = parseMcpJson(
      JSON.stringify({
        mcpServers: { baru: { transport: "streamable-http", url: "https://x.test/mcp" } },
      }),
    );
    expect(hasil.entries[0]?.transport).toBe("http");
  });

  test("stdio tanpa command menghasilkan galat", () => {
    const hasil = parseMcpJson(JSON.stringify({ mcpServers: { rusak: { args: ["a"] } } }));
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toContain("command wajib diisi");
  });
});

describe("parseMcpJson: JSONC", () => {
  test("komentar dan koma sisa dibuang, URL https utuh", () => {
    const teks = `{
      // komentar baris
      "mcpServers": {
        /* blok */
        "docs": {
          "url": "https://x.test/mcp", // di dalam objek
          "headers": { "Authorization": "Bearer a//b" },
        },
      },
    }`;
    const hasil = parseMcpJson(teks);
    expect(hasil.errors).toEqual([]);
    expect(hasil.entries[0]?.input.url).toBe("https://x.test/mcp");
    expect(hasil.entries[0]?.input.headers).toEqual({ Authorization: "Bearer a//b" });
  });

  test("teks bukan JSON menghasilkan galat", () => {
    const hasil = parseMcpJson("bukan json sama sekali");
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toStartWith("JSON tidak valid:");
  });

  test("teks kosong tidak menghasilkan galat", () => {
    expect(parseMcpJson("   ")).toEqual({ entries: [], errors: [] });
  });
});

describe("parseMcpJson: nama", () => {
  test("nama dinormalisasi dengan peringatan", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { "My Server.v2": { command: "npx" } } }),
    );
    expect(hasil.entries[0]?.name).toBe("my-server-v2");
    expect(hasil.entries[0]?.warnings).toContain("Nama diubah dari My Server.v2 menjadi my-server-v2");
  });

  test("nama yang masih tak valid menghasilkan galat khusus server", () => {
    const hasil = parseMcpJson(JSON.stringify({ mcpServers: { "!!!": { command: "npx" } } }));
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toContain('Nama "!!!" tidak valid');
  });
});

describe("parseMcpJson: command dan env", () => {
  test("command berspasi dipisah menjadi command dan args", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { satu: { command: "npx -y foo" } } }),
    );
    expect(hasil.entries[0]?.input).toEqual({
      name: "satu",
      transport: "stdio",
      command: "npx",
      args: ["-y", "foo"],
      enabled: true,
    });
    expect(hasil.entries[0]?.warnings.length).toBeGreaterThan(0);
  });

  test("command berspasi dengan kutipan menghasilkan galat", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { satu: { command: 'npx "a b"' } } }),
    );
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toContain("kutipan");
  });

  test("env campuran diubah menjadi string", () => {
    const hasil = parseMcpJson(
      JSON.stringify({
        mcpServers: { satu: { command: "npx", env: { A: 1, B: true, C: "x" } } },
      }),
    );
    expect(hasil.entries[0]?.input.env).toEqual({ A: "1", B: "true", C: "x" });
  });

  test("args bukan array string menghasilkan galat", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { satu: { command: "npx", args: [1] } } }),
    );
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toContain("args harus berupa array string");
  });

  test("kunci tak dikenal diabaikan dengan peringatan", () => {
    const hasil = parseMcpJson(
      JSON.stringify({ mcpServers: { satu: { command: "npx", aneh: 1 } } }),
    );
    expect(hasil.entries[0]?.warnings).toContain("Kunci aneh diabaikan");
  });
});

describe("parseMcpJson: batas aman", () => {
  test("lebih dari 50 server ditolak", () => {
    const map: Record<string, unknown> = {};
    for (let index = 0; index < 51; index += 1) {
      map[`s${index}`] = { command: "npx" };
    }
    const hasil = parseMcpJson(JSON.stringify({ mcpServers: map }));
    expect(hasil.entries).toEqual([]);
    expect(hasil.errors[0]).toContain("Maksimum 50 server");
  });

  test("teks lebih dari 200 KB ditolak", () => {
    const hasil = parseMcpJson("x".repeat(200 * 1024 + 1));
    expect(hasil.errors[0]).toContain("200 KB");
  });
});
