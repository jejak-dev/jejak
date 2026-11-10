import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_DENY_READ_REL,
  DEFAULT_DENY_WRITE_REL,
  sandboxAvailable,
} from "../sandbox/build-options";
import {
  SandboxConfigError,
  type SandboxConfig,
  type SandboxStore,
} from "../sandbox/sandbox-config";

export interface SandboxRoutesOptions {
  /** Tanpa store semua rute menjawab 503. */
  store?: SandboxStore;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const DISABLED = "Sandbox dimatikan.";

const BODY_KEYS = ["mode", "allowedDomains", "extraDenyRead", "extraDenyWrite"] as const;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, { error: DISABLED });
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new SandboxConfigError("Body permintaan harus berupa JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SandboxConfigError("Body permintaan harus berupa JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxConfigError("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(BODY_KEYS as readonly string[]).includes(key)) {
      throw new SandboxConfigError(`Field "${key}" tidak dikenal.`);
    }
  }
  return record;
}

function parsePatch(record: Record<string, unknown>): Partial<SandboxConfig> {
  const patch: Partial<SandboxConfig> = {};
  if (record.mode !== undefined) {
    if (record.mode !== "standar" && record.mode !== "mati") {
      throw new SandboxConfigError('Mode sandbox hanya "standar" atau "mati".');
    }
    patch.mode = record.mode;
  }
  for (const key of ["allowedDomains", "extraDenyRead", "extraDenyWrite"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new SandboxConfigError(`Field "${key}" harus berupa daftar teks.`);
    }
    patch[key] = value as string[];
  }
  if (Object.keys(patch).length === 0) {
    throw new SandboxConfigError("Tidak ada pengaturan yang diubah.");
  }
  return patch;
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

export function sandboxRoutes(options: SandboxRoutesOptions = {}): Elysia {
  const store = options.store;
  const auditStore = options.audit;

  const plugin = new Elysia({ name: "jejak-sandbox-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/sandbox", () => disabledResponse())
      .put("/api/sandbox", () => disabledResponse()) as unknown as Elysia;
  }

  return plugin
    .get("/api/sandbox", () => ({
      config: store.get(),
      defaults: {
        allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
        denyRead: [...DEFAULT_DENY_READ_REL],
        denyWrite: [...DEFAULT_DENY_WRITE_REL],
      },
      available: sandboxAvailable(),
    }))
    .put(
      "/api/sandbox",
      ({ body }) => {
        try {
          const patch = parsePatch(parseObjectBody(body));
          const before = store.get();
          const config = store.set(patch);
          const meta: Record<string, string | number | boolean | null> = {
            mode: config.mode,
            domain: config.allowedDomains.length,
            denyRead: config.extraDenyRead.length,
            denyWrite: config.extraDenyWrite.length,
          };
          if (patch.mode !== undefined && patch.mode !== before.mode && config.mode === "mati") {
            meta.aksi = "sandbox-mati-global";
          }
          recordAudit(auditStore, {
            kind: "pengaturan",
            summary: "Pengaturan sandbox diubah",
            meta,
          });
          return { config };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
