import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jejakHome } from "../provider-store";
import { PLUGIN_ID_PATTERN } from "./plugins";

/** Pengaturan sumber Claude per instalasi Jejak. */
export interface ClaudeConfig {
  /** Muat `~/.claude` (CLAUDE.md, skills, hooks) pada sesi. Default mati. */
  userSettings: boolean;
  /** Saklar global hooks berkas (bukan hook keamanan Jejak). Default nyala. */
  hooksEnabled: boolean;
  /** Skill yang dinonaktifkan; proyek dikunci per akar absolut. */
  disabledSkills: { user: string[]; projects: Record<string, string[]> };
  /** Plugin Claude Code yang diaktifkan; bentuk "nama@marketplace". */
  enabledPlugins: string[];
}

export interface ClaudeConfigStore {
  get(): ClaudeConfig;
  setFlags(flags: { userSettings?: boolean; hooksEnabled?: boolean }): ClaudeConfig;
  setSkillEnabled(
    scope: "user" | "project",
    projectRoot: string | undefined,
    name: string,
    enabled: boolean,
  ): ClaudeConfig;
  /** Nyalakan atau matikan satu plugin terpasang. */
  setPluginEnabled(id: string, enabled: boolean): ClaudeConfig;
  /** Nama nonaktif gabungan pengguna + proyek, unik. */
  disabledFor(projectRoot: string): string[];
}

export class ClaudeConfigError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ClaudeConfigError";
  }
}

export const CLAUDE_CONFIG_VERSION = 1;
export const MAX_PROJECTS = 200;
export const MAX_SKILLS_PER_LIST = 200;
export const MAX_ENABLED_PLUGINS = 100;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRoot(root: string): string {
  const resolved = resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) {
    throw new ClaudeConfigError("Nama skill tidak valid.");
  }
  return name;
}

function sanitizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SKILL_NAME_PATTERN.test(item)) continue;
    if (names.includes(item)) continue;
    names.push(item);
    if (names.length >= MAX_SKILLS_PER_LIST) break;
  }
  return names.sort();
}

/** Id plugin yang valid; bentuk "nama@marketplace". */
export function validatePluginId(id: unknown): string {
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    throw new ClaudeConfigError("Id plugin tidak valid.");
  }
  return id;
}

/** Saring id plugin dari berkas: pola valid, unik, terurut, terbatas. */
function sanitizePluginIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PLUGIN_ID_PATTERN.test(item)) continue;
    if (ids.includes(item)) continue;
    ids.push(item);
    if (ids.length >= MAX_ENABLED_PLUGINS) break;
  }
  return ids.sort();
}

function copyConfig(config: ClaudeConfig): ClaudeConfig {
  const projects: Record<string, string[]> = {};
  for (const [root, names] of Object.entries(config.disabledSkills.projects)) {
    projects[root] = [...names];
  }
  return {
    userSettings: config.userSettings,
    hooksEnabled: config.hooksEnabled,
    disabledSkills: { user: [...config.disabledSkills.user], projects },
    enabledPlugins: [...config.enabledPlugins],
  };
}

export function claudeConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "claude-config.json");
}

export function defaultClaudeConfigStore(
  env: Record<string, string | undefined> = process.env,
): ClaudeConfigStore | undefined {
  if (env.JEJAK_CLAUDE_CONFIG?.trim() === "0") return undefined;
  const defaults = { userSettings: env.JEJAK_USER_SETTINGS?.trim() === "1" };
  if (env.JEJAK_PERSIST?.trim() === "0") {
    return new FileClaudeConfigStore(":memory:", defaults);
  }
  return new FileClaudeConfigStore(claudeConfigPath(env), defaults);
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileClaudeConfigStore implements ClaudeConfigStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private readonly defaults: ClaudeConfig;
  private config: ClaudeConfig | undefined;
  private loaded = false;

  constructor(path: string, defaults: { userSettings?: boolean } = {}) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
    this.defaults = {
      userSettings: defaults.userSettings === true,
      hooksEnabled: true,
      disabledSkills: { user: [], projects: {} },
      enabledPlugins: [],
    };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.config = copyConfig(this.defaults);
    if (this.inMemory) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      // Berkas tak ada memakai default env; berkas tak terbaca lain juga
      // diperlakukan default dan tidak ditimpa sampai ada `set` pertama.
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      // Berkas rusak atau versi tak dikenal diperlakukan default tanpa env.
      if (!isRecord(parsed) || parsed.version !== CLAUDE_CONFIG_VERSION) return;
      const next: ClaudeConfig = {
        userSettings: parsed.userSettings === true,
        hooksEnabled: parsed.hooksEnabled !== false,
        disabledSkills: { user: [], projects: {} },
        enabledPlugins: sanitizePluginIds(parsed.enabledPlugins),
      };
      if (isRecord(parsed.disabledSkills)) {
        next.disabledSkills.user = sanitizeNames(parsed.disabledSkills.user);
        if (isRecord(parsed.disabledSkills.projects)) {
          let count = 0;
          for (const [root, value] of Object.entries(parsed.disabledSkills.projects)) {
            if (count >= MAX_PROJECTS) break;
            const names = sanitizeNames(value);
            if (names.length === 0) continue;
            next.disabledSkills.projects[root] = names;
            count += 1;
          }
        }
      }
      this.config = next;
    } catch {
      // JSON rusak: pakai default (tanpa env).
    }
  }

  private persist(): void {
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const config = this.config ?? this.defaults;
    const projects: Record<string, string[]> = {};
    for (const root of Object.keys(config.disabledSkills.projects).sort()) {
      const names = config.disabledSkills.projects[root];
      if (names !== undefined && names.length > 0) projects[root] = [...names].sort();
    }
    const body = `${JSON.stringify(
      {
        version: CLAUDE_CONFIG_VERSION,
        userSettings: config.userSettings,
        hooksEnabled: config.hooksEnabled,
        disabledSkills: { user: [...config.disabledSkills.user].sort(), projects },
        enabledPlugins: [...config.enabledPlugins].sort(),
      },
      null,
      2,
    )}\n`;
    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;

    try {
      writeFileSync(tempPath, body, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Berkas sementara mungkin sudah hilang; galat asli yang dilempar.
      }
      throw error;
    }
  }

  get(): ClaudeConfig {
    this.load();
    return copyConfig(this.config ?? this.defaults);
  }

  setFlags(flags: { userSettings?: boolean; hooksEnabled?: boolean }): ClaudeConfig {
    if (!isRecord(flags)) {
      throw new ClaudeConfigError("Pengaturan tidak valid.");
    }
    if (flags.userSettings !== undefined && typeof flags.userSettings !== "boolean") {
      throw new ClaudeConfigError("Field userSettings harus berupa boolean.");
    }
    if (flags.hooksEnabled !== undefined && typeof flags.hooksEnabled !== "boolean") {
      throw new ClaudeConfigError("Field hooksEnabled harus berupa boolean.");
    }
    this.load();
    const next = copyConfig(this.config ?? this.defaults);
    if (flags.userSettings !== undefined) next.userSettings = flags.userSettings;
    if (flags.hooksEnabled !== undefined) next.hooksEnabled = flags.hooksEnabled;
    this.config = next;
    this.persist();
    return copyConfig(next);
  }

  setSkillEnabled(
    scope: "user" | "project",
    projectRoot: string | undefined,
    name: string,
    enabled: boolean,
  ): ClaudeConfig {
    if (scope !== "user" && scope !== "project") {
      throw new ClaudeConfigError("Cakupan skill hanya user atau project.");
    }
    const skill = validateName(name);
    if (typeof enabled !== "boolean") {
      throw new ClaudeConfigError("Field enabled harus berupa boolean.");
    }
    this.load();
    const next = copyConfig(this.config ?? this.defaults);

    if (scope === "user") {
      next.disabledSkills.user = setMembership(
        next.disabledSkills.user,
        skill,
        !enabled,
      );
    } else {
      if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
        throw new ClaudeConfigError("Akar proyek wajib untuk cakupan proyek.");
      }
      const root = normalizeRoot(projectRoot);
      const existing = next.disabledSkills.projects[root];
      if (existing === undefined) {
        if (enabled) {
          // Sudah aktif secara bawaan; tidak perlu membuat entri baru.
          return copyConfig(next);
        }
        if (Object.keys(next.disabledSkills.projects).length >= MAX_PROJECTS) {
          throw new ClaudeConfigError(`Batas ${MAX_PROJECTS} proyek skill terlampaui.`);
        }
        next.disabledSkills.projects[root] = [skill];
      } else {
        const updated = setMembership(existing, skill, !enabled);
        if (updated.length === 0) {
          delete next.disabledSkills.projects[root];
        } else {
          next.disabledSkills.projects[root] = updated;
        }
      }
    }

    this.config = next;
    this.persist();
    return copyConfig(next);
  }

  /** Nyalakan atau matikan satu plugin (bentuk "nama@marketplace"). */
  setPluginEnabled(id: string, enabled: boolean): ClaudeConfig {
    const plugin = validatePluginId(id);
    if (typeof enabled !== "boolean") {
      throw new ClaudeConfigError("Field enabled harus berupa boolean.");
    }
    this.load();
    const next = copyConfig(this.config ?? this.defaults);
    if (enabled) {
      if (!next.enabledPlugins.includes(plugin)) {
        if (next.enabledPlugins.length >= MAX_ENABLED_PLUGINS) {
          throw new ClaudeConfigError(
            `Batas ${MAX_ENABLED_PLUGINS} plugin aktif terlampaui.`,
          );
        }
        next.enabledPlugins = [...next.enabledPlugins, plugin].sort();
      }
    } else {
      next.enabledPlugins = next.enabledPlugins.filter((item) => item !== plugin);
    }
    this.config = next;
    this.persist();
    return copyConfig(next);
  }

  disabledFor(projectRoot: string): string[] {
    this.load();
    const config = this.config ?? this.defaults;
    const names = new Set<string>(config.disabledSkills.user);
    const project = config.disabledSkills.projects[normalizeRoot(projectRoot)];
    if (project !== undefined) {
      for (const name of project) names.add(name);
    }
    return Array.from(names).sort();
  }
}

/** Tambah/lepas `name`; daftar terurut dan tidak melebihi batas. */
function setMembership(list: string[], name: string, present: boolean): string[] {
  if (!present) return list.filter((item) => item !== name).sort();
  if (list.includes(name)) return [...list].sort();
  if (list.length >= MAX_SKILLS_PER_LIST) {
    throw new ClaudeConfigError(`Batas ${MAX_SKILLS_PER_LIST} skill nonaktif terlampaui.`);
  }
  return [...list, name].sort();
}

/** Dipakai tes/diagnostik: apakah berkas konfigurasi ada. */
export function claudeConfigFileExists(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return existsSync(claudeConfigPath(env));
}
