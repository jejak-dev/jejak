import { Elysia } from "elysia";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { GitProviderStore } from "../gitprovider/provider-store";
import { matchRemote, originOf } from "../wiki/remote-match";
import { WikiError, type WikiService } from "../wiki/wiki-service";

export interface WikiRoutesOptions {
  /** Layanan wiki; tanpa opsi ini semua rute menjawab 503. */
  wiki?: WikiService;
  /** Penyedia git; tanpa opsi ini semua rute menjawab 503. */
  providers?: GitProviderStore;
  audit?: AuditStore;
  /** Folder yang boleh ditelusuri (folder sesi aktif). */
  allowedCwds: () => string[];
}

const DISABLED = "Wiki dimatikan.";
const SYNC_KEYS = ["providerId", "fullPath"] as const;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Body JSON dengan daftar field yang boleh (field lain ditolak). */
function parseBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new WikiError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WikiError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WikiError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new WikiError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function queryRecord(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
}

function queryText(query: unknown, key: string): string {
  const value = queryRecord(query)[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new WikiError(`Parameter ${key} wajib diisi.`, "tidak-valid");
  }
  return value;
}

/** Normalisasi folder: realpath bila ada, agar perbandingan stabil. */
function normalizeCwd(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/** Pemetaan galat wiki ke status HTTP. */
function errorResponse(error: unknown): Response {
  if (error instanceof WikiError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "belum-sinkron"
          ? 409
          : error.code === "gagal"
            ? 502
            : 400;
    return json(status, { error: error.message });
  }
  return json(400, { error: "Permintaan tidak valid." });
}

/**
 * Rute wiki proyek. Semuanya di bawah `/api/` sehingga otomatis dilindungi
 * autentikasi.
 */
export function wikiRoutes(options: WikiRoutesOptions): Elysia {
  const { wiki, providers } = options;
  const plugin = new Elysia({ name: "jejak-wiki-routes" });
  if (wiki === undefined || providers === undefined) {
    const off = () => json(503, { error: DISABLED });
    return plugin
      .get("/api/wiki/project", off)
      .post("/api/wiki/sync", off)
      .get("/api/wiki/pages", off)
      .get("/api/wiki/page", off) as unknown as Elysia;
  }

  const note = (
    aksi: string,
    ringkasan: string,
    meta: Record<string, string | number | boolean | null>,
  ): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Wiki: ${ringkasan}`,
      meta: { aksi, ...meta },
    });

  const profileOrThrow = (id: string) => {
    const profile = providers.get(id);
    if (profile === undefined) {
      throw new WikiError(`Penyedia "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    return profile;
  };

  return (plugin
    .get("/api/wiki/project", async ({ query }) => {
      try {
        const cwd = queryText(query, "cwd");
        const allowed = options.allowedCwds().map(normalizeCwd);
        if (!allowed.includes(normalizeCwd(cwd))) {
          throw new WikiError("Folder sesi tidak dikenal.", "tidak-ditemukan");
        }
        const remote = await originOf(cwd);
        const match = remote === undefined ? undefined : matchRemote(remote, providers.list());
        if (match === undefined) {
          throw new WikiError("Proyek GitLab tidak ditemukan dari remote origin.", "tidak-ditemukan");
        }
        return { providerId: match.providerId, fullPath: match.fullPath };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/wiki/sync",
      async ({ body }) => {
        let providerId = "";
        let fullPath = "";
        try {
          const input = parseBody(body, SYNC_KEYS);
          if (typeof input.providerId !== "string" || typeof input.fullPath !== "string") {
            throw new WikiError("providerId dan fullPath wajib berupa teks.", "tidak-valid");
          }
          providerId = input.providerId;
          fullPath = input.fullPath;
          profileOrThrow(providerId);
          const result = await wiki.sync(providerId, fullPath);
          const listing = await wiki.listPages(providerId, fullPath);
          note("wiki-sinkron", "sinkronisasi", {
            providerId,
            fullPath,
            commit: result.commit,
            hasil: "ok",
          });
          return {
            commit: result.commit,
            fetchedAt: result.fetchedAt,
            pages: listing.pages,
            ...(listing.sidebar === undefined ? {} : { sidebar: listing.sidebar }),
          };
        } catch (error) {
          note("wiki-sinkron", "sinkronisasi", { providerId, fullPath, commit: "", hasil: "gagal" });
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/wiki/pages", async ({ query }) => {
      try {
        const providerId = queryText(query, "providerId");
        const fullPath = queryText(query, "fullPath");
        profileOrThrow(providerId);
        const listing = await wiki.listPages(providerId, fullPath);
        return {
          commit: listing.commit,
          fetchedAt: listing.fetchedAt,
          pages: listing.pages,
          ...(listing.sidebar === undefined ? {} : { sidebar: listing.sidebar }),
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/wiki/page", async ({ query }) => {
      try {
        const providerId = queryText(query, "providerId");
        const fullPath = queryText(query, "fullPath");
        const slug = queryRecord(query).slug;
        profileOrThrow(providerId);
        const page = await wiki.getPage(providerId, fullPath, slug);
        note("wiki-baca", "baca halaman", { providerId, fullPath, slug: page.slug });
        return { page };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
