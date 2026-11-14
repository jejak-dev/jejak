import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  FEATURE_ENV,
  FEATURE_NAMES,
  resolveFeature,
  type FeatureName,
  type FeatureSettings,
  type FeatureState,
  type FeatureStatus,
  type FeatureStore,
} from "../features/feature-store";

export interface FeaturesRoutesOptions {
  /** Penyimpanan status fitur. */
  store: FeatureStore;
  /** Env yang mengunci fitur (nilainya menang atas berkas). */
  env: Record<string, string | undefined>;
  /**
   * Status efektif tiap fitur (env + berkas + gerbang). Bila kosong, status
   * dihitung dari env dan isi store.
   */
  state?: (name: FeatureName) => FeatureState;
  /** Terapkan status fitur ke gerbang; mematikan menutup sesi berjalan. */
  apply?: (name: FeatureName, enabled: boolean) => void | Promise<void>;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const LABELS: Record<FeatureName, string> = {
  terminal: "Terminal",
  browser: "Browser",
};

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

export function featuresRoutes(options: FeaturesRoutesOptions): Elysia {
  const plugin = new Elysia({ name: "jejak-features-routes" });

  const state = (name: FeatureName): FeatureState => {
    if (options.state !== undefined) return options.state(name);
    return resolveFeature(name, options.env, options.store.get());
  };

  const status = (): FeatureStatus => ({
    terminal: state("terminal"),
    browser: state("browser"),
  });

  return plugin
    .get("/api/features", () => status())
    .put(
      "/api/features",
      async ({ body }) => {
        let record: Record<string, unknown>;
        try {
          record = parseObjectBody(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
          return jsonResponse(400, { error: message });
        }

        // Kunci asing dan nilai bukan boolean ditolak lebih dulu.
        const patch: Partial<FeatureSettings> = {};
        for (const key of Object.keys(record)) {
          if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
            return jsonResponse(400, { error: `Fitur "${key}" tidak dikenal.` });
          }
          const value = record[key];
          if (typeof value !== "boolean") {
            return jsonResponse(400, {
              error: `Nilai fitur "${key}" harus berupa boolean.`,
            });
          }
          patch[key as FeatureName] = value;
        }

        const before = status();
        // Fitur yang dikunci env tak bisa diubah dari Pengaturan.
        for (const name of FEATURE_NAMES) {
          if (patch[name] === undefined) continue;
          if (before[name].locked) {
            return jsonResponse(409, {
              error: `Fitur ${LABELS[name]} dikunci oleh variabel lingkungan ${FEATURE_ENV[name]}.`,
            });
          }
        }

        try {
          options.store.set(patch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
          return jsonResponse(400, { error: message });
        }

        // Terapkan ke gerbang: mematikan menutup sesi atau proses berjalan.
        for (const name of FEATURE_NAMES) {
          const value = patch[name];
          if (value === undefined) continue;
          if (value !== before[name].enabled) {
            recordAudit(options.audit, {
              kind: "pengaturan",
              summary: `Fitur ${LABELS[name].toLowerCase()} ${value ? "dinyalakan" : "dimatikan"}`,
              meta: { aksi: `fitur-${name}`, fitur: name, nilai: value },
            });
          }
          if (options.apply !== undefined) {
            await options.apply(name, value);
          }
        }

        return status();
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
