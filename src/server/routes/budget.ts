import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  levelFor,
  localDayStartIso,
  parseBudgetConfig,
  type BudgetConfig,
} from "../budget/budget";
import type { BudgetStore } from "../budget/budget-store";
import type { UsageLedger } from "../budget/usage-ledger";

export interface BudgetRoutesOptions {
  /** Tanpa store semua rute menjawab 503. */
  store?: BudgetStore;
  /** Buku pemakaian; tanpa ledger angka harian/sesi dianggap 0. */
  ledger?: UsageLedger;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const DISABLED = "Anggaran dimatikan.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("Body permintaan harus berupa JSON.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Body permintaan harus berupa JSON yang valid.");
  }
}

export function budgetRoutes(options: BudgetRoutesOptions = {}): Elysia {
  const store = options.store;
  const ledger = options.ledger;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-budget-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/budget", () => jsonResponse(503, { error: DISABLED }))
      .put("/api/budget", () => jsonResponse(503, { error: DISABLED }))
      .get("/api/budget/status", () => jsonResponse(503, { error: DISABLED })) as unknown as Elysia;
  }

  return plugin
    .get("/api/budget", () => store.get())
    .put(
      "/api/budget",
      ({ body }) => {
        let parsed: unknown;
        try {
          parsed = parseJsonBody(body);
        } catch (error) {
          return jsonResponse(400, {
            error: error instanceof Error ? error.message : "Permintaan tidak valid.",
          });
        }
        const result = parseBudgetConfig(parsed);
        if (result.config === undefined) {
          return jsonResponse(400, { error: result.error ?? "Pengaturan anggaran tidak valid." });
        }
        try {
          store.set(result.config);
        } catch {
          return jsonResponse(500, { error: "Gagal menyimpan pengaturan anggaran." });
        }
        recordAudit(audit, {
          kind: "pengaturan",
          summary: "Batas anggaran diubah",
          meta: {
            sessionUsd: result.config.sessionUsd ?? null,
            dailyUsd: result.config.dailyUsd ?? null,
            warnAt: result.config.warnAt,
          },
        });
        return result.config;
      },
      { parse: "text" },
    )
    .get("/api/budget/status", ({ query }) => {
      const config: BudgetConfig = store.get();
      const todayUsd = ledger === undefined ? 0 : ledger.sumSince(localDayStartIso(new Date()));
      const dayLevel = levelFor(todayUsd, config.dailyUsd, config.warnAt);

      const record = query as Record<string, unknown>;
      const session = typeof record.session === "string" ? record.session : undefined;
      if (session === undefined) {
        return {
          config,
          todayUsd,
          ...(dayLevel === undefined ? {} : { dayLevel }),
        };
      }

      const sessionUsd = ledger === undefined ? 0 : ledger.sumForSession(session);
      const sessionLevel = levelFor(sessionUsd, config.sessionUsd, config.warnAt);
      return {
        config,
        todayUsd,
        ...(dayLevel === undefined ? {} : { dayLevel }),
        sessionUsd,
        ...(sessionLevel === undefined ? {} : { sessionLevel }),
      };
    }) as unknown as Elysia;
}
