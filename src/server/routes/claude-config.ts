import { Elysia } from "elysia";
import { statSync } from "node:fs";
import type { AuditMeta, AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  ClaudeConfigError,
  type ClaudeConfig,
  type ClaudeConfigStore,
} from "../claude-config/config-store";
import {
  InstructionsError,
  readInstructions,
  writeInstructions,
  type InstructionScope,
} from "../claude-config/instructions";
import { SkillError, listSkills, readSkill, writeSkill, type SkillScope } from "../claude-config/skills";
import { AgentError, listAgents, readAgent, writeAgent } from "../claude-config/agents";
import { listHooks } from "../claude-config/hooks";

export interface ClaudeConfigRoutesOptions {
  /** Tanpa store semua rute menjawab 503. */
  store?: ClaudeConfigStore;
  /** Direktori home pengguna untuk `~/.claude`; default `os.homedir()`. */
  home?: string;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const DISABLED = "Pengaturan Claude dimatikan.";

const CONFIG_KEYS = ["userSettings", "hooksEnabled"] as const;
const INSTRUCTIONS_BODY_KEYS = ["content"] as const;
const SKILL_BODY_KEYS = ["content"] as const;
const ENABLED_BODY_KEYS = ["enabled"] as const;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, { error: DISABLED });
}

class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof SkillError) {
    const status =
      error.code === "tidak-ditemukan" ? 404 : error.code === "terlalu-besar" ? 400 : 400;
    return jsonResponse(status, { error: error.message });
  }
  if (error instanceof AgentError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  if (error instanceof InstructionsError) {
    return jsonResponse(400, { error: error.message });
  }
  if (error instanceof ClaudeConfigError) {
    return jsonResponse(400, { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function parseObjectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new RequestError("Body permintaan harus berupa JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestError("Body permintaan harus berupa JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestError("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RequestError(`Field "${key}" tidak dikenal.`);
    }
  }
  return record;
}

function queryRecord(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

/** `cwd` query: wajib untuk cakupan proyek, harus direktori absolut bila ada. */
function queryCwd(query: unknown, required: boolean): string | undefined {
  const value = queryRecord(query).cwd;
  if (value === undefined || value === "") {
    if (required) {
      throw new RequestError("Parameter cwd wajib diisi.");
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RequestError("Parameter cwd tidak valid.");
  }
  if (!value.startsWith("/")) {
    throw new RequestError("cwd harus berupa path absolut.");
  }
  if (required) {
    let isDirectory = false;
    try {
      isDirectory = statSync(value).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new RequestError("cwd tidak ditemukan atau bukan direktori.");
    }
  }
  return value;
}

function parseScope(value: unknown): SkillScope {
  if (value !== "user" && value !== "project") {
    throw new RequestError("Cakupan harus user atau project.");
  }
  return value;
}

function parseInstructionScope(value: unknown): InstructionScope {
  if (value !== "user" && value !== "project") {
    throw new RequestError("Cakupan harus user atau project.");
  }
  return value;
}

function audit(
  store: AuditStore | undefined,
  summary: string,
  meta: AuditMeta,
): void {
  recordAudit(store, { kind: "pengaturan", summary, meta });
}

function sizeOf(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function parseConfigBody(record: Record<string, unknown>): {
  userSettings?: boolean;
  hooksEnabled?: boolean;
} {
  const result: { userSettings?: boolean; hooksEnabled?: boolean } = {};
  for (const key of CONFIG_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new RequestError(`Field "${key}" harus berupa boolean.`);
    }
    result[key] = value;
  }
  if (result.userSettings === undefined && result.hooksEnabled === undefined) {
    throw new RequestError("Tidak ada pengaturan yang diubah.");
  }
  return result;
}

export function claudeConfigRoutes(options: ClaudeConfigRoutesOptions = {}): Elysia {
  const store = options.store;
  const home = options.home;
  const auditStore = options.audit;

  const plugin = new Elysia({ name: "jejak-claude-config-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/claude/config", () => disabledResponse())
      .put("/api/claude/config", () => disabledResponse())
      .get("/api/claude/instructions", () => disabledResponse())
      .put("/api/claude/instructions", () => disabledResponse())
      .get("/api/claude/skills", () => disabledResponse())
      .get("/api/claude/skills/:scope/:name", () => disabledResponse())
      .put("/api/claude/skills/:scope/:name", () => disabledResponse())
      .put("/api/claude/skills/:scope/:name/enabled", () => disabledResponse())
      .get("/api/claude/agents", () => disabledResponse())
      .get("/api/claude/agents/:scope/:name", () => disabledResponse())
      .put("/api/claude/agents/:scope/:name", () => disabledResponse())
      .get("/api/claude/hooks", () => disabledResponse()) as unknown as Elysia;
  }

  const enabledFlags = (): { userSettings: boolean; hooksEnabled: boolean } => {
    const config: ClaudeConfig = store.get();
    return { userSettings: config.userSettings, hooksEnabled: config.hooksEnabled };
  };

  return plugin
    .get("/api/claude/config", () => enabledFlags())
    .put(
      "/api/claude/config",
      ({ body }) => {
        try {
          const parsed = parseConfigBody(parseObjectBody(body, CONFIG_KEYS));
          const before = store.get();
          const next = store.setFlags(parsed);
          if (parsed.userSettings !== undefined && parsed.userSettings !== before.userSettings) {
            audit(auditStore, "Pengaturan sumber pengguna diubah", {
              aksi: parsed.userSettings ? "mengaktifkan-sumber-pengguna" : "menonaktifkan-sumber-pengguna",
              userSettings: next.userSettings,
            });
          }
          if (parsed.hooksEnabled !== undefined && parsed.hooksEnabled !== before.hooksEnabled) {
            audit(
              auditStore,
              next.hooksEnabled ? "Hooks diaktifkan" : "Hooks dinonaktifkan",
              {
                aksi: next.hooksEnabled ? "mengaktifkan-hooks" : "menonaktifkan-hooks",
                hooksEnabled: next.hooksEnabled,
              },
            );
          }
          return enabledFlags();
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/claude/instructions", ({ query }) => {
      try {
        const scope = parseInstructionScope(queryRecord(query).scope);
        const cwd = queryCwd(query, scope === "project");
        return readInstructions(scope, cwd, home);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/claude/instructions",
      ({ query, body }) => {
        try {
          const scope = parseInstructionScope(queryRecord(query).scope);
          const cwd = queryCwd(query, scope === "project");
          const record = parseObjectBody(body, INSTRUCTIONS_BODY_KEYS);
          if (typeof record.content !== "string") {
            throw new RequestError('Field "content" harus berupa teks.');
          }
          const written = writeInstructions(scope, cwd, record.content, home);
          audit(
            auditStore,
            `CLAUDE.md diubah (${scope === "user" ? "pengguna" : "proyek"})`,
            { aksi: "ubah-claude-md", scope, ukuran: sizeOf(record.content) },
          );
          return written;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/claude/skills", ({ query }) => {
      try {
        const cwd = queryCwd(query, true);
        return {
          skills: listSkills(cwd, home, store.disabledFor(cwd ?? "")),
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/claude/agents", ({ query }) => {
      try {
        return { agents: listAgents(queryCwd(query, true), home) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/claude/agents/:scope/:name", ({ params, query }) => {
      try {
        const scope = parseScope(params.scope);
        return readAgent(scope, params.name, queryCwd(query, scope === "project"), home);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/claude/agents/:scope/:name",
      ({ params, query, body }) => {
        try {
          const scope = parseScope(params.scope);
          const cwd = queryCwd(query, scope === "project");
          const record = parseObjectBody(body, SKILL_BODY_KEYS);
          if (typeof record.content !== "string") {
            throw new RequestError('Field "content" harus berupa teks.');
          }
          const existed = (() => {
            try {
              readAgent(scope, params.name, cwd, home);
              return true;
            } catch (error) {
              if (error instanceof AgentError && error.code === "tidak-ditemukan") return false;
              throw error;
            }
          })();
          const written = writeAgent(scope, params.name, record.content, cwd, home);
          audit(auditStore, existed ? "Subagent diubah" : "Subagent dibuat", {
            aksi: existed ? "ubah-subagent" : "buat-subagent",
            scope,
            nama: written.name,
            ukuran: sizeOf(record.content),
          });
          return written;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/claude/skills/:scope/:name", ({ params, query }) => {
      try {
        const scope = parseScope(params.scope);
        const cwd = queryCwd(query, scope === "project");
        const skill = readSkill(scope, params.name, cwd, home);
        const disabled =
          scope === "user"
            ? store.get().disabledSkills.user
            : store.disabledFor(cwd ?? "");
        return {
          ...skill,
          enabled: !disabled.includes(skill.name),
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/claude/skills/:scope/:name",
      ({ params, query, body }) => {
        try {
          const scope = parseScope(params.scope);
          const cwd = queryCwd(query, scope === "project");
          const record = parseObjectBody(body, SKILL_BODY_KEYS);
          if (typeof record.content !== "string") {
            throw new RequestError('Field "content" harus berupa teks.');
          }
          const existed = (() => {
            try {
              readSkill(scope, params.name, cwd, home);
              return true;
            } catch (error) {
              if (error instanceof SkillError && error.code === "tidak-ditemukan") return false;
              throw error;
            }
          })();
          const written = writeSkill(scope, params.name, record.content, cwd, home);
          audit(auditStore, existed ? "Skill diubah" : "Skill dibuat", {
            aksi: existed ? "ubah-skill" : "buat-skill",
            scope,
            nama: written.name,
            ukuran: sizeOf(record.content),
          });
          return written;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .put(
      "/api/claude/skills/:scope/:name/enabled",
      ({ params, query, body }) => {
        try {
          const scope = parseScope(params.scope);
          const cwd = queryCwd(query, scope === "project");
          const record = parseObjectBody(body, ENABLED_BODY_KEYS);
          if (typeof record.enabled !== "boolean") {
            throw new RequestError('Field "enabled" harus berupa boolean.');
          }
          const config = store.setSkillEnabled(
            scope,
            scope === "project" ? cwd : undefined,
            params.name,
            record.enabled,
          );
          audit(auditStore, record.enabled ? "Skill diaktifkan" : "Skill dinonaktifkan", {
            aksi: record.enabled ? "mengaktifkan-skill" : "menonaktifkan-skill",
            scope,
            nama: params.name,
          });
          return {
            scope,
            name: params.name,
            enabled: record.enabled,
            disabledSkills: config.disabledSkills,
          };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/claude/hooks", ({ query }) => {
      try {
        const cwd = queryCwd(query, true);
        const config = store.get();
        return { hooks: listHooks(cwd, home, config.userSettings) };
      } catch (error) {
        return errorResponse(error);
      }
    }) as unknown as Elysia;
}
