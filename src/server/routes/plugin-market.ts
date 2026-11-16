import { Elysia } from "elysia";
import type { AuditMeta, AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { ClaudeConfigStore } from "../claude-config/config-store";
import {
  MARKETPLACE_NAME_PATTERN,
  findMarketplacePlugin,
  listMarketplaces,
  searchMarketplacePlugins,
} from "../claude-config/marketplace";
import type { PluginInstaller } from "../claude-config/plugin-installer";
import { PLUGIN_ID_PATTERN, listInstalledPlugins } from "../claude-config/plugins";

export interface PluginMarketRoutesOptions {
  /** Tanpa store semua rute pemasangan menjawab 503. */
  store?: ClaudeConfigStore;
  /** Direktori home pengguna untuk `~/.claude`; default `os.homedir()`. */
  home?: string;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
  /** Pemasang plugin; tanpa ini rute pemasangan menjawab 503. */
  installer?: PluginInstaller;
}

const DISABLED = "Pengaturan Claude dimatikan.";
const NO_INSTALLER = "Pemasangan plugin tidak tersedia.";
const MAX_QUERY_LENGTH = 100;

const ID_BODY_KEYS = ["id"] as const;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(message: string): Response {
  return jsonResponse(503, { error: message });
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

/** Teks query opsional dengan batas panjang. */
function queryText(query: unknown, key: string): string | undefined {
  const value = queryRecord(query)[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new RequestError(`Parameter ${key} tidak valid.`);
  if (value.length > MAX_QUERY_LENGTH) {
    throw new RequestError(`Parameter ${key} terlalu panjang.`);
  }
  return value;
}

/** Bilangan bulat non-negatif dari query. */
function queryNumber(query: unknown, key: string): number | undefined {
  const value = queryRecord(query)[key];
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RequestError(`Parameter ${key} tidak valid.`);
  }
  return parsed;
}

/** Id plugin dari body; divalidasi dengan pola plugin. */
function parsePluginId(body: unknown): string {
  const record = parseObjectBody(body, ID_BODY_KEYS);
  const value = record.id;
  if (typeof value !== "string" || !PLUGIN_ID_PATTERN.test(value)) {
    throw new RequestError("Id plugin tidak valid.");
  }
  return value;
}

function audit(store: AuditStore | undefined, summary: string, meta: AuditMeta): void {
  recordAudit(store, { kind: "pengaturan", summary, meta });
}

/**
 * Rute katalog marketplace dan pemasangan plugin.
 *
 * Pemasangan berarti mengunduh kode pihak ketiga, jadi hanya bisa berjalan
 * atas permintaan eksplisit, selalu dicatat di audit, dan satu per satu.
 */
export function pluginMarketRoutes(options: PluginMarketRoutesOptions = {}): Elysia {
  const store = options.store;
  const home = options.home;
  const auditStore = options.audit;
  const installer = options.installer;

  return new Elysia({ name: "jejak-plugin-market-routes" })
    .get("/api/claude/marketplaces", () => {
      try {
        return { marketplaces: listMarketplaces(home) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/claude/marketplace/plugins", ({ query }) => {
      try {
        const marketplace = queryText(query, "marketplace");
        if (marketplace !== undefined && !MARKETPLACE_NAME_PATTERN.test(marketplace)) {
          throw new RequestError("Parameter marketplace tidak valid.");
        }
        return searchMarketplacePlugins(home, {
          ...(queryText(query, "query") === undefined ? {} : { query: queryText(query, "query") }),
          ...(marketplace === undefined ? {} : { marketplace }),
          ...(queryText(query, "category") === undefined
            ? {}
            : { category: queryText(query, "category") }),
          ...(queryNumber(query, "limit") === undefined
            ? {}
            : { limit: queryNumber(query, "limit") }),
          ...(queryNumber(query, "offset") === undefined
            ? {}
            : { offset: queryNumber(query, "offset") }),
        });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/claude/plugins/install",
      async ({ body }) => {
        if (store === undefined) return disabledResponse(DISABLED);
        if (installer === undefined) return disabledResponse(NO_INSTALLER);
        try {
          const id = parsePluginId(body);
          if (findMarketplacePlugin(home, id) === undefined) {
            throw new RequestError(`Plugin "${id}" tidak ada di katalog marketplace.`, 404);
          }
          const hasil = await installer.install(id);
          if (!hasil.ok) {
            audit(auditStore, "Pemasangan plugin gagal", {
              aksi: "gagal-pasang-plugin",
              plugin: id,
            });
            return { ok: false, message: hasil.message };
          }
          const terpasang = listInstalledPlugins(home).find((item) => item.id === id);
          if (terpasang === undefined) {
            audit(auditStore, "Pemasangan plugin gagal", {
              aksi: "gagal-pasang-plugin",
              plugin: id,
            });
            return {
              ok: false,
              message: "CLI selesai tetapi plugin belum terdaftar di Claude Code.",
            };
          }
          audit(auditStore, "Plugin dipasang", { aksi: "pasang-plugin", plugin: id });
          return { ok: true, message: hasil.message, plugin: terpasang };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/claude/plugins/uninstall",
      async ({ body }) => {
        if (store === undefined) return disabledResponse(DISABLED);
        if (installer === undefined) return disabledResponse(NO_INSTALLER);
        try {
          const id = parsePluginId(body);
          if (!listInstalledPlugins(home).some((item) => item.id === id)) {
            throw new RequestError(`Plugin "${id}" tidak terpasang.`, 404);
          }
          const hasil = await installer.uninstall(id);
          if (!hasil.ok) {
            audit(auditStore, "Pencabutan plugin gagal", {
              aksi: "gagal-copot-plugin",
              plugin: id,
            });
            return { ok: false, message: hasil.message };
          }
          // Plugin yang dicopot tak boleh tetap aktif di Jejak.
          store.setPluginEnabled(id, false);
          audit(auditStore, "Plugin dicopot", { aksi: "copot-plugin", plugin: id });
          return { ok: true, message: hasil.message };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
