import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecretAccess } from "../src/server/security/secret-paths";
import { FileSecretAllowStore } from "../src/server/security/secret-allow-store";

const HOME = "/rumah/uji";
let dir = "";
let projectRoot = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-secret-paths-allow-"));
  projectRoot = await realpath(dir);
  await writeFile(join(dir, ".env"), "TOKEN=sintetis\n");
  await writeFile(join(dir, ".env.local"), "TOKEN=sintetis\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tool(toolName: string, toolInput: unknown, isAllowed?: (abs: string) => boolean) {
  return checkSecretAccess(
    { toolName, toolInput, cwd: projectRoot, home: HOME },
    isAllowed === undefined ? {} : { isAllowed },
  );
}

test("secret-allow.json diblokir sebagai berkas rahasia", () => {
  const verdict = tool("Read", { file_path: "secret-allow.json" });
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("secret-allow.json");
});

test("Bash yang menyebut /api/secret-allow diblokir", () => {
  const verdict = tool("Bash", {
    command: "curl -X POST http://127.0.0.1:3000/api/secret-allow",
  });
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("secret-allow-api");
});

test("isAllowed dari store melonggarkan hanya jalur terdaftar", () => {
  const store = new FileSecretAllowStore(":memory:");
  store.add(projectRoot, ".env");
  const isAllowed = (abs: string): boolean => store.isAllowed(projectRoot, abs);

  expect(tool("Read", { file_path: join(projectRoot, ".env") }, isAllowed)).toEqual({
    blocked: false,
  });
  const other = tool("Read", { file_path: join(projectRoot, ".env.local") }, isAllowed);
  expect(other.blocked).toBe(true);
  expect(other.rule).toBe(".env.*");
});
