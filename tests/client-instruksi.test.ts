import { describe, expect, test } from "bun:test";
import type { ClaudeHookItem, ClaudeSkillItem } from "../src/client/lib/api";
import {
  INSTRUKSI_MAX_BYTES,
  byteLength,
  hookEventLine,
  hookSourceLabel,
  isDirty,
  overLimit,
  projectChoices,
  scopeLabel,
  skillBadge,
  skillTemplate,
  validSkillName,
} from "../src/client/lib/instruksi";

describe("projectChoices", () => {
  test("folder sesi unik terurut kemunculan, cwd bawaan terakhir sebagai cadangan", () => {
    const choices = projectChoices(
      [{ cwd: "/kerja/a" }, { cwd: "/kerja/b" }, { cwd: "/kerja/a" }],
      "/kerja/default",
    );
    expect(choices.map((choice) => choice.cwd)).toEqual([
      "/kerja/a",
      "/kerja/b",
      "/kerja/default",
    ]);
  });

  test("tanpa default dan cwd kosong dilewati", () => {
    const choices = projectChoices([{ cwd: "" }, { cwd: "/x" }]);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.cwd).toBe("/x");
  });

  test("label memakai shortPath", () => {
    const short = "/kerja/a";
    expect(projectChoices([{ cwd: short }], short)[0]?.label).toBe(short);
    const long = "/Users/seseorang/proyek/yang/nama-foldernya-cukup-panjang-sekali";
    expect(projectChoices([{ cwd: long }])[0]?.label.startsWith("…/")).toBe(true);
  });
});

describe("validSkillName", () => {
  test("nama sah", () => {
    expect(validSkillName("a")).toBe(true);
    expect(validSkillName("skill-1")).toBe(true);
    expect(validSkillName("a".repeat(64))).toBe(true);
  });

  test("nama tidak sah", () => {
    expect(validSkillName("")).toBe(false);
    expect(validSkillName("Huruf")).toBe(false);
    expect(validSkillName("-awal")).toBe(false);
    expect(validSkillName("a".repeat(65))).toBe(false);
    expect(validSkillName("spasi ada")).toBe(false);
  });
});

describe("skillTemplate", () => {
  test("frontmatter dan isi kosong", () => {
    expect(skillTemplate("contoh")).toBe("---\nname: contoh\ndescription: \n---\n\n");
  });
});

describe("isDirty dan batas ukuran", () => {
  test("dirty hanya bila berbeda", () => {
    expect(isDirty("a", "a")).toBe(false);
    expect(isDirty("a", "b")).toBe(true);
  });

  test("byteLength menghitung UTF-8", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
  });

  test("overLimit pada batas 256 KB", () => {
    expect(overLimit("a".repeat(INSTRUKSI_MAX_BYTES))).toBe(false);
    expect(overLimit("a".repeat(INSTRUKSI_MAX_BYTES + 1))).toBe(true);
  });
});

describe("label", () => {
  test("scopeLabel", () => {
    expect(scopeLabel("project")).toBe("Proyek");
    expect(scopeLabel("user")).toBe("Pengguna");
  });

  test("hookSourceLabel", () => {
    expect(hookSourceLabel("proyek")).toBe("Proyek");
    expect(hookSourceLabel("proyek-lokal")).toBe("Proyek (lokal)");
    expect(hookSourceLabel("pengguna")).toBe("Pengguna");
  });

  test("hookEventLine menyertakan matcher bila ada", () => {
    const base: ClaudeHookItem = {
      source: "proyek",
      event: "PreToolUse",
      command: "echo",
      active: true,
    };
    expect(hookEventLine(base)).toBe("PreToolUse");
    expect(hookEventLine({ ...base, matcher: "Bash" })).toBe("PreToolUse · Bash");
  });
});

describe("skillBadge", () => {
  function skill(overrides: Partial<ClaudeSkillItem> = {}): ClaudeSkillItem {
    return {
      scope: "project",
      name: "contoh",
      description: "",
      path: "/p/.claude/skills/contoh/SKILL.md",
      enabled: true,
      ...overrides,
    };
  }

  test("aktif, nonaktif, dan tidak valid", () => {
    expect(skillBadge(skill())).toBe("aktif");
    expect(skillBadge(skill({ enabled: false }))).toBe("nonaktif");
    expect(skillBadge(skill({ invalid: "terlalu besar" }))).toBe("tidak valid: terlalu besar");
  });
});
