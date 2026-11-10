import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeConfigError,
  FileClaudeConfigStore,
  MAX_PROJECTS,
  MAX_SKILLS_PER_LIST,
  defaultClaudeConfigStore,
} from "../src/server/claude-config/config-store";

let root: string;
let storePath: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-claude-config-"));
  storePath = join(root, "home", "claude-config.json");
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = realpathSync(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(): FileClaudeConfigStore {
  return new FileClaudeConfigStore(storePath);
}

describe("FileClaudeConfigStore", () => {
  test("default: userSettings mati, hooks nyala", () => {
    const s = store();
    expect(s.get()).toEqual({
      userSettings: false,
      hooksEnabled: true,
      disabledSkills: { user: [], projects: {} },
    });
    expect(s.disabledFor(project)).toEqual([]);
  });

  test("setFlags dan persistensi antar instance", () => {
    const s = store();
    expect(s.setFlags({ userSettings: true })).toMatchObject({ userSettings: true });
    expect(s.setFlags({ hooksEnabled: false })).toMatchObject({ hooksEnabled: false });

    const reopened = store();
    expect(reopened.get()).toMatchObject({ userSettings: true, hooksEnabled: false });
  });

  test("setSkillEnabled pengguna dan proyek, disabledFor gabungan unik", () => {
    const s = store();
    s.setSkillEnabled("user", undefined, "pdf", false);
    s.setSkillEnabled("project", project, "pdf", false);
    s.setSkillEnabled("project", project, "docx", false);
    expect(s.disabledFor(project)).toEqual(["docx", "pdf"]);
    expect(s.disabledFor(join(root, "lain"))).toEqual(["pdf"]);

    s.setSkillEnabled("project", project, "pdf", true);
    expect(s.disabledFor(project)).toEqual(["docx", "pdf"]);
    s.setSkillEnabled("user", undefined, "pdf", true);
    expect(s.disabledFor(project)).toEqual(["docx"]);

    s.setSkillEnabled("project", project, "docx", true);
    expect(s.get().disabledSkills.projects[project]).toBeUndefined();
  });

  test("mengaktifkan skill yang sudah aktif tidak menulis entri", () => {
    const s = store();
    s.setSkillEnabled("project", project, "baru", true);
    expect(s.get().disabledSkills.projects).toEqual({});
  });

  test("nama skill tak valid ditolak", () => {
    const s = store();
    for (const name of ["", "Pdf", "-awal", "a".repeat(65), "../x", "a b"]) {
      expect(() => s.setSkillEnabled("user", undefined, name, false)).toThrow(ClaudeConfigError);
    }
    expect(() => s.setFlags({ userSettings: "ya" as unknown as boolean })).toThrow(
      ClaudeConfigError,
    );
  });

  test("berkas rusak diperlakukan default dan tidak ditimpa sampai set", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(storePath, "{ bukan json", "utf8");
    const s = store();
    expect(s.get()).toEqual({
      userSettings: false,
      hooksEnabled: true,
      disabledSkills: { user: [], projects: {} },
    });
    expect(await readFile(storePath, "utf8")).toBe("{ bukan json");

    s.setFlags({ userSettings: true });
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
      version: number;
      userSettings: boolean;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.userSettings).toBe(true);
  });

  test("entri tak valid pada berkas disaring", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        userSettings: "ya",
        hooksEnabled: false,
        disabledSkills: {
          user: ["ok", "BURUK", 42, "ok"],
          projects: { [project]: ["satu"], [join(root, "lain")]: [] },
        },
      }),
      "utf8",
    );
    const s = store();
    expect(s.get().userSettings).toBe(false);
    expect(s.get().hooksEnabled).toBe(false);
    expect(s.get().disabledSkills.user).toEqual(["ok"]);
    expect(s.get().disabledSkills.projects).toEqual({ [project]: ["satu"] });
  });

  test(`batas ${MAX_PROJECTS} proyek dan ${MAX_SKILLS_PER_LIST} nama`, async () => {
    const projects: Record<string, string[]> = {};
    for (let index = 0; index < MAX_PROJECTS; index += 1) {
      projects[join(root, `p-${index}`)] = ["satu"];
    }
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(storePath, JSON.stringify({ version: 1, disabledSkills: { user: [], projects } }));
    const s = store();
    expect(() => s.setSkillEnabled("project", join(root, "baru"), "satu", false)).toThrow(
      "Batas",
    );

    const names = Array.from({ length: MAX_SKILLS_PER_LIST }, (_, index) => `s-${index}`);
    const s2 = new FileClaudeConfigStore(":memory:");
    for (const name of names) s2.setSkillEnabled("user", undefined, name, false);
    expect(() => s2.setSkillEnabled("user", undefined, "s-baru", false)).toThrow("Batas");
  });

  test("mode berkas 0600 dan direktori 0700", async () => {
    store().setFlags({ userSettings: true });
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "home"))).mode & 0o777).toBe(0o700);
  });

  test(":memory: bekerja tanpa berkas", () => {
    const s = new FileClaudeConfigStore(":memory:");
    s.setFlags({ userSettings: true });
    expect(s.get().userSettings).toBe(true);
    expect(existsSync(storePath)).toBe(false);
  });

  test("defaultClaudeConfigStore memakai env dan kill switch", () => {
    const env = { JEJAK_HOME: join(root, "home") };
    expect(defaultClaudeConfigStore(env)?.get().userSettings).toBe(false);
    expect(defaultClaudeConfigStore({ ...env, JEJAK_USER_SETTINGS: "1" })?.get().userSettings).toBe(
      true,
    );
    expect(defaultClaudeConfigStore({ ...env, JEJAK_CLAUDE_CONFIG: "0" })).toBeUndefined();
    expect(defaultClaudeConfigStore({ ...env, JEJAK_PERSIST: "0" })).toBeDefined();
  });

  test("env hanya default awal bila berkas sudah ada", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, userSettings: false, hooksEnabled: true, disabledSkills: {} }),
      "utf8",
    );
    const s = defaultClaudeConfigStore({
      JEJAK_HOME: join(root, "home"),
      JEJAK_USER_SETTINGS: "1",
    });
    expect(s?.get().userSettings).toBe(false);
  });
});
