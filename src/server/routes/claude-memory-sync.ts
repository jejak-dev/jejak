import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { ClaudeMemorySync } from "../memory/claude-memory-sync";
import {
  MEMORY_SYNC_ENV,
  resolveMemorySync,
  type MemorySyncSettings,
  type MemorySyncState,
  type MemorySyncStore,
} from "../memory/memory-sync-store";

export interface ClaudeMemorySyncRoutesOptions {
  /** Penyimpanan status sinkron. */
  store: MemorySyncStore;
  /** Env yang mengunci saklar (`JEJAK_CLAUDE_SYNC`). */
  env: Record<string, string | undefined>;
  /** Layanan sinkron ke folder memory Claude Code. */
  sync: ClaudeMemorySync;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("Body permintaan harus berupa JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Body permintaan harus berupa JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Body permintaan harus berupa objek.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Rute saklar sinkron memory ke Claude Code. Semuanya di bawah `/api/` sehingga
 * penjaga Host/Origin dan penjaga autentikasi yang sama dengan rute memory
 * lain berlaku otomatis.
 */
export function claudeMemorySyncRoutes(
  options: ClaudeMemorySyncRoutesOptions,
): Elysia {
  const plugin = new Elysia({ name: "jejak-claude-memory-sync-routes" });

  const state = (): MemorySyncState =>
    resolveMemorySync(options.env, options.store.get());

  return plugin
    .get("/api/memory/claude/sync", () => state())
    .put(
      "/api/memory/claude/sync",
      async ({ body }) => {
        let record: Record<string, unknown>;
        try {
          record = parseObjectBody(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
          return jsonResponse(400, { error: message });
        }

        for (const key of Object.keys(record)) {
          if (key !== "enabled") {
            return jsonResponse(400, { error: `Pengaturan "${key}" tidak dikenal.` });
          }
        }
        const enabled = record.enabled;
        if (typeof enabled !== "boolean") {
          return jsonResponse(400, { error: 'Nilai "enabled" harus berupa boolean.' });
        }

        const before = state();
        if (before.locked) {
          return jsonResponse(409, {
            error: `Sinkron ke Claude Code dikunci oleh variabel lingkungan ${MEMORY_SYNC_ENV}.`,
          });
        }

        try {
          options.store.set({ claude: enabled });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
          return jsonResponse(400, { error: message });
        }

        if (before.enabled !== enabled) {
          recordAudit(options.audit, {
            kind: "pengaturan",
            summary: `Sinkron ke Claude Code ${enabled ? "dinyalakan" : "dimatikan"}`,
            meta: { aksi: "sinkron-claude", nilai: enabled },
          });
        }

        return state();
      },
      { parse: "text" },
    )
    .post(
      "/api/memory/claude/sync/run",
      async () => {
        const current = state();
        if (!current.enabled) {
          return jsonResponse(409, {
            error: "Sinkron ke Claude Code dimatikan; nyalakan saklarnya dulu.",
          });
        }
        const summary = await options.sync.run();
        return summary;
      },
      { parse: "text" },
    ) as unknown as Elysia;
}

/** Bentuk pengaturan yang disimpan; dipakai uji dan audit. */
export type MemorySyncPatch = Partial<MemorySyncSettings>;
