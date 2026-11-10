import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstructionsError,
  MAX_INSTRUCTIONS_BYTES,
  instructionPath,
  readInstructions,
  writeInstructions,
} from "../src/server/claude-config/instructions";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-claude-instruksi-"));
  home = join(root, "rumah");
  project = join(root, "proyek");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("instruksi CLAUDE.md", () => {
  test("jalur tetap per cakupan", () => {
    expect(instructionPath("project", project, home)).toBe(join(project, "CLAUDE.md"));
    expect(instructionPath("user", project, home)).toBe(join(home, ".claude", "CLAUDE.md"));
  });

  test("baca berkas yang belum ada", () => {
    const projectRead = readInstructions("project", project, home);
    expect(projectRead).toEqual({
      path: join(project, "CLAUDE.md"),
      exists: false,
      content: "",
    });
    expect(readInstructions("user", undefined, home)).toMatchObject({ exists: false });
  });

  test("tulis lalu baca; direktori .claude pengguna dibuat", async () => {
    const written = writeInstructions("project", project, "# Proyek\n", home);
    expect(written.exists).toBe(true);
    expect(readInstructions("project", project, home).content).toBe("# Proyek\n");

    writeInstructions("user", undefined, "# Pribadi\n", home);
    expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("# Pribadi\n");
    expect(readInstructions("user", undefined, home)).toMatchObject({
      exists: true,
      content: "# Pribadi\n",
    });
  });

  test("tulis atomik tidak meninggalkan berkas sementara", async () => {
    writeInstructions("project", project, "isi", home);
    const names = readdirSync(project);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // Berkas akhir 0644 dan bukan symlink.
    expect((await stat(join(project, "CLAUDE.md"))).mode & 0o777).toBe(0o644);
  });

  test("batas 256 KB saat tulis dan baca", async () => {
    const tooBig = "a".repeat(MAX_INSTRUCTIONS_BYTES + 1);
    try {
      writeInstructions("project", project, tooBig, home);
      throw new Error("seharusnya melempar");
    } catch (error) {
      expect(error).toBeInstanceOf(InstructionsError);
      expect((error as InstructionsError).code).toBe("terlalu-besar");
    }

    await writeFile(join(project, "CLAUDE.md"), tooBig, "utf8");
    expect(() => readInstructions("project", project, home)).toThrow(InstructionsError);
    expect(() => readInstructions("project", project, home)).toThrow("256 KB");
  });

  test("cwd wajib absolut dan ada", async () => {
    expect(() => instructionPath("project", "relatif", home)).toThrow("absolut");
    expect(() => instructionPath("project", join(root, "tidak-ada"), home)).toThrow("direktori");
    expect(() => writeInstructions("project", join(root, "tidak-ada"), "x", home)).toThrow(
      InstructionsError,
    );
    expect(() => readInstructions("project", "", home)).toThrow(InstructionsError);
  });

  test("cakupan tak dikenal ditolak", () => {
    expect(() => instructionPath("lain" as never, project, home)).toThrow(InstructionsError);
  });

  test("isi harus teks", () => {
    expect(() => writeInstructions("project", project, 42 as never, home)).toThrow(
      InstructionsError,
    );
  });
});
