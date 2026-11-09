import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSecretAllowStore,
  MAX_PATHS_PER_PROJECT,
  MAX_PROJECTS,
  SecretAllowError,
  defaultSecretAllowStore,
} from "../src/server/security/secret-allow-store";

let root: string;
let outside: string;
let storePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-secret-allow-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-secret-allow-luar-"));
  storePath = join(root, "home", "secret-allow.json");
  await mkdir(join(root, "proyek"), { recursive: true });
  await writeFile(join(root, "proyek", ".env"), "TOKEN=sintetis\n");
  await writeFile(join(root, "proyek", ".env.local"), "TOKEN=sintetis\n");
  await writeFile(join(root, "proyek", "README.md"), "baca aku\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function project(): string {
  return realpathSync(join(root, "proyek"));
}

function store(): FileSecretAllowStore {
  return new FileSecretAllowStore(storePath);
}

describe("FileSecretAllowStore", () => {
  test("add, list, dan remove", () => {
    const s = store();
    const added = s.add(project(), ".env");
    expect(added).toEqual({ path: ".env", rule: ".env" });
    expect(s.list(project())).toEqual([".env"]);
    expect(s.remove(project(), ".env")).toBe(true);
    expect(s.list(project())).toEqual([]);
    expect(s.remove(project(), ".env")).toBe(false);
  });

  test("normalisasi relatif dan absolut", () => {
    const s = store();
    expect(s.add(project(), join(project(), ".env")).path).toBe(".env");
    expect(s.add(project(), "sub/../.env").path).toBe(".env");
    expect(s.list(project())).toEqual([".env"]);
  });

  test("menolak jalur di luar proyek", () => {
    const s = store();
    expect(() => s.add(project(), "../.env")).toThrow("Jalur harus berada di dalam proyek.");
    expect(() => s.add(project(), join(outside, ".env"))).toThrow(
      "Jalur harus berada di dalam proyek.",
    );
  });

  test("menolak symlink yang realpath-nya keluar proyek", async () => {
    await writeFile(join(outside, ".env"), "TOKEN=sintetis\n");
    await symlink(outside, join(project(), "tautan"));
    const s = store();
    expect(() => s.add(project(), "tautan/.env")).toThrow(
      "Jalur harus berada di dalam proyek.",
    );
  });

  test("menolak jalur yang tidak dibatasi kebijakan rahasia", () => {
    const s = store();
    expect(() => s.add(project(), "README.md")).toThrow(
      "Jalur ini tidak dibatasi kebijakan rahasia.",
    );
    try {
      s.add(project(), "README.md");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretAllowError);
      expect((error as SecretAllowError).code).toBe("tidak-valid");
    }
  });

  test("idempoten", () => {
    const s = store();
    const first = s.add(project(), ".env");
    const second = s.add(project(), ".env");
    expect(second).toEqual(first);
    expect(s.list(project())).toEqual([".env"]);
  });

  test("jalur rahasia bertingkat tersimpan relatif POSIX dan terurut", () => {
    const s = store();
    s.add(project(), "sub/.env.local");
    s.add(project(), ".env");
    expect(s.list(project())).toEqual([".env", "sub/.env.local"]);
  });

  test(`batas ${MAX_PATHS_PER_PROJECT} jalur per proyek`, async () => {
    const paths = Array.from({ length: MAX_PATHS_PER_PROJECT }, (_, index) => `k${index}.pem`);
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, projects: { [project()]: paths } }),
      "utf8",
    );
    const s = store();
    expect(s.list(project())).toHaveLength(MAX_PATHS_PER_PROJECT);
    expect(() => s.add(project(), ".env")).toThrow("Batas");
  });

  test(`batas ${MAX_PROJECTS} proyek`, async () => {
    const projects: Record<string, string[]> = {};
    for (let index = 0; index < MAX_PROJECTS; index += 1) {
      projects[join(root, `lain-${index}`)] = [".env"];
    }
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(storePath, JSON.stringify({ version: 1, projects }), "utf8");
    const s = store();
    expect(() => s.add(project(), ".env")).toThrow("Batas");
  });

  test("persistensi antar instance", () => {    store().add(project(), ".env");
    const reopened = store();
    expect(reopened.list(project())).toEqual([".env"]);
    expect(reopened.isAllowed(project(), join(project(), ".env"))).toBe(true);
  });

  test("berkas rusak diperlakukan kosong dan tidak ditimpa sampai add", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(storePath, "{ bukan json", "utf8");
    const s = store();
    expect(s.list(project())).toEqual([]);
    expect(s.isAllowed(project(), join(project(), ".env"))).toBe(false);
    expect(await readFile(storePath, "utf8")).toBe("{ bukan json");

    s.add(project(), ".env");
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
      version: number;
      projects: Record<string, string[]>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.projects[project()]).toEqual([".env"]);
  });

  test("versi tak dikenal juga diperlakukan kosong", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ version: 9, projects: { [project()]: [".env"] } }),
      "utf8",
    );
    const s = store();
    expect(s.list(project())).toEqual([]);
  });

  test("mode berkas 0600 dan direktori 0700", async () => {
    store().add(project(), ".env");
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "home"))).mode & 0o777).toBe(0o700);
  });

  test("isAllowed hanya jalur persis pada proyek yang sama", () => {
    const s = store();
    s.add(project(), ".env");
    expect(s.isAllowed(project(), join(project(), ".env"))).toBe(true);
    expect(s.isAllowed(project(), ".env")).toBe(true);
    expect(s.isAllowed(project(), join(project(), ".env.local"))).toBe(false);
    expect(s.isAllowed(project(), join(project(), "sub", ".env"))).toBe(false);
    expect(s.isAllowed(outside, join(outside, ".env"))).toBe(false);
    expect(s.isAllowed(project(), join(outside, ".env"))).toBe(false);
  });

  test("isAllowed tidak pernah melempar untuk masukan aneh", () => {
    const s = store();
    expect(s.isAllowed(project(), "")).toBe(false);
    expect(s.isAllowed(project(), "bukan/absolut")).toBe(false);
  });

  test(":memory: bekerja tanpa berkas", () => {
    const s = new FileSecretAllowStore(":memory:");
    s.add(project(), ".env");
    expect(s.list(project())).toEqual([".env"]);
    expect(existsSync(storePath)).toBe(false);
  });

  test("defaultSecretAllowStore mati lewat env", () => {
    const env = { JEJAK_HOME: join(root, "home") };
    expect(defaultSecretAllowStore(env)?.list(project())).toEqual([]);
    expect(defaultSecretAllowStore({ ...env, JEJAK_SECRET_BLOCK: "0" })).toBeUndefined();
    expect(defaultSecretAllowStore({ ...env, JEJAK_PERSIST: "0" })).toBeUndefined();
  });
});
