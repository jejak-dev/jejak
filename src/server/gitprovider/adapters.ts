import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GitProviderProfile } from "./provider-store";

export interface RemoteRepo {
  /** Nama pendek (segmen terakhir). */
  name: string;
  /** Jalur lengkap, mis. `grup/sub/proyek`; kunci identitas dalam satu penyedia. */
  fullPath: string;
  cloneUrl: string;
  defaultBranch?: string;
}

export interface GitProviderAdapter {
  listRepos(): Promise<RemoteRepo[]>;
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface AdapterDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Repo GitLab yang bisa diakses token (membership), maks 500, hanya baca. */
export class GitLabAdapter implements GitProviderAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly deps: AdapterDeps = {},
  ) {}

  async listRepos(): Promise<RemoteRepo[]> {
    const doFetch = this.deps.fetch ?? fetch;
    const repos: RemoteRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${this.baseUrl}/api/v4/projects?membership=true&simple=true&order_by=last_activity_at&per_page=${PAGE_SIZE}&page=${page}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.token !== undefined) headers["private-token"] = this.token;
      let response: Response;
      try {
        response = await doFetch(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
        });
      } catch {
        throw new AdapterError("Tidak dapat terhubung ke GitLab (koneksi gagal atau waktu habis).");
      }
      if (response.status === 401 || response.status === 403) {
        throw new AdapterError("GitLab menolak token (periksa token dan izin read_api).");
      }
      if (!response.ok) throw new AdapterError(`GitLab menjawab status ${response.status}.`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AdapterError("Respons GitLab bukan JSON yang valid.");
      }
      if (!Array.isArray(payload)) throw new AdapterError("Respons GitLab tidak sesuai harapan.");
      for (const raw of payload) {
        if (!isRecord(raw)) continue;
        const fullPath = raw.path_with_namespace;
        const name = raw.path;
        const cloneUrl = raw.http_url_to_repo;
        if (typeof fullPath !== "string" || typeof name !== "string" || typeof cloneUrl !== "string") continue;
        const repo: RemoteRepo = { name, fullPath, cloneUrl };
        if (typeof raw.default_branch === "string") repo.defaultBranch = raw.default_branch;
        repos.push(repo);
      }
      if (payload.length < PAGE_SIZE) break;
    }
    return repos;
  }
}

/** Folder berisi repo git (satu tingkat); cocok untuk repo yang sudah ada di mesin. */
export class LocalAdapter implements GitProviderAdapter {
  constructor(private readonly root: string) {}

  async listRepos(): Promise<RemoteRepo[]> {
    let names: string[];
    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      throw new AdapterError("Folder lokal tidak dapat dibaca.");
    }
    const repos: RemoteRepo[] = [];
    for (const name of names) {
      const dir = join(this.root, name);
      try {
        if (!statSync(join(dir, ".git")).isDirectory() && !statSync(join(dir, ".git")).isFile()) continue;
      } catch {
        continue;
      }
      repos.push({ name, fullPath: name, cloneUrl: pathToFileURL(dir).href });
      if (repos.length >= 500) break;
    }
    return repos;
  }
}

export function createAdapter(profile: GitProviderProfile, deps: AdapterDeps = {}): GitProviderAdapter {
  if (profile.kind === "gitlab") {
    if (profile.baseUrl === undefined) throw new AdapterError("Penyedia GitLab tanpa alamat dasar.");
    return new GitLabAdapter(profile.baseUrl, profile.token, deps);
  }
  if (profile.root === undefined) throw new AdapterError("Penyedia lokal tanpa folder.");
  return new LocalAdapter(profile.root);
}
