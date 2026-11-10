import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../files/changes";
import { resolveInside, FileError } from "../files/path";
import { isSecretFilePath } from "../security/secret-paths";
import type { RemoteRepo } from "../gitprovider/adapters";
import type { GitProviderProfile } from "../gitprovider/provider-store";
import { jejakHome } from "../provider-store";

export interface IndexedRepo {
  key: string;
  providerId: string;
  name: string;
  fullPath: string;
  commit: string;
  branch: string;
  indexedAt: string;
  files: number;
  /** Selalu "indeks": salinan dangkal yang mungkin tertinggal dari remote. */
  source: "indeks";
}

export type IndexerErrorCode = "tidak-valid" | "tidak-ditemukan" | "gagal";

export class IndexerError extends Error {
  constructor(
    message: string,
    public readonly code: IndexerErrorCode,
  ) {
    super(message);
    this.name = "IndexerError";
  }
}

export const MAX_INDEXED_REPOS = 100;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LIST_FILES = 5000;
export const MAX_SEARCH_RESULTS = 50;
const CLONE_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 30_000;
const KEY_RE = /^[0-9a-f]{16}$/;
const ASKPASS = '#!/bin/sh\ncase "$1" in\n  Username*) echo oauth2 ;;\n  *) echo "$JEJAK_GIT_TOKEN" ;;\nesac\n';

export function indexRoot(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "cache", "repos");
}

export function repoKey(providerId: string, fullPath: string): string {
  return createHash("sha256").update(`${providerId}\0${fullPath}`).digest("hex").slice(0, 16);
}

function fail(message: string, code: IndexerErrorCode = "gagal"): IndexerError {
  return new IndexerError(message, code);
}

/** Pesan galat git tanpa kemungkinan token: hanya baris pertama, dipotong. */
function gitMessage(stderr: string, token: string | undefined): string {
  let text = stderr.split("\n").find((line) => line.trim() !== "") ?? "git gagal";
  if (token !== undefined && token !== "") text = text.split(token).join("***");
  return text.slice(0, 200);
}

export interface RepoIndexerOptions {
  root: string;
  now?: () => Date;
}

export class RepoIndexer {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: RepoIndexerOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
  }

  private dir(key: string): string {
    if (!KEY_RE.test(key)) throw fail("Kunci repo tidak valid.", "tidak-valid");
    return join(this.root, key);
  }

  private repoDir(key: string): string {
    return join(this.dir(key), "repo");
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  private ensureAskpass(): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "askpass.sh");
    if (!existsSync(path) || readFileSync(path, "utf8") !== ASKPASS) {
      writeFileSync(path, ASKPASS, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    return path;
  }

  /** `cloneUrl` harus berasal dari adapter penyedia: asal-usul dicek di sini juga. */
  private assertCloneUrl(provider: GitProviderProfile, repo: RemoteRepo): void {
    let url: URL;
    try {
      url = new URL(repo.cloneUrl);
    } catch {
      throw fail("Alamat clone tidak valid.", "tidak-valid");
    }
    if (url.username !== "" || url.password !== "") throw fail("Alamat clone tidak boleh memuat kredensial.", "tidak-valid");
    if (provider.kind === "local") {
      if (url.protocol !== "file:") throw fail("Alamat clone lokal harus file://.", "tidak-valid");
      return;
    }
    const base = new URL(provider.baseUrl ?? "");
    if (url.origin !== base.origin) throw fail("Alamat clone tidak berasal dari penyedia ini.", "tidak-valid");
  }

  async index(provider: GitProviderProfile, repo: RemoteRepo): Promise<IndexedRepo> {
    this.assertCloneUrl(provider, repo);
    const key = repoKey(provider.id, repo.fullPath);
    return this.exclusive(key, async () => {
      if (!existsSync(this.dir(key)) && this.list().length >= MAX_INDEXED_REPOS) {
        throw fail(`Batas ${MAX_INDEXED_REPOS} repo terindeks terlampaui.`, "tidak-valid");
      }
      const askpass = this.ensureAskpass();
      const env: Record<string, string | undefined> = {
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        ...(provider.token === undefined ? {} : { JEJAK_GIT_TOKEN: provider.token }),
      };
      const protocols = provider.kind === "local"
        ? ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"]
        : ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.http.allow=always"];
      const repoDir = this.repoDir(key);
      mkdirSync(this.dir(key), { recursive: true, mode: 0o700 });

      let refreshed = false;
      if (existsSync(join(repoDir, ".git"))) {
        const fetched = await runGit(
          [...protocols, "fetch", "--depth", "1", "--no-tags", "origin"],
          repoDir,
          { env, timeoutMs: CLONE_TIMEOUT_MS },
          64 * 1024,
        );
        if (fetched.code === 0) {
          const reset = await runGit(["reset", "--hard", "-q", "@{upstream}"], repoDir, { env, timeoutMs: GIT_TIMEOUT_MS }, 64 * 1024);
          refreshed = reset.code === 0;
        }
        if (!refreshed) rmSync(repoDir, { recursive: true, force: true });
      }
      if (!refreshed) {
        const cloned = await runGit(
          [...protocols, "clone", "--depth", "1", "--single-branch", "--no-tags", "--", repo.cloneUrl, repoDir],
          this.dir(key),
          { env, timeoutMs: CLONE_TIMEOUT_MS },
          64 * 1024,
        );
        if (cloned.code !== 0) {
          rmSync(repoDir, { recursive: true, force: true });
          if (cloned.timedOut) throw fail("Clone melewati batas waktu.");
          throw fail(`Clone gagal: ${gitMessage(cloned.stderr, provider.token)}`);
        }
      }

      const head = await runGit(["rev-parse", "HEAD"], repoDir, { timeoutMs: GIT_TIMEOUT_MS }, 1024);
      const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, { timeoutMs: GIT_TIMEOUT_MS }, 1024);
      const files = await this.trackedFiles(repoDir);
      const meta: IndexedRepo = {
        key,
        providerId: provider.id,
        name: repo.name,
        fullPath: repo.fullPath,
        commit: head.stdout.trim().slice(0, 40),
        branch: branch.stdout.trim(),
        indexedAt: this.now().toISOString(),
        files: files.length,
        source: "indeks",
      };
      writeFileSync(join(this.dir(key), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      return meta;
    });
  }

  private async trackedFiles(repoDir: string): Promise<string[]> {
    const result = await runGit(["ls-files", "-z"], repoDir, { timeoutMs: GIT_TIMEOUT_MS }, 4 * 1024 * 1024);
    return result.stdout
      .split("\0")
      .filter((path) => path !== "" && !isSecretFilePath(path));
  }

  list(): IndexedRepo[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const repos: IndexedRepo[] = [];
    for (const key of names) {
      if (!KEY_RE.test(key)) continue;
      const meta = this.readMeta(key);
      if (meta !== undefined) repos.push(meta);
    }
    return repos.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  }

  get(key: string): IndexedRepo {
    this.dir(key);
    const meta = this.readMeta(key);
    if (meta === undefined) throw fail("Repo terindeks tidak ditemukan.", "tidak-ditemukan");
    return meta;
  }

  private readMeta(key: string): IndexedRepo | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir(key), "meta.json"), "utf8")) as Partial<IndexedRepo>;
      if (typeof parsed.key !== "string" || parsed.key !== key) return undefined;
      return { ...(parsed as IndexedRepo), source: "indeks" };
    } catch {
      return undefined;
    }
  }

  async remove(key: string): Promise<void> {
    this.get(key);
    await this.exclusive(key, async () => {
      rmSync(this.dir(key), { recursive: true, force: true });
    });
  }

  async files(key: string, limit = MAX_LIST_FILES): Promise<{ files: string[]; truncated: boolean }> {
    this.get(key);
    const all = await this.trackedFiles(this.repoDir(key));
    const cap = Math.max(1, Math.min(limit, MAX_LIST_FILES));
    return { files: all.slice(0, cap), truncated: all.length > cap };
  }

  async read(key: string, path: unknown): Promise<{ path: string; content: string; truncated: boolean }> {
    this.get(key);
    let resolved;
    try {
      resolved = await resolveInside(this.repoDir(key), path);
    } catch (error) {
      if (error instanceof FileError) throw fail(error.message, "tidak-valid");
      throw error;
    }
    if (resolved.path === "" || isSecretFilePath(resolved.path)) {
      throw fail("Berkas ini tidak tersedia dari indeks.", "tidak-valid");
    }
    if (resolved.path.split("/").includes(".git")) throw fail("Berkas ini tidak tersedia dari indeks.", "tidak-valid");
    let size: number;
    try {
      const info = statSync(resolved.target);
      if (!info.isFile()) throw fail("Bukan berkas.", "tidak-valid");
      size = info.size;
    } catch (error) {
      if (error instanceof IndexerError) throw error;
      throw fail("Berkas tidak ditemukan.", "tidak-ditemukan");
    }
    const buffer = readFileSync(resolved.target);
    const slice = buffer.subarray(0, MAX_FILE_BYTES);
    if (slice.includes(0)) throw fail("Berkas biner tidak ditampilkan.", "tidak-valid");
    return { path: resolved.path, content: slice.toString("utf8"), truncated: size > MAX_FILE_BYTES };
  }

  /** Pencarian teks tetap (git grep -F) pada satu repo atau semua; keluaran dipotong. */
  async search(query: string, key?: string): Promise<string[]> {
    const text = query.trim();
    if (text === "" || text.length > 200) throw fail("Kueri harus 1-200 karakter.", "tidak-valid");
    const keys = key === undefined ? this.list().map((repo) => repo.key) : [this.get(key).key];
    const lines: string[] = [];
    for (const repoKey of keys) {
      if (lines.length >= MAX_SEARCH_RESULTS) break;
      const result = await runGit(
        ["grep", "-n", "-I", "-F", "--no-color", "-e", text, "--"],
        this.repoDir(repoKey),
        { timeoutMs: GIT_TIMEOUT_MS },
        256 * 1024,
      );
      if (result.code !== 0) continue;
      const name = this.get(repoKey).fullPath;
      for (const line of result.stdout.split("\n")) {
        if (line === "") continue;
        const path = line.split(":", 1)[0] ?? "";
        if (isSecretFilePath(path)) continue;
        lines.push(`${name}:${line.slice(0, 240)}`);
        if (lines.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    return lines;
  }
}
