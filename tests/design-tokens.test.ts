import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesignTokenError, readTokens, writeTokens } from "../src/server/design/tokens";
import { initDesign } from "../src/server/design/write";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-tokens-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-tokens-luar-"));
  await initDesign(dir, { tracked: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function tokensPath(): string {
  return join(dir, "design", "tokens.css");
}

function statusOf(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => 0,
    (error: unknown) => {
      expect(error).toBeInstanceOf(DesignTokenError);
      return (error as DesignTokenError).status;
    },
  );
}

function messageOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "",
    (error: unknown) => {
      expect(error).toBeInstanceOf(DesignTokenError);
      return (error as DesignTokenError).message;
    },
  );
}

async function noTempFiles(): Promise<void> {
  const names = await readdir(join(dir, "design"));
  expect(names.filter((name) => name.startsWith(".jejak-tokens-") && name.endsWith(".tmp"))).toEqual(
    [],
  );
}

describe("readTokens", () => {
  test("baca token bawaan perancah", async () => {
    const hasil = await readTokens(dir);
    expect(hasil.mtime).toBeGreaterThan(0);
    expect(hasil.tokens.map((token) => token.name)).toEqual([
      "--warna-latar",
      "--warna-permukaan",
      "--warna-teks",
      "--warna-teks-redup",
      "--warna-aksen",
      "--warna-garis",
      "--radius",
      "--jarak",
      "--font-sans",
    ]);
    expect(hasil.tokens[0]).toEqual({ name: "--warna-latar", value: "#f7f7f8" });
  });

  test("folder desain atau berkas belum ada -> kosong", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-tokens-kosong-"));
    try {
      expect(await readTokens(kosong)).toEqual({ tokens: [], mtime: null });
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
    await rm(tokensPath(), { force: true });
    expect(await readTokens(dir)).toEqual({ tokens: [], mtime: null });
  });

  test("banyak blok :root digabung", async () => {
    await writeFile(
      tokensPath(),
      `:root {\n  --a: 1;\n}\n:root {\n  --b: 2;\n}\n:root {\n  --c: 3;\n}\n`,
      "utf8",
    );
    const { tokens } = await readTokens(dir);
    expect(tokens).toEqual([
      { name: "--a", value: "1" },
      { name: "--b", value: "2" },
      { name: "--c", value: "3" },
    ]);
  });

  test("komentar diabaikan dan nilai di-trim", async () => {
    await writeFile(
      tokensPath(),
      `/* :root { --x: 9; } */\n:root {\n  /* --b: 2; */\n  --a:   1  ;\n  --c: /*catatan*/ 3;\n}\n`,
      "utf8",
    );
    const { tokens } = await readTokens(dir);
    expect(tokens).toEqual([
      { name: "--a", value: "1" },
      { name: "--c", value: "3" },
    ]);
  });

  test("nilai bersarang tetap utuh", async () => {
    await writeFile(
      tokensPath(),
      `:root {\n  --a: var(--b, #fff);\n  --c: rgb(1, 2, 3);\n  --d: "font", sans-serif;\n  --e: 0 0 0 / 50%;\n}\n`,
      "utf8",
    );
    const { tokens } = await readTokens(dir);
    expect(tokens.map((token) => token.value)).toEqual([
      "var(--b, #fff)",
      "rgb(1, 2, 3)",
      '"font", sans-serif',
      "0 0 0 / 50%",
    ]);
  });

  test("deklarasi tak sah dilewati", async () => {
    await writeFile(
      tokensPath(),
      `:root {\n  --a: 1;\n  --nama.salah: 2;\n  --b: ;\n  --c: nilai{b;\n  --d: nilai}b;\n  --e: teks</script>;\n  tanpa-nama;\n  --f: 2;\n}\n`,
      "utf8",
    );
    const { tokens } = await readTokens(dir);
    expect(tokens).toEqual([
      { name: "--a", value: "1" },
      { name: "--f", value: "2" },
    ]);
  });

  test("nilai lebih dari 200 karakter dilewati", async () => {
    await writeFile(tokensPath(), `:root {\n  --a: ${"x".repeat(201)};\n  --b: 1;\n}\n`, "utf8");
    const { tokens } = await readTokens(dir);
    expect(tokens).toEqual([{ name: "--b", value: "1" }]);
  });

  test("maks 200 token", async () => {
    const body = Array.from({ length: 250 }, (_, i) => `  --t${i}: ${i};`).join("\n");
    await writeFile(tokensPath(), `:root {\n${body}\n}\n`, "utf8");
    const { tokens } = await readTokens(dir);
    expect(tokens).toHaveLength(200);
    expect(tokens[0]).toEqual({ name: "--t0", value: "0" });
  });

  test("blok di luar :root tidak dibaca", async () => {
    await writeFile(
      tokensPath(),
      `.lain {\n  --a: 1;\n}\n:root {\n  --b: 2;\n}\n`,
      "utf8",
    );
    const { tokens } = await readTokens(dir);
    expect(tokens).toEqual([{ name: "--b", value: "2" }]);
  });

  test("symlink dan berkas terlalu besar ditolak", async () => {
    await rm(tokensPath(), { force: true });
    await writeFile(join(outside, "luar.css"), ":root {\n  --a: 1;\n}\n", "utf8");
    await symlink(join(outside, "luar.css"), tokensPath());
    expect(await statusOf(readTokens(dir))).toBe(400);
    expect(await messageOf(readTokens(dir))).toBe("Berkas token tidak valid.");

    await rm(tokensPath(), { force: true });
    await writeFile(tokensPath(), "x".repeat(256 * 1024 + 1), "utf8");
    expect(await statusOf(readTokens(dir))).toBe(413);
  });
});

describe("writeTokens", () => {
  test("tulis lalu baca kembali (round-trip)", async () => {
    const tokens = [
      { name: "--warna-latar", value: "#ffffff" },
      { name: "--font-sans", value: 'system-ui, "Segoe UI", sans-serif' },
    ];
    const { mtime } = await writeTokens(dir, { tokens });
    expect(mtime).toBeGreaterThan(0);
    const read = await readTokens(dir);
    expect(read.tokens).toEqual(tokens);
    expect(read.mtime).toBe(mtime);
    await noTempFiles();
  });

  test("isi lain berkas di luar :root dipertahankan", async () => {
    await writeFile(
      tokensPath(),
      `/* catatan */\n:root {\n  --lama: 1;\n}\n.kelas {\n  color: red;\n}\n`,
      "utf8",
    );
    await writeTokens(dir, { tokens: [{ name: "--baru", value: "2" }] });
    const text = await readFile(tokensPath(), "utf8");
    expect(text).toContain(":root {");
    expect(text).toContain("--baru: 2;");
    expect(text).toContain("/* catatan */");
    expect(text).toContain(".kelas {");
    expect(text).not.toContain("--lama");
  });

  test("blok :root baru ditulis sebelum isi lain", async () => {
    await writeFile(tokensPath(), `.kelas {\n  color: red;\n}\n`, "utf8");
    await writeTokens(dir, { tokens: [{ name: "--a", value: "1" }] });
    const text = await readFile(tokensPath(), "utf8");
    expect(text.indexOf(":root {")).toBeLessThan(text.indexOf(".kelas {"));
  });

  test("nama dan nilai tak sah ditolak", async () => {
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "bukan", value: "1" }] }))).toBe(400);
    expect(await messageOf(writeTokens(dir, { tokens: [{ name: "bukan", value: "1" }] }))).toBe(
      "Nama token tidak valid.",
    );
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--a b", value: "1" }] }))).toBe(400);
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--a", value: "x{y" }] }))).toBe(400);
    expect(await messageOf(writeTokens(dir, { tokens: [{ name: "--a", value: "x{y" }] }))).toBe(
      "Nilai token tidak valid.",
    );
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--a", value: "" }] }))).toBe(400);
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--a", value: "x".repeat(201) }] }))).toBe(
      400,
    );
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--a", value: 5 } as never] }))).toBe(400);
  });

  test("nama ganda ditolak", async () => {
    expect(
      await statusOf(
        writeTokens(dir, {
          tokens: [
            { name: "--a", value: "1" },
            { name: "--a", value: "2" },
          ],
        }),
      ),
    ).toBe(400);
    expect(
      await messageOf(
        writeTokens(dir, {
          tokens: [
            { name: "--a", value: "1" },
            { name: "--a", value: "2" },
          ],
        }),
      ),
    ).toBe("Nama token ganda.");
  });

  test("lebih dari 200 token ditolak", async () => {
    const tokens = Array.from({ length: 201 }, (_, i) => ({ name: `--t${i}`, value: "1" }));
    expect(await statusOf(writeTokens(dir, { tokens }))).toBe(400);
    expect(await messageOf(writeTokens(dir, { tokens }))).toBe("Batas 200 token tercapai.");
  });

  test("baseMtime cocok ditulis, berbeda -> 409", async () => {
    const first = await writeTokens(dir, { tokens: [{ name: "--a", value: "1" }] });
    // Mtime digeser supaya berbeda dari nilai sebelumnya (ms yang sama bisa
    // menghasilkan mtime bulat yang sama).
    const geser = new Date((first.mtime + 5000) / 1000);
    await utimes(tokensPath(), geser, geser);
    expect(await statusOf(writeTokens(dir, { tokens: [], baseMtime: first.mtime }))).toBe(409);
    expect(await messageOf(writeTokens(dir, { tokens: [], baseMtime: first.mtime }))).toBe(
      "Token berubah sejak dibaca; muat ulang.",
    );
    expect(await statusOf(writeTokens(dir, { tokens: [], baseMtime: 1 }))).toBe(409);

    const current = await readTokens(dir);
    expect(current.mtime).not.toBe(first.mtime);
    const second = await writeTokens(dir, {
      tokens: [{ name: "--a", value: "2" }],
      baseMtime: current.mtime ?? undefined,
    });
    expect(second.mtime).toBeGreaterThan(0);
    expect((await readTokens(dir)).tokens).toEqual([{ name: "--a", value: "2" }]);
  });

  test("baseMtime tak sah -> 400", async () => {
    expect(await statusOf(writeTokens(dir, { tokens: [], baseMtime: "x" as never }))).toBe(400);
    expect(await messageOf(writeTokens(dir, { tokens: [], baseMtime: "x" as never }))).toBe(
      "baseMtime harus berupa bilangan.",
    );
  });

  test("desain belum dibuat -> 404", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-tokens-kosong-"));
    try {
      expect(await statusOf(writeTokens(kosong, { tokens: [] }))).toBe(404);
      expect(await messageOf(writeTokens(kosong, { tokens: [] }))).toBe("Desain belum dibuat.");
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });

  test("tokens.css symlink ditolak dan berkas luar tak berubah", async () => {
    const luar = join(outside, "luar.css");
    await writeFile(luar, ":root {\n  --a: 1;\n}\n", "utf8");
    await rm(tokensPath(), { force: true });
    await symlink(luar, tokensPath());
    expect(await statusOf(writeTokens(dir, { tokens: [{ name: "--b", value: "2" }] }))).toBe(400);
    expect(await messageOf(writeTokens(dir, { tokens: [{ name: "--b", value: "2" }] }))).toBe(
      "Berkas token tidak valid.",
    );
    expect(await readFile(luar, "utf8")).toBe(":root {\n  --a: 1;\n}\n");
  });

  test("tulis atomik: tak ada berkas sementara tersisa", async () => {
    await writeTokens(dir, { tokens: [{ name: "--a", value: "1" }] });
    await noTempFiles();
    const nama = await readdir(join(dir, "design"));
    expect(nama.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("berkas tanpa tokens.css dibuat baru", async () => {
    await rm(tokensPath(), { force: true });
    const { mtime } = await writeTokens(dir, { tokens: [{ name: "--a", value: "1" }] });
    expect(mtime).toBeGreaterThan(0);
    expect(await readFile(tokensPath(), "utf8")).toBe(":root {\n  --a: 1;\n}\n");
    await noTempFiles();
  });

  test("mode berkas lama dipertahankan", async () => {
    await writeTokens(dir, { tokens: [{ name: "--a", value: "1" }] });
    await chmod(tokensPath(), 0o640);
    await writeTokens(dir, { tokens: [{ name: "--a", value: "2" }] });
    expect((await lstat(tokensPath())).mode & 0o777).toBe(0o640);
  });
});
