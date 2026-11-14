import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const names = await readdir(dir);
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) {
      found.push(...(await listSourceFiles(path)));
    } else if (/\.(ts|tsx)$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

test("private tetap true agar tidak terpublikasi tidak sengaja", async () => {
  expect((await readManifest()).private).toBe(true);
});

test("files tidak memuat tests dan memuat src", async () => {
  const files = (await readManifest()).files as string[];
  expect(files).toContain("src/");
  expect(files).toContain("INSTALL.md");
  expect(files).toContain("INSTALL.id.md");
  expect(files).toContain("install.sh");
  expect(files.some((entry) => entry.startsWith("tests"))).toBe(false);
  expect(files.some((entry) => entry.includes("ROADMAP"))).toBe(false);
});

test("bin jejak ada, berkas ada, dan diawali shebang bun", async () => {
  const bin = (await readManifest()).bin as Record<string, string>;
  expect(bin.jejak).toBeDefined();
  const path = join(root, bin.jejak ?? "");
  expect((await stat(path)).isFile()).toBe(true);
  const first = (await readFile(path, "utf8")).split("\n")[0];
  expect(first).toBe("#!/usr/bin/env bun");
});

test("tidak ada impor @jejak/ di src", async () => {
  const files = await listSourceFiles(join(root, "src"));
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.includes("@jejak/")) {
      offenders.push(relative(root, file));
    }
  }
  expect(offenders).toEqual([]);
});
