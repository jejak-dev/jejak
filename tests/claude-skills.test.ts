import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SKILL_BYTES,
  SkillError,
  listSkills,
  parseDescription,
  readSkill,
  writeSkill,
} from "../src/server/claude-config/skills";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-claude-skills-"));
  home = join(root, "rumah");
  project = join(root, "proyek");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  project = await realpath(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeSkill(
  base: string,
  name: string,
  content: string,
): Promise<void> {
  await mkdir(join(base, name), { recursive: true });
  await writeFile(join(base, name, "SKILL.md"), content, "utf8");
}

const PDF = `---\nname: pdf\ndescription: "Membaca dokumen PDF"\n---\n\nIsi skill.\n`;

describe("skills", () => {
  test("frontmatter sederhana", () => {
    expect(parseDescription(PDF)).toBe("Membaca dokumen PDF");
    expect(parseDescription("---\ndescription: Tanpa kutip\n---\n")).toBe("Tanpa kutip");
    expect(parseDescription("tanpa frontmatter")).toBe("");
    expect(parseDescription("---\nname: x\n---\n")).toBe("");
    expect(parseDescription("---\ndescription: 'kutip tunggal'\n---\n")).toBe("kutip tunggal");
  });

  test("daftar proyek dan pengguna, urut, hanya yang punya SKILL.md", async () => {
    await makeSkill(join(project, ".claude", "skills"), "pdf", PDF);
    await makeSkill(join(project, ".claude", "skills"), "alpha", "---\ndescription: A\n---\n");
    await mkdir(join(project, ".claude", "skills", "kosong"), { recursive: true });
    await mkdir(join(project, ".claude", "skills", "BURUK"), { recursive: true });
    await writeFile(join(project, ".claude", "skills", "BURUK", "SKILL.md"), "x");
    await makeSkill(join(home, ".claude", "skills"), "docx", "---\ndescription: D\n---\n");

    const skills = listSkills(project, home, ["alpha"]);
    expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
      "project:alpha",
      "project:pdf",
      "user:docx",
    ]);
    expect(skills[0]).toMatchObject({
      description: "A",
      enabled: false,
      path: join(project, ".claude", "skills", "alpha", "SKILL.md"),
    });
    expect(skills[1]).toMatchObject({ description: "Membaca dokumen PDF", enabled: true });
    expect(skills[2]).toMatchObject({ scope: "user", description: "D" });
    expect(skills.some((skill) => skill.invalid !== undefined)).toBe(false);
  });

  test("SKILL.md terlalu besar ditandai invalid", async () => {
    await makeSkill(
      join(project, ".claude", "skills"),
      "besar",
      "a".repeat(MAX_SKILL_BYTES + 1),
    );
    const skills = listSkills(project, home, []);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.invalid).toContain("256 KB");
    expect(skills[0]?.description).toBe("");
  });

  test("baca skill dan 404 untuk yang tak ada", async () => {
    await makeSkill(join(project, ".claude", "skills"), "pdf", PDF);
    const skill = readSkill("project", "pdf", project, home);
    expect(skill.content).toBe(PDF);
    expect(skill.description).toBe("Membaca dokumen PDF");

    try {
      readSkill("project", "tidak-ada", project, home);
      throw new Error("seharusnya melempar");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillError);
      expect((error as SkillError).code).toBe("tidak-ditemukan");
    }
  });

  test("tulis membuat direktori bila belum ada, lalu baca", async () => {
    const written = writeSkill("user", "baru", "---\ndescription: Baru\n---\n", undefined, home);
    expect(written.description).toBe("Baru");
    expect(readSkill("user", "baru", undefined, home).content).toContain("Baru");
    writeSkill("project", "baru", "---\ndescription: Proyek\n---\n", project, home);
    expect(readSkill("project", "baru", project, home).description).toBe("Proyek");
  });

  test("nama tak valid ditolak", () => {
    for (const name of ["", "Pdf", "-x", "a".repeat(65), "../keluar", "a/b"]) {
      expect(() => readSkill("user", name, undefined, home)).toThrow(SkillError);
      expect(() => writeSkill("user", name, "x", undefined, home)).toThrow(SkillError);
    }
  });

  test("isi terlalu besar ditolak saat tulis", () => {
    expect(() =>
      writeSkill("user", "besar", "a".repeat(MAX_SKILL_BYTES + 1), undefined, home),
    ).toThrow("256 KB");
  });

  test("menolak symlink keluar dari akar skills", async () => {
    const outside = join(root, "luar");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "---\ndescription: luar\n---\n");
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await symlink(outside, join(project, ".claude", "skills", "tautan"));

    // Daftar melewati symlink keluar; baca/tulis menolak.
    expect(listSkills(project, home, []).map((skill) => skill.name)).toEqual([]);
    expect(() => readSkill("project", "tautan", project, home)).toThrow("di luar folder skills");
    expect(() => writeSkill("project", "tautan", "x", project, home)).toThrow(
      "di luar folder skills",
    );
  });
});
