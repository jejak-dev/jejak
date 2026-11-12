import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageRunner,
  PACKAGE_SCRIPTS_MAX,
  quoteScriptName,
  readPackageScripts,
  scriptId,
} from "../src/server/runner/package-scripts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-runner-scripts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tulisPackage(data: unknown): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    typeof data === "string" ? data : JSON.stringify(data),
    "utf8",
  );
}

describe("script package.json", () => {
  test("package.json di folder sendiri dibaca sebagai script", async () => {
    await tulisPackage({ scripts: { test: "bun test", build: "bun run build" } });
    const scripts = readPackageScripts(dir);
    expect(scripts.map((item) => item.label)).toEqual(["test", "build"]);
    expect(scripts[0]?.command).toBe("bun run test");
    expect(scripts[0]?.id).toBe(scriptId("test"));
    expect(scripts[0]?.id).toMatch(/^p_[0-9a-f]{8}$/);
  });

  test("folder induk tidak dibaca", async () => {
    await tulisPackage({ scripts: { test: "bun test" } });
    const anak = join(dir, "sub");
    await mkdir(anak, { recursive: true });
    expect(readPackageScripts(anak)).toEqual([]);
  });

  test("lockfile menentukan pengelola paket", async () => {
    await tulisPackage({ scripts: { test: "bun test" } });

    await writeFile(join(dir, "bun.lock"), "", "utf8");
    expect(detectPackageRunner(dir)).toBe("bun run");
    expect(readPackageScripts(dir)[0]?.command).toBe("bun run test");

    const proyek = async (nama: string, lockfile: string): Promise<string> => {
      const folder = join(dir, nama);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
      await writeFile(join(folder, lockfile), "", "utf8");
      return folder;
    };

    const bunLockb = await proyek("bun-lockb", "bun.lockb");
    expect(detectPackageRunner(bunLockb)).toBe("bun run");
    expect(readPackageScripts(bunLockb)[0]?.command).toBe("bun run test");

    const pnpm = await proyek("pnpm", "pnpm-lock.yaml");
    expect(detectPackageRunner(pnpm)).toBe("pnpm run");
    expect(readPackageScripts(pnpm)[0]?.command).toBe("pnpm run test");

    const yarn = await proyek("yarn", "yarn.lock");
    expect(detectPackageRunner(yarn)).toBe("yarn run");
    expect(readPackageScripts(yarn)[0]?.command).toBe("yarn run test");

    const npm = await proyek("npm", "package-lock.json");
    expect(detectPackageRunner(npm)).toBe("npm run");
    expect(readPackageScripts(npm)[0]?.command).toBe("npm run test");
  });

  test("tanpa lockfile memakai bun run", async () => {
    await tulisPackage({ scripts: { test: "bun test" } });
    expect(detectPackageRunner(dir)).toBe("bun run");
    expect(readPackageScripts(dir)[0]?.command).toBe("bun run test");
  });

  test("nama aneh di-quote dengan kutip tunggal", async () => {
    await tulisPackage({ scripts: { "nama dengan spasi": "echo hai", "a'b": "echo kutip" } });
    const scripts = readPackageScripts(dir);
    expect(scripts[0]?.command).toBe("bun run 'nama dengan spasi'");
    expect(scripts[1]?.command).toBe("bun run 'a'\\''b'");
    expect(quoteScriptName("biasa")).toBe("biasa");
    expect(quoteScriptName("a-b.c:d_e")).toBe("a-b.c:d_e");
  });

  test("package.json rusak, tak ada, atau bukan objek memberi daftar kosong", async () => {
    await tulisPackage("{rusak");
    expect(readPackageScripts(dir)).toEqual([]);
    await tulisPackage([1, 2, 3]);
    expect(readPackageScripts(dir)).toEqual([]);
    await tulisPackage("teks");
    expect(readPackageScripts(dir)).toEqual([]);
    await rm(join(dir, "package.json"));
    expect(readPackageScripts(dir)).toEqual([]);
  });

  test("script non-string diabaikan", async () => {
    await tulisPackage({
      scripts: { test: "bun test", angka: 42, objek: { a: 1 }, kosong: null },
    });
    const scripts = readPackageScripts(dir);
    expect(scripts.map((item) => item.label)).toEqual(["test"]);
  });

  test("nama kosong, terlalu panjang, atau berkarakter kontrol diabaikan", async () => {
    await tulisPackage({
      scripts: {
        "": "echo kosong",
        ["x".repeat(61)]: "echo panjang",
        "buruk\n": "echo baris",
        baik: "bun test",
      },
    });
    const scripts = readPackageScripts(dir);
    expect(scripts.map((item) => item.label)).toEqual(["baik"]);
  });

  test("lebih dari 100 script dipotong", async () => {
    const scripts: Record<string, string> = {};
    for (let index = 0; index < 130; index += 1) scripts[`s${index}`] = "bun test";
    await tulisPackage({ scripts });
    const hasil = readPackageScripts(dir);
    expect(hasil).toHaveLength(PACKAGE_SCRIPTS_MAX);
    expect(hasil[0]?.label).toBe("s0");
  });

  test("package.json lebih dari 256 KB tidak dibaca", async () => {
    const scripts: Record<string, string> = { test: "x".repeat(300 * 1024) };
    await tulisPackage({ scripts });
    expect(readPackageScripts(dir)).toEqual([]);
  });

  test("folder tanpa scripts memberi daftar kosong", async () => {
    await tulisPackage({ name: "tanpa-script" });
    expect(readPackageScripts(dir)).toEqual([]);
  });
});
