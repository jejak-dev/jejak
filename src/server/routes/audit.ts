import { Elysia } from "elysia";
import {
  AUDIT_KINDS,
  type AuditEntry,
  type AuditKind,
  type AuditStore,
} from "../audit/audit-store";

export interface AuditRoutesOptions {
  /** Tanpa layanan ini semua rute menjawab 503. */
  store?: AuditStore;
}

const DISABLED = "Log audit dimatikan.";
const QUERY_KEYS = new Set(["session", "kind", "before", "limit"]);

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, { error: DISABLED });
}

function badRequest(message: string): Response {
  return jsonResponse(400, { error: message });
}

function isAuditKind(value: string): value is AuditKind {
  return (AUDIT_KINDS as readonly string[]).includes(value);
}

/** Angka bulat positif; `undefined` bila tidak diisi. */
function parsePositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function auditRoutes(options: AuditRoutesOptions = {}): Elysia {
  const store = options.store;

  const plugin = new Elysia({ name: "jejak-audit-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/audit", () => disabledResponse())
      .get("/api/audit/summary", () => disabledResponse()) as unknown as Elysia;
  }

  return plugin
    .get("/api/audit", ({ query }) => {
      const record = query as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!QUERY_KEYS.has(key)) {
          return badRequest(`Parameter "${key}" tidak dikenal.`);
        }
      }

      let kind: AuditKind | undefined;
      if (record.kind !== undefined) {
        if (typeof record.kind !== "string" || !isAuditKind(record.kind)) {
          return badRequest("Jenis audit tidak dikenal.");
        }
        kind = record.kind;
      }

      const before = parsePositiveInteger(record.before);
      if (before === null) {
        return badRequest("Parameter before harus bilangan bulat positif.");
      }
      const limit = parsePositiveInteger(record.limit);
      if (limit === null) {
        return badRequest("Parameter limit harus bilangan bulat positif.");
      }

      const session = typeof record.session === "string" ? record.session : undefined;
      try {
        const entries = store.list({
          ...(session === undefined ? {} : { session }),
          ...(kind === undefined ? {} : { kind }),
          ...(before === undefined ? {} : { before }),
          ...(limit === undefined ? {} : { limit }),
        });
        const effectiveLimit = limit === undefined ? 50 : Math.min(200, Math.max(1, limit));
        const last = entries[entries.length - 1];
        const next =
          entries.length === effectiveLimit && last !== undefined ? last.id : null;
        return { entries: entries satisfies AuditEntry[], next };
      } catch {
        return jsonResponse(500, { error: "Gagal membaca log audit." });
      }
    })
    .get("/api/audit/summary", () => {
      try {
        return store.summary();
      } catch {
        return jsonResponse(500, { error: "Gagal membaca ringkasan audit." });
      }
    }) as unknown as Elysia;
}
