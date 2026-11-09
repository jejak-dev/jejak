import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_BLOCK_REASON,
  checkSecretAccess,
  type SecretAccessCheck,
  type SecretAccessVerdict,
} from "../src/server/security/secret-paths";

const CWD = "/proyek/uji";
const HOME = "/rumah/uji";

function read(path: string, overrides: Partial<SecretAccessCheck> = {}): SecretAccessVerdict {
  return checkSecretAccess({
    toolName: "Read",
    toolInput: { file_path: path },
    cwd: CWD,
    home: HOME,
    ...overrides,
  });
}

function tool(
  toolName: string,
  toolInput: unknown,
  options: { cwd?: string; home?: string; isAllowed?: (abs: string) => boolean } = {},
): SecretAccessVerdict {
  return checkSecretAccess(
    { toolName, toolInput, cwd: options.cwd ?? CWD, home: options.home ?? HOME },
    options.isAllowed === undefined ? {} : { isAllowed: options.isAllowed },
  );
}

function expectBlocked(verdict: SecretAccessVerdict, rule?: string): void {
  expect(verdict.blocked).toBe(true);
  expect(verdict.reason).toBe(SECRET_BLOCK_REASON);
  if (rule !== undefined) expect(verdict.rule).toBe(rule);
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-secret-paths-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("aturan nama berkas", () => {
  expectBlocked(read(".env"), ".env");
  expectBlocked(read(".env.local"), ".env.*");
  expectBlocked(read("kunci.pem"), "*.pem");
  expectBlocked(read("kunci.key"), "*.key");
  expectBlocked(read("sertifikat.p12"), "*.p12");
  expectBlocked(read("sertifikat.pfx"), "*.pfx");
  expectBlocked(read("id_rsa"), "id_rsa*");
  expectBlocked(read("id_rsa_old"), "id_rsa*");
  expectBlocked(read("id_ed25519"), "id_ed25519*");
  expectBlocked(read("id_ecdsa"), "id_ecdsa*");
  expectBlocked(read("id_dsa"), "id_dsa*");
  expectBlocked(read(".npmrc"), ".npmrc");
  expectBlocked(read(".netrc"), ".netrc");
  expectBlocked(read(".pgpass"), ".pgpass");
  expectBlocked(read(".git-credentials"), ".git-credentials");
  expectBlocked(read(".aws/credentials"), ".aws/credentials");
});

test("pengecualian nama publik", () => {
  for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    expect(read(name)).toEqual({ blocked: false });
  }
  expect(read("id_rsa.pub")).toEqual({ blocked: false });
  expect(read("id_ed25519.pub")).toEqual({ blocked: false });
});

test("direktori .ssh memblokir selain kunci publik/known_hosts/config", () => {
  expectBlocked(read(".ssh/id_ed25519"), "id_ed25519*");
  expectBlocked(read("/rumah/uji/.ssh/id_rsa"), "id_rsa*");
  expectBlocked(read("~/.ssh/something"), ".ssh/**");
  expect(read(".ssh/known_hosts")).toEqual({ blocked: false });
  expect(read(".ssh/config")).toEqual({ blocked: false });
  expect(read(".ssh/id_rsa.pub")).toEqual({ blocked: false });
});

test("~ diperluas dengan home buatan", () => {
  expectBlocked(read("~/.ssh/id_ed25519"), "id_ed25519*");
  expectBlocked(read("~/.aws/credentials"), ".aws/credentials");
  expectBlocked(read("~/.npmrc"), ".npmrc");
  expect(read("~/proyek/catatan.md")).toEqual({ blocked: false });
});

test("jalur relatif dengan .. dirapikan", () => {
  expectBlocked(tool("Read", { file_path: "../../.env" }, { cwd: join(dir, "a", "b") }));
  expectBlocked(read("./.env"), ".env");
  expectBlocked(read("sub/../.env"), ".env");
});

test("symlink ke berkas rahasia ikut terblokir", async () => {
  await writeFile(join(dir, ".env"), "TOKEN=rahasia\n");
  await symlink(join(dir, ".env"), join(dir, "catatan.txt"));
  const verdict = tool("Read", { file_path: "catatan.txt" }, { cwd: dir });
  expectBlocked(verdict, ".env");
});

test("isAllowed melonggarkan jalur yang cocok", () => {
  const allowed = tool("Read", { file_path: ".env" }, { isAllowed: (abs) => abs === join(CWD, ".env") });
  expect(allowed).toEqual({ blocked: false });
  const notAllowed = tool("Read", { file_path: ".env" }, { isAllowed: () => false });
  expectBlocked(notAllowed, ".env");
  const throwing = tool("Read", { file_path: ".env" }, { isAllowed: () => { throw new Error("rusak"); } });
  expectBlocked(throwing, ".env");
});

test("tool per-tool", () => {
  expectBlocked(tool("Read", { file_path: ".env" }), ".env");
  expectBlocked(tool("Edit", { file_path: ".env" }), ".env");
  expectBlocked(tool("MultiEdit", { file_path: ".env" }), ".env");
  expectBlocked(tool("Write", { file_path: ".env" }), ".env");
  expectBlocked(tool("NotebookEdit", { notebook_path: "kunci.pem" }), "*.pem");

  expectBlocked(tool("Grep", { pattern: "X", path: ".env" }), ".env");
  expectBlocked(tool("Grep", { pattern: "X", glob: ".env*" }), ".env");
  expectBlocked(tool("Grep", { pattern: "X", glob: "**/*.pem" }), "*.pem");
  expect(tool("Grep", { pattern: "X", path: "src", glob: "*.ts" })).toEqual({ blocked: false });

  expectBlocked(tool("Glob", { pattern: "**/.env*" }), ".env");
  expectBlocked(tool("Glob", { pattern: "**/*.key" }), "*.key");
  expectBlocked(tool("Glob", { pattern: "**/id_rsa*" }), "id_rsa*");
  expect(tool("Glob", { pattern: "**/*.ts" })).toEqual({ blocked: false });
});

test("Bash upaya terbaik", () => {
  expectBlocked(tool("Bash", { command: "cat .env" }), ".env");
  expectBlocked(tool("Bash", { command: 'cat "./.env"' }), ".env");
  expectBlocked(tool("Bash", { command: "echo hi > .env" }), ".env");
  expectBlocked(tool("Bash", { command: "grep X .env.local" }), ".env.*");
  expectBlocked(tool("Bash", { command: "source .env" }), ".env");
  expectBlocked(tool("Bash", { command: "cat ~/.ssh/id_ed25519" }), "id_ed25519*");
  expectBlocked(tool("Bash", { command: "cp a ; cat kunci.pem" }), "*.pem");
  expect(tool("Bash", { command: "ls" })).toEqual({ blocked: false });
  expect(tool("Bash", { command: "cat README.md" })).toEqual({ blocked: false });
  expect(tool("Bash", { command: "echo environment" })).toEqual({ blocked: false });
});

test("masukan aneh tidak melempar dan tidak memblokir", () => {
  expect(checkSecretAccess(null as unknown as SecretAccessCheck)).toEqual({ blocked: false });
  expect(checkSecretAccess(undefined as unknown as SecretAccessCheck)).toEqual({ blocked: false });
  expect(checkSecretAccess("bukan objek" as unknown as SecretAccessCheck)).toEqual({ blocked: false });
  expect(tool("Read", null)).toEqual({ blocked: false });
  expect(tool("Read", { file_path: 42 })).toEqual({ blocked: false });
  expect(tool("Bash", { command: null })).toEqual({ blocked: false });
  expect(tool("Read", { file_path: ".env" }, { cwd: undefined as unknown as string })).toMatchObject({
    blocked: true,
  });
});

test("tool tak dikenal tidak diblokir", () => {
  expect(tool("Agent", { prompt: "baca .env" })).toEqual({ blocked: false });
  expect(tool("WebFetch", { url: "https://contoh/.env" })).toEqual({ blocked: false });
  expect(tool("mcp__jejak-memory__memory_search", { query: ".env" })).toEqual({ blocked: false });
});

test("false-positive aman", () => {
  for (const name of [
    "environment.ts",
    ".environment",
    "dotenv.md",
    "my.envelope",
    "keyboard.ts",
    "monkey.key.md",
    "src/keys.ts",
    "api-key-guide.md",
  ]) {
    expect(read(name)).toEqual({ blocked: false });
  }
});
