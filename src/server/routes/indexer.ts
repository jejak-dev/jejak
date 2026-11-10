import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { AdapterError, createAdapter, type AdapterDeps } from "../gitprovider/adapters";
import {
  GitProviderError,
  viewOf,
  type GitProviderStore,
} from "../gitprovider/provider-store";
import { IndexerError, type RepoIndexer } from "../indexer/repo-indexer";

export interface IndexerRoutesOptions {
  /** Tanpa penyimpanan atau indexer semua rute menjawab 503. */
  providers?: GitProviderStore;
  indexer?: RepoIndexer;
  audit?: AuditStore;
  /** Dependensi adapter (mis. `fetch` palsu untuk tes). */
  adapterDeps?: AdapterDeps;
}

const DISABLED = "Indexer dimatikan.";
const PROVIDER_KEYS = ["name", "kind", "baseUrl", "root", "token"] as const;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new GitProviderError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GitProviderError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GitProviderError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new GitProviderError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function errorResponse(error: unknown): Response {
  if (error instanceof GitProviderError || error instanceof IndexerError) {
    const status = error.code === "tidak-ditemukan" ? 404 : error.code === "gagal" ? 502 : 400;
    return json(status, { error: error.message });
  }
  if (error instanceof AdapterError) return json(502, { error: error.message });
  return json(400, { error: "Permintaan tidak valid." });
}

export function indexerRoutes(options: IndexerRoutesOptions = {}): Elysia {
  const { providers, indexer } = options;
  const plugin = new Elysia({ name: "jejak-indexer-routes" });
  if (providers === undefined || indexer === undefined) {
    const off = () => json(503, { error: DISABLED });
    return plugin
      .get("/api/git-providers", off)
      .put("/api/git-providers/:id", off)
      .delete("/api/git-providers/:id", off)
      .get("/api/git-providers/:id/repos", off)
      .get("/api/index/repos", off)
      .post("/api/index/repos", off)
      .delete("/api/index/repos/:key", off)
      .get("/api/index/repos/:key/files", off)
      .get("/api/index/repos/:key/file", off) as unknown as Elysia;
  }
  const note = (aksi: string, meta: Record<string, string | number | boolean | null>): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Indexer: ${aksi}`,
      meta: { aksi: `indexer-${aksi}`, ...meta },
    });
  const profileOrThrow = (id: string) => {
    const profile = providers.get(id);
    if (profile === undefined) throw new GitProviderError(`Penyedia "${id}" tidak ditemukan.`, "tidak-ditemukan");
    return profile;
  };

  return (plugin
    .get("/api/git-providers", () => ({ providers: providers.list().map(viewOf) }))
    .put(
      "/api/git-providers/:id",
      ({ params, body }) => {
        try {
          const saved = providers.put(params.id, parseBody(body, PROVIDER_KEYS));
          note("penyedia-disimpan", { id: saved.id, jenis: saved.kind, token: saved.token !== undefined });
          return viewOf(saved);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/git-providers/:id", ({ params }) => {
      if (!providers.delete(params.id)) {
        return json(404, { error: `Penyedia "${params.id}" tidak ditemukan.` });
      }
      note("penyedia-dihapus", { id: params.id });
      return { ok: true };
    })
    .get("/api/git-providers/:id/repos", async ({ params }) => {
      try {
        const profile = profileOrThrow(params.id);
        const repos = await createAdapter(profile, options.adapterDeps).listRepos();
        const indexed = new Set(indexer.list().filter((r) => r.providerId === profile.id).map((r) => r.fullPath));
        return { repos: repos.map((repo) => ({ ...repo, indexed: indexed.has(repo.fullPath) })) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/index/repos", () => ({ repos: indexer.list() }))
    .post(
      "/api/index/repos",
      async ({ body }) => {
        try {
          const input = parseBody(body, ["providerId", "fullPath"]);
          if (typeof input.providerId !== "string" || typeof input.fullPath !== "string") {
            throw new GitProviderError("providerId dan fullPath wajib berupa teks.", "tidak-valid");
          }
          const profile = profileOrThrow(input.providerId);
          // Alamat clone selalu berasal dari adapter penyedia, bukan dari klien.
          const repos = await createAdapter(profile, options.adapterDeps).listRepos();
          const repo = repos.find((candidate) => candidate.fullPath === input.fullPath);
          if (repo === undefined) {
            throw new IndexerError("Repo tidak ditemukan di penyedia.", "tidak-ditemukan");
          }
          const meta = await indexer.index(profile, repo);
          note("repo-diindeks", { provider: profile.id, repo: repo.fullPath, berkas: meta.files });
          return meta;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/index/repos/:key", async ({ params }) => {
      try {
        await indexer.remove(params.key);
        note("repo-dihapus", { key: params.key });
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/index/repos/:key/files", async ({ params, query }) => {
      try {
        const raw = (query as Record<string, unknown>).limit;
        const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
        return { repo: indexer.get(params.key), ...(await indexer.files(params.key, limit)) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/index/repos/:key/file", async ({ params, query }) => {
      try {
        const file = await indexer.read(params.key, (query as Record<string, unknown>).path);
        return { repo: indexer.get(params.key), ...file };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
