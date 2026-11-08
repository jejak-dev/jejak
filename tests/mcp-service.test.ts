import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpServerError,
  McpServerService,
  type CreateMcpServerInput,
} from "../src/server/mcp/mcp-service";
import { readMcpConfig } from "../src/server/mcp/mcp-config";

let root: string;
let path: string;
let service: McpServerService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-mcp-service-"));
  path = join(root, "home", "mcp-servers.json");
  service = new McpServerService({ path });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stdioInput(overrides: Partial<CreateMcpServerInput> = {}): CreateMcpServerInput {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { TOKEN: "nilai-token-panjang" },
    ...overrides,
  };
}

function httpInput(overrides: Partial<CreateMcpServerInput> = {}): CreateMcpServerInput {
  return {
    name: "remote",
    transport: "http",
    url: "https://mcp.test/sse",
    headers: { Authorization: "Bearer nilai-token-panjang" },
    ...overrides,
  };
}

async function createStdio(overrides: Partial<CreateMcpServerInput> = {}) {
  return service.create(stdioInput(overrides));
}

describe("create", () => {
  test("membuat server stdio dan mengembalikan view tanpa nilai", async () => {
    const view = await createStdio();
    expect(view.name).toBe("github");
    expect(view.transport).toBe("stdio");
    expect(view.envKeys).toEqual(["TOKEN"]);
    expect(view.enabled).toBe(true);
    expect(JSON.stringify(view)).not.toContain("nilai-token-panjang");
    expect(view.createdAt).toBe(view.updatedAt);
  });

  test("membuat server http dengan headerNames", async () => {
    const view = await service.create(httpInput());
    expect(view.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(view)).not.toContain("nilai-token-panjang");
  });

  test("validasi gagal menjadi 400 dan tidak menulis berkas", async () => {
    await expect(createStdio({ name: "Jejak" })).rejects.toThrow(McpServerError);
    await expect(createStdio({ transport: "stdio", url: "https://x.test" })).rejects.toThrow(
      /tidak boleh memuat url/,
    );
    await expect(
      service.create({ name: "tanpa-command", transport: "stdio" }),
    ).rejects.toThrow(/wajib memuat command/);
    await expect(createStdio({ nama: "x" } as CreateMcpServerInput)).rejects.toThrow(
      /tidak dikenal/,
    );
    await expect(readdir(join(root, "home"))).rejects.toThrow();
  });

  test("duplikat nama menjadi konflik", async () => {
    await createStdio();
    await expect(createStdio({ command: "other" })).rejects.toThrow(/sudah dipakai/);
    try {
      await createStdio();
    } catch (error) {
      expect(error).toBeInstanceOf(McpServerError);
      expect((error as McpServerError).code).toBe("konflik");
    }
  });

  test("batas 30 server menjadi konflik", async () => {
    for (let index = 0; index < 29; index += 1) {
      await createStdio({ name: `s${index}` });
    }
    await createStdio({ name: "s29" });
    await expect(createStdio({ name: "s30" })).rejects.toThrow(/Batas 30/);
  });

  test("enabled false tersimpan", async () => {
    const view = await createStdio({ enabled: false });
    expect(view.enabled).toBe(false);
  });
});

describe("update parsial", () => {
  test("env set, ganti, hapus null, dan pertahankan kunci lain", async () => {
    const created = await createStdio({ env: { A: "satu", B: "dua", C: "tiga" } });

    const set = await service.update(created.id, { env: { D: "empat" } });
    expect(set.envKeys).toEqual(["A", "B", "C", "D"]);

    const replaced = await service.update(created.id, { env: { A: "baru" } });
    expect(replaced.envKeys).toEqual(["A", "B", "C", "D"]);

    const removed = await service.update(created.id, { env: { B: null, D: null } });
    expect(removed.envKeys).toEqual(["A", "C"]);

    const resolved = await service.resolved();
    expect(resolved[0]).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { A: "baru", C: "tiga" },
    });
  });

  test("headers parsial dengan null", async () => {
    const created = await service.create(httpInput({ headers: { A: "satu", B: "dua" } }));
    const updated = await service.update(created.id, { headers: { B: null, C: "tiga" } });
    expect(updated.headerNames).toEqual(["A", "C"]);
    const resolved = await service.resolved();
    expect(resolved[0]).toEqual({
      name: "remote",
      transport: "http",
      url: "https://mcp.test/sse",
      headers: { A: "satu", C: "tiga" },
    });
  });

  test("ganti nama dan enabled tanpa menyentuh env", async () => {
    const created = await createStdio();
    const updated = await service.update(created.id, { name: "ganti", enabled: false });
    expect(updated.name).toBe("ganti");
    expect(updated.enabled).toBe(false);
    expect(updated.envKeys).toEqual(["TOKEN"]);
  });

  test("ganti transport tanpa semua field baru menjadi galat 400", async () => {
    const created = await createStdio();
    await expect(service.update(created.id, { transport: "http" })).rejects.toThrow(
      /wajib memuat url/,
    );
    await expect(
      service.update(created.id, { transport: "http", url: "https://x.test", command: "npx" }),
    ).rejects.toThrow(/bukan milik transport http/);
  });

  test("ganti transport lengkap membuang field lama", async () => {
    const created = await createStdio();
    const updated = await service.update(created.id, {
      transport: "http",
      url: "https://baru.test",
      headers: { "X-Key": "nilai-panjang" },
    });
    expect(updated.transport).toBe("http");
    expect("command" in updated).toBe(false);
    expect(updated.headerNames).toEqual(["X-Key"]);

    const read = await readMcpConfig(path);
    expect(read.config.servers[0]!.command).toBeUndefined();
    expect(read.config.servers[0]!.env).toBeUndefined();
  });

  test("field transport lain pada update tanpa ganti transport ditolak", async () => {
    const created = await createStdio();
    await expect(service.update(created.id, { url: "https://x.test" })).rejects.toThrow(
      /bukan milik transport stdio/,
    );
    const httpCreated = await service.create(httpInput({ name: "lain" }));
    await expect(service.update(httpCreated.id, { command: "npx" })).rejects.toThrow(
      /bukan milik transport http/,
    );
  });

  test("update id tak ada menjadi tidak-ditemukan", async () => {
    await expect(
      service.update("00000000-0000-4000-8000-000000000000", { name: "x" }),
    ).rejects.toThrow(/tidak ditemukan/);
  });

  test("nilai env bukan teks atau null ditolak", async () => {
    const created = await createStdio();
    await expect(service.update(created.id, { env: { A: 5 } })).rejects.toThrow(
      /harus berupa teks atau null/,
    );
  });

  test("dua PATCH bersamaan tidak saling menimpa", async () => {
    const created = await createStdio({ env: { BASE: "awal" } });
    const [first, second] = await Promise.all([
      service.update(created.id, { env: { A: "satu" } }),
      service.update(created.id, { env: { B: "dua" } }),
    ]);
    expect(first.envKeys).toContain("BASE");
    expect(second.envKeys).toContain("BASE");

    const resolved = await service.resolved();
    const env = resolved[0]?.transport === "stdio" ? resolved[0].env : {};
    expect(env).toEqual({ A: "satu", B: "dua", BASE: "awal" });
  });
});

describe("list, get, resolved, delete", () => {
  test("list memuat problems dan tidak pernah memuat nilai", async () => {
    await createStdio();
    const result = await service.list();
    expect(result.items).toHaveLength(1);
    expect(result.problems).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("nilai-token-panjang");
  });

  test("list melaporkan berkas rusak lewat problems", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
    await writeFile(path, "bukan json", { mode: 0o600 });
    const result = await service.list();
    expect(result.items).toEqual([]);
    expect(result.problems[0]!.reason).toBe("JSON tidak valid");
  });

  test("get mengembalikan nilai penuh dan undefined untuk id tak sah", async () => {
    const created = await createStdio();
    const found = await service.get(created.id);
    expect(found?.env).toEqual({ TOKEN: "nilai-token-panjang" });
    expect(await service.get("bukan-uuid")).toBeUndefined();
  });

  test("resolved hanya server enabled dengan nilai penuh", async () => {
    await createStdio({ name: "aktif" });
    await createStdio({ name: "nonaktif", enabled: false });
    await service.create(httpInput());
    const resolved = await service.resolved();
    expect(resolved.map((server) => server.name).sort()).toEqual(["aktif", "remote"]);
    const remote = resolved.find((server) => server.name === "remote");
    expect(remote?.transport).toBe("http");
    if (remote?.transport === "http") {
      expect(remote.headers.Authorization).toBe("Bearer nilai-token-panjang");
    }
  });

  test("delete menghapus dan berikutnya tidak ditemukan", async () => {
    const created = await createStdio();
    await service.delete(created.id);
    expect(await service.list()).toEqual({ items: [], problems: [] });
    await expect(service.delete(created.id)).rejects.toThrow(/tidak ditemukan/);
    await expect(service.delete("bukan-uuid")).rejects.toThrow(/tidak ditemukan/);
  });
});