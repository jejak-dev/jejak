import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_SERVERS_MAX,
  checkArgs,
  checkCommand,
  checkEnv,
  checkHeaders,
  checkName,
  checkTransport,
  checkTransportFields,
  checkUrl,
  isMcpServerId,
  mcpServersPath,
  parseMcpConfig,
  readMcpConfig,
  serializeMcpConfig,
  toView,
  validateServer,
  writeMcpConfig,
  type McpConfigFile,
  type McpServerConfig,
} from "../src/server/mcp/mcp-config";

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-mcp-config-"));
  file = join(root, "home", "mcp-servers.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stdio(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: crypto.randomUUID(),
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { TOKEN: "nilai-rahasia-panjang" },
    enabled: true,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

function http(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: crypto.randomUUID(),
    name: "remote",
    transport: "http",
    url: "https://mcp.test/stream",
    headers: { Authorization: "Bearer token-rahasia" },
    enabled: true,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

function configWith(servers: McpServerConfig[]): McpConfigFile {
  return { version: 1, servers };
}

describe("path dan id", () => {
  test("mcpServersPath memakai JEJAK_HOME", () => {
    expect(mcpServersPath({ JEJAK_HOME: "/tmp/rumah" })).toBe("/tmp/rumah/mcp-servers.json");
  });

  test("isMcpServerId hanya menerima UUID v4", () => {
    expect(isMcpServerId(crypto.randomUUID())).toBe(true);
    expect(isMcpServerId("bukan-uuid")).toBe(false);
    expect(isMcpServerId("00000000-0000-1000-8000-000000000000")).toBe(false);
  });
});

describe("validasi nama", () => {
  test("nama sah diterima", () => {
    for (const name of ["a", "github", "my-server_2", "a".repeat(32)]) {
      expect(checkName(name).ok).toBe(true);
    }
  });

  test("nama tidak sah ditolak", () => {
    const cases: unknown[] = ["", "A", "-abc", "abc def", "a".repeat(33), 5, "a/b"];
    for (const value of cases) {
      const result = checkName(value);
      expect(result.ok).toBe(false);
    }
  });

  test("nama berawalan jejak dicadangkan", () => {
    expect(checkName("jejak-memory").ok).toBe(false);
    expect(checkName("jejakku").ok).toBe(false);
    const result = checkName("jejak-memory");
    if (!result.ok) expect(result.reason).toContain("dicadangkan");
  });

  test("nama yang memuat rahasia ditolak", () => {
    const result = checkName("ghp_abcdefghijklmnop");
    expect(result.ok).toBe(false);
  });

  test("transport hanya stdio atau http", () => {
    expect(checkTransport("stdio").ok).toBe(true);
    expect(checkTransport("http").ok).toBe(true);
    expect(checkTransport("sse").ok).toBe(false);
    expect(checkTransport(undefined).ok).toBe(false);
  });
});

describe("validasi command, args, env", () => {
  test("command tanpa spasi, tanpa kontrol, dan tidak memuat rahasia", () => {
    expect(checkCommand("npx").ok).toBe(true);
    expect(checkCommand("npx -y server").ok).toBe(false);
    expect(checkCommand("npx\0server").ok).toBe(false);
    expect(checkCommand("").ok).toBe(false);
    expect(checkCommand("a".repeat(257)).ok).toBe(false);
    expect(checkCommand("sk-ant-abcdefghijkl").ok).toBe(false);
  });

  test("args batas jumlah, panjang, dan rahasia", () => {
    expect(checkArgs(Array.from({ length: 32 }, () => "x")).ok).toBe(true);
    expect(checkArgs(Array.from({ length: 33 }, () => "x")).ok).toBe(false);
    expect(checkArgs(["a".repeat(39)]).ok).toBe(true);
    expect(checkArgs([" ".repeat(512)]).ok).toBe(true);
    expect(checkArgs(["a".repeat(512)]).ok).toBe(false);
    expect(checkArgs(["a".repeat(513)]).ok).toBe(false);
    expect(checkArgs(["ghp_abcdefghijklmnop"]).ok).toBe(false);
    expect(checkArgs([5]).ok).toBe(false);
    expect(checkArgs("bukan daftar").ok).toBe(false);
  });

  test("env kunci dan nilai dibatasi", () => {
    expect(checkEnv({ TOKEN: "x" }).ok).toBe(true);
    expect(checkEnv({ token: "x" }).ok).toBe(false);
    expect(checkEnv({ "A B": "x" }).ok).toBe(false);
    const many: Record<string, string> = {};
    for (let index = 0; index < 33; index += 1) many[`K${index}`] = "x";
    expect(checkEnv(many).ok).toBe(false);
    expect(checkEnv({ KEY: "a".repeat(2049) }).ok).toBe(false);
    expect(checkEnv({ KEY: 5 }).ok).toBe(false);
  });
});

describe("validasi url dan headers", () => {
  test("url harus http/https tanpa kredensial", () => {
    expect(checkUrl("https://mcp.test/sse").ok).toBe(true);
    expect(checkUrl("http://127.0.0.1:9000/mcp").ok).toBe(true);
    expect(checkUrl("ftp://mcp.test").ok).toBe(false);
    expect(checkUrl("https://user:pass@mcp.test").ok).toBe(false);
    expect(checkUrl("bukan url").ok).toBe(false);
    expect(checkUrl(`https://mcp.test/${"a".repeat(1024)}`).ok).toBe(false);
  });

  test("headers nama token valid dan nilai dibatasi", () => {
    expect(checkHeaders({ Authorization: "Bearer x" }).ok).toBe(true);
    expect(checkHeaders({ "X-Api-Key": "abc" }).ok).toBe(true);
    expect(checkHeaders({ "Bad Header": "abc" }).ok).toBe(false);
    expect(checkHeaders({ Key: "x".repeat(2049) }).ok).toBe(false);
    const many: Record<string, string> = {};
    for (let index = 0; index < 17; index += 1) many[`X-${index}`] = "x";
    expect(checkHeaders(many).ok).toBe(false);
    expect(checkHeaders({ Key: "baris\nbaru" }).ok).toBe(false);
  });
});

describe("validasi lintas transport", () => {
  test("stdio menolak field http dan wajib command", () => {
    expect(checkTransportFields({ transport: "stdio", url: "https://x.test" })).toContain("url");
    expect(checkTransportFields({ transport: "stdio", headers: {} })).toContain("headers");
    expect(checkTransportFields({ transport: "stdio" })).toContain("command");
    expect(checkTransportFields({ transport: "stdio", command: "npx" })).toBeNull();
  });

  test("http menolak field stdio dan wajib url", () => {
    expect(checkTransportFields({ transport: "http", command: "npx" })).toContain("command");
    expect(checkTransportFields({ transport: "http", args: [] })).toContain("args");
    expect(checkTransportFields({ transport: "http", env: {} })).toContain("env");
    expect(checkTransportFields({ transport: "http" })).toContain("url");
    expect(checkTransportFields({ transport: "http", url: "https://x.test" })).toBeNull();
  });

  test("validateServer menerima record lengkap sah", () => {
    expect(validateServer(stdio())).toBeNull();
    expect(validateServer(http())).toBeNull();
  });

  test("validateServer menolak record melanggar", () => {
    expect(validateServer(stdio({ name: "Jejak" }))).not.toBeNull();
    expect(validateServer(stdio({ command: undefined }))).not.toBeNull();
    expect(validateServer(stdio({ url: "https://x.test" }))).not.toBeNull();
    expect(validateServer(stdio({ createdAt: "kemarin" }))).not.toBeNull();
    expect(validateServer(http({ url: "https://u:p@x.test" }))).not.toBeNull();
  });
});

describe("view menyembunyikan nilai", () => {
  test("toView hanya memuat nama kunci", () => {
    const view = toView(stdio());
    expect(view.envKeys).toEqual(["TOKEN"]);
    expect("env" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("nilai-rahasia-panjang");

    const httpView = toView(http());
    expect(httpView.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(httpView)).not.toContain("token-rahasia");
  });
});

describe("parse ketat berkas", () => {
  test("versi lain dan isi bukan objek menjadi problems", () => {
    expect(parseMcpConfig({ version: 2, servers: [] }).problems).toHaveLength(1);
    expect(parseMcpConfig("rusak").problems).toHaveLength(1);
    expect(parseMcpConfig({ version: 1, servers: {} }).problems).toHaveLength(1);
    expect(parseMcpConfig({ version: 1, servers: [] }).config.servers).toEqual([]);
  });

  test("entri rusak dilewati tanpa mengulang isi", () => {
    const secret = "ghp_abcdefghijklmnop";
    const parsed = parseMcpConfig({
      version: 1,
      servers: [
        { ...stdio(), args: [`token ${secret}`] },
        stdio({ name: "ok" }),
      ],
    });
    expect(parsed.config.servers.map((server) => server.name)).toEqual(["ok"]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]!.reason).not.toContain(secret);
    expect(parsed.problems[0]!.reason).toContain("rahasia");
  });

  test("field tak dikenal dan nama duplikat menjadi problems", () => {
    const withUnknown = { ...stdio(), extra: true };
    const parsed = parseMcpConfig({ version: 1, servers: [withUnknown] });
    expect(parsed.problems[0]!.reason).toContain("tak dikenal");

    const duplicate = parseMcpConfig({
      version: 1,
      servers: [stdio(), stdio({ id: crypto.randomUUID() })],
    });
    expect(duplicate.config.servers).toHaveLength(1);
    expect(duplicate.problems[0]!.reason).toContain("duplikat");
  });

  test("server melebihi batas 30 menjadi problems", () => {
    const servers = Array.from({ length: MCP_SERVERS_MAX + 1 }, (_, index) =>
      stdio({ name: `s${index}`, id: crypto.randomUUID() }),
    );
    const parsed = parseMcpConfig({ version: 1, servers });
    expect(parsed.config.servers).toHaveLength(MCP_SERVERS_MAX);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]!.reason).toContain("batas 30");
  });

  test("serialisasi bolak-balik sah", () => {
    const config = configWith([stdio(), http()]);
    const parsed = parseMcpConfig(JSON.parse(serializeMcpConfig(config)));
    expect(parsed.problems).toEqual([]);
    expect(parsed.config.servers).toEqual(config.servers);
  });
});

describe("baca/tulis berkas", () => {
  test("menulis atomik 0600 di direktori 0700 tanpa sisa tmp", async () => {
    await writeMcpConfig(file, configWith([stdio()]));

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(join(root, "home"));
    expect(dirInfo.mode & 0o777).toBe(0o700);

    const entries = await readdir(join(root, "home"));
    expect(entries).toEqual(["mcp-servers.json"]);
  });

  test("berkas tidak ada menjadi daftar kosong tanpa problems", async () => {
    const read = await readMcpConfig(file);
    expect(read.missing).toBe(true);
    expect(read.config.servers).toEqual([]);
    expect(read.problems).toEqual([]);
  });

  test("JSON rusak menjadi problems tanpa mengulang isi", async () => {
    await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
    await writeFile(file, "{ rusak sekali", { mode: 0o600 });
    const read = await readMcpConfig(file);
    expect(read.config.servers).toEqual([]);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]!.reason).toBe("JSON tidak valid");
    expect(read.problems[0]!.reason).not.toContain("rusak sekali");
  });

  test("menulis menolak nama duplikat dan record tidak sah", async () => {
    await expect(
      writeMcpConfig(file, configWith([stdio(), stdio({ id: crypto.randomUUID() })])),
    ).rejects.toThrow(/duplikat/);
    await expect(
      writeMcpConfig(file, configWith([stdio({ command: "npx -y" })])),
    ).rejects.toThrow(/tidak valid/);
  });

  test("menulis ulang mempertahankan izin 600 meski sebelumnya longgar", async () => {
    await writeMcpConfig(file, configWith([stdio()]));
    await chmod(file, 0o644);
    await writeMcpConfig(file, configWith([stdio({ name: "kedua", id: crypto.randomUUID() })]));
    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("isi berkas tidak memuat nilai terbaca untuk view, tapi berkas memang menyimpan nilai", async () => {
    await writeMcpConfig(file, configWith([stdio()]));
    const read = await readMcpConfig(file);
    expect(read.config.servers[0]!.env).toEqual({ TOKEN: "nilai-rahasia-panjang" });
  });
});