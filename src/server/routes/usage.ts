import { Elysia } from "elysia";
import type { UsageLedger, UsageSummary } from "../budget/usage-ledger";
import {
  DEFAULT_USAGE_DAYS,
  usageRangeStartIso,
} from "../budget/usage-ledger";

export interface UsageRoutesOptions {
  /** Buku pemakaian; tanpa ledger rute menjawab 503. */
  ledger?: UsageLedger;
  /** Judul sesi untuk id tertentu; tanpa opsi ini judul tidak dikirim. */
  titles?: (ids: string[]) => Record<string, string>;
  /** Lama retensi pemakaian dalam hari (bawaan 90). */
  retentionDays?: number;
}

const DISABLED = "Pencatatan pemakaian dimatikan.";
const ALLOWED_DAYS = new Set([7, 30, 90]);
const DEFAULT_DAYS = 30;
/** Batas offset zona waktu (±14 jam dalam menit). */
const TZ_MIN = -840;
const TZ_MAX = 840;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse(400, { error: message });
}

/** Ringkasan pemakaian; hanya angka dan id sesi, tanpa isi percakapan. */
export function usageRoutes(options: UsageRoutesOptions = {}): Elysia {
  const ledger = options.ledger;
  const titles = options.titles;
  const retentionDays =
    typeof options.retentionDays === "number" && Number.isFinite(options.retentionDays)
      ? Math.floor(options.retentionDays)
      : DEFAULT_USAGE_DAYS;

  const plugin = new Elysia({ name: "jejak-usage-routes" });
  if (ledger === undefined) {
    return plugin.get("/api/usage", () =>
      jsonResponse(503, { error: DISABLED }),
    ) as unknown as Elysia;
  }

  return plugin.get("/api/usage", ({ query }) => {
    const record = query as Record<string, unknown>;

    let days = DEFAULT_DAYS;
    const rawDays = record.days;
    if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
      if (typeof rawDays !== "string" || !/^\d+$/.test(rawDays.trim())) {
        return badRequest("Parameter days tidak valid. Gunakan 7, 30, atau 90.");
      }
      const parsed = Number(rawDays.trim());
      if (!ALLOWED_DAYS.has(parsed)) {
        return badRequest("Parameter days tidak valid. Gunakan 7, 30, atau 90.");
      }
      days = parsed;
    }

    // Offset zona waktu klien dalam menit timur dari UTC; nilai di luar
    // rentang dijepit ke batas terdekat.
    let tz = 0;
    const rawTz = record.tz;
    if (rawTz !== undefined && rawTz !== null && rawTz !== "") {
      if (typeof rawTz !== "string" || !/^-?\d+$/.test(rawTz.trim())) {
        return badRequest("Parameter tz tidak valid. Isi dengan menit offset zona waktu.");
      }
      tz = Math.min(TZ_MAX, Math.max(TZ_MIN, Number(rawTz.trim())));
    }

    try {
      const now = new Date();
      const sinceIso = usageRangeStartIso(now, days, tz);
      const untilIso = now.toISOString();
      const summary: UsageSummary = ledger.summarize({
        sinceIso,
        untilIso,
        tzOffsetMinutes: tz,
      });

      const sessions: Record<string, string> = {};
      if (titles !== undefined) {
        const ids = summary.bySession.map((entry) => entry.sessionId);
        const found = titles(ids);
        for (const id of ids) {
          const title = found[id];
          if (typeof title === "string" && title !== "") sessions[id] = title;
        }
      }

      return { days, summary, retentionDays, sessions };
    } catch {
      return jsonResponse(500, { error: "Gagal membaca ringkasan pemakaian." });
    }
  }) as unknown as Elysia;
}
