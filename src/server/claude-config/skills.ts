import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export type SkillScope = "user" | "project";

export interface SkillInfo {
  scope: SkillScope;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  /** Alasan skill tidak dapat dipakai (mis. berkas terlalu besar). */
  invalid?: string;
}

export interface SkillFile extends SkillInfo {
  content: string;
}

export type SkillErrorCode = "tidak-valid" | "tidak-ditemukan" | "terlalu-besar";

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly code: SkillErrorCode,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

export const MAX_SKILLS = 200;
export const MAX_SKILL_BYTES = 256 * 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TOO_BIG = "SKILL.md melebihi batas 256 KB.";

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

function validateCwd(cwd: string | undefined): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new SkillError("cwd wajib diisi untuk cakupan proyek.", "tidak-valid");
  }
  if (!isAbsolute(cwd)) {
    throw new SkillError("cwd harus berupa path absolut.", "tidak-valid");
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new SkillError("cwd tidak ditemukan atau bukan direktori.", "tidak-valid");
  }
  return cwd;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError("Nama skill tidak valid.", "tidak-valid");
  }
  return name;
}

/** Akar skills untuk satu cakupan; jalur tetap, bukan dari klien. */
export function skillsRoot(scope: SkillScope, cwd: string | undefined, home?: string): string {
  if (scope === "user") return join(homeDir(home), ".claude", "skills");
  if (scope !== "project") {
    throw new SkillError("Cakupan skill hanya user atau project.", "tidak-valid");
  }
  return join(validateCwd(cwd), ".claude", "skills");
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(rootReal: string, target: string): boolean {
  return target === rootReal || target.startsWith(rootReal + sep);
}

/** Tolak jalur (termasuk symlink) yang keluar dari akar skills. */
function assertInside(rootReal: string, target: string): void {
  const real = realOrSelf(target);
  if (!isInside(rootReal, real)) {
    throw new SkillError("Jalur skill di luar folder skills.", "tidak-valid");
  }
}

/** Ambil `description` dari frontmatter YAML sederhana tanpa dependensi. */
export function parseDescription(content: string): string {
  if (!content.startsWith("---")) return "";
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") break;
    const match = /^description\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    return value;
  }
  return "";
}

function readSkillFile(path: string): { content: string; invalid?: string } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { content: "" };
  }
  if (size > MAX_SKILL_BYTES) return { content: "", invalid: TOO_BIG };
  try {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      return { content: "", invalid: TOO_BIG };
    }
    return { content };
  } catch {
    return { content: "", invalid: "SKILL.md tidak dapat dibaca." };
  }
}

function listScope(
  scope: SkillScope,
  cwd: string | undefined,
  home: string | undefined,
  disabled: readonly string[],
  limit: number,
): SkillInfo[] {
  const root = skillsRoot(scope, cwd, home);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: SkillInfo[] = [];
  const names = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const rootReal = realOrSelf(root);
  for (const name of names) {
    if (result.length >= limit) break;
    if (!SKILL_NAME_PATTERN.test(name)) continue;
    const dir = join(root, name);
    // Symlink yang keluar akar skills tidak didaftarkan (ditolak juga oleh baca/tulis).
    if (existsSync(dir) && !isInside(rootReal, realOrSelf(dir))) continue;
    const path = join(dir, "SKILL.md");
    if (!existsSync(path)) continue;
    const read = readSkillFile(path);
    const info: SkillInfo = {
      scope,
      name,
      description: read.invalid === undefined ? parseDescription(read.content) : "",
      path,
      enabled: !disabled.includes(name),
    };
    if (read.invalid !== undefined) info.invalid = read.invalid;
    result.push(info);
  }
  return result;
}

export function listSkills(
  cwd: string | undefined,
  home: string | undefined,
  disabled: readonly string[] = [],
): SkillInfo[] {
  const project = cwd === undefined ? [] : listScope("project", cwd, home, disabled, MAX_SKILLS);
  const user = listScope("user", cwd, home, disabled, Math.max(0, MAX_SKILLS - project.length));
  return [...project, ...user];
}

function skillPath(
  scope: SkillScope,
  name: string,
  cwd: string | undefined,
  home: string | undefined,
): { root: string; rootReal: string; dir: string; path: string } {
  const root = skillsRoot(scope, cwd, home);
  const rootReal = realOrSelf(root);
  const dir = join(root, name);
  const path = join(dir, "SKILL.md");
  if (existsSync(dir)) assertInside(rootReal, dir);
  if (existsSync(path)) assertInside(rootReal, path);
  return { root, rootReal, dir, path };
}

export function readSkill(
  scope: SkillScope,
  name: unknown,
  cwd?: string,
  home?: string,
): SkillFile {
  const skill = validateName(name);
  const { path } = skillPath(scope, skill, cwd, home);
  if (!existsSync(path)) {
    throw new SkillError(`Skill "${skill}" tidak ditemukan.`, "tidak-ditemukan");
  }
  const read = readSkillFile(path);
  if (read.invalid !== undefined) {
    throw new SkillError(read.invalid, "terlalu-besar");
  }
  return {
    scope,
    name: skill,
    description: parseDescription(read.content),
    path,
    enabled: true,
    content: read.content,
  };
}

export function writeSkill(
  scope: SkillScope,
  name: unknown,
  content: string,
  cwd?: string,
  home?: string,
): SkillFile {
  const skill = validateName(name);
  if (typeof content !== "string") {
    throw new SkillError("Isi SKILL.md harus berupa teks.", "tidak-valid");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    throw new SkillError(TOO_BIG, "terlalu-besar");
  }
  const { root, dir, path } = skillPath(scope, skill, cwd, home);

  if (!existsSync(dir) && listSkillsExcluding(scope, cwd, home) >= MAX_SKILLS) {
    throw new SkillError(`Batas ${MAX_SKILLS} skill terlampaui.`, "tidak-valid");
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Akar bisa baru dibuat (atau berada di bawah symlink seperti /var); hitung
  // realpath setelah direktori ada agar pemeriksaan tidak salah tolak.
  assertInside(realOrSelf(root), dir);
  const tempPath = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { mode: 0o644 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Berkas sementara mungkin sudah hilang; galat asli yang dilempar.
    }
    throw error;
  }
  return {
    scope,
    name: skill,
    description: parseDescription(content),
    path,
    enabled: true,
    content,
  };
}

/** Jumlah skill yang sudah ada (untuk pemeriksaan batas tulis). */
function listSkillsExcluding(
  scope: SkillScope,
  cwd: string | undefined,
  home: string | undefined,
): number {
  let entries;
  try {
    entries = readdirSync(skillsRoot(scope, cwd, home), { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((entry) => entry.isDirectory()).length;
}
