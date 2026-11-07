import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientBundle } from "../src/server/client-bundle";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-client-bundle-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildClientBundle", () => {
  test("menghasilkan js dan css dari entri bawaan", async () => {
    const bundle = await buildClientBundle();
    expect(bundle.js.length).toBeGreaterThan(0);
    expect(bundle.js).toContain("Jejak");
    expect(bundle.css.length).toBeGreaterThan(0);
    expect(bundle.css).toContain("--ink");
  });

  test("entri dengan sintaks rusak melempar Error Bahasa Indonesia", async () => {
    const entry = join(dir, "rusak.tsx");
    await writeFile(entry, "export const x = <div>;\n", "utf8");

    let error: unknown;
    try {
      await buildClientBundle(entry);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("gagal membangun klien");
    expect(message).not.toContain(dir);
  });
});
