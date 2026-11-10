import type { ClaudeHookItem, ClaudeScope, ClaudeSkillItem } from "./api";
import { shortPath } from "./format";

/** Batas isi CLAUDE.md/SKILL.md yang sama dengan server. */
export const INSTRUKSI_MAX_BYTES = 256 * 1024;

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ProjectChoice {
  cwd: string;
  label: string;
}

/**
 * Pilihan proyek dari sesi + cwd bawaan. Default dulu, lalu folder unik sesuai
 * urutan sesi; label memakai `shortPath`.
 */
export function projectChoices(
  sessions: readonly { cwd: string }[],
  defaultCwd?: string,
): ProjectChoice[] {
  const seen: string[] = [];
  for (const cwd of [defaultCwd, ...sessions.map((session) => session.cwd)]) {
    if (cwd === undefined || cwd === "" || seen.includes(cwd)) continue;
    seen.push(cwd);
  }
  return seen.map((cwd) => ({ cwd, label: shortPath(cwd) }));
}

export function validSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/** Kerangka SKILL.md baru: frontmatter nama + deskripsi kosong, isi kosong. */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n`;
}

export function isDirty(original: string, draft: string): boolean {
  return original !== draft;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function overLimit(text: string): boolean {
  return byteLength(text) > INSTRUKSI_MAX_BYTES;
}

export function scopeLabel(scope: ClaudeScope): string {
  return scope === "user" ? "Pengguna" : "Proyek";
}

export function hookSourceLabel(source: ClaudeHookItem["source"]): string {
  if (source === "pengguna") return "Pengguna";
  if (source === "proyek-lokal") return "Proyek (lokal)";
  return "Proyek";
}

/** `Event` atau `Event · matcher` bila hook punya matcher. */
export function hookEventLine(hook: ClaudeHookItem): string {
  return hook.matcher === undefined || hook.matcher === ""
    ? hook.event
    : `${hook.event} · ${hook.matcher}`;
}

export function skillBadge(skill: ClaudeSkillItem): string {
  if (skill.invalid !== undefined && skill.invalid !== "") {
    return `tidak valid: ${skill.invalid}`;
  }
  return skill.enabled ? "aktif" : "nonaktif";
}
