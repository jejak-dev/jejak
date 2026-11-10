import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { jejakHome } from "../provider-store";

export type GitProviderKind = "gitlab" | "local";

export interface GitProviderProfile {
  id: string;
  name: string;
  kind: GitProviderKind;
  /** GitLab: alamat dasar (https). */
  baseUrl?: string;
  /** Lokal: folder berisi repo git (satu tingkat). */
  root?: string;
  /** Token baca; tidak pernah dikirim ke klien/log/model. */
  token?: string;
}

/** Bentuk aman untuk klien: tanpa token, hanya penanda `hasToken`. */
export interface GitProviderView {
  id: string;
  name: string;
  kind: GitProviderKind;
  baseUrl?: string;
  root?: string;
  hasToken: boolean;
}

export type GitProviderErrorCode = "tidak-valid" | "tidak-ditemukan";

export class GitProviderError extends Error {
  constructor(
    message: string,
    public readonly code: GitProviderErrorCode,
  ) {
    super(message);
    this.name = "GitProviderError";
  }
}

export const MAX_GIT_PROVIDERS = 20;
export const GIT_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION = 1;

function invalid(message: string): GitProviderError {
  return new GitProviderError(message, "tidak-valid");
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Alamat dasar: https, atau http hanya untuk loopback (uji lokal); tanpa kredensial. */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid("Alamat dasar wajib diisi.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid("Alamat dasar tidak valid.");
  }
  const httpsOk = url.protocol === "https:";
  const httpOk = url.protocol === "http:" && isLoopback(url.hostname);
  if (!httpsOk && !httpOk) throw invalid("Alamat dasar harus https (http hanya untuk localhost).");
  if (url.username !== "" || url.password !== "") throw invalid("Alamat dasar tidak boleh memuat kredensial.");
  if (url.search !== "" || url.hash !== "") throw invalid("Alamat dasar tidak boleh memuat query atau fragmen.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw invalid("Folder lokal harus berupa path absolut.");
  let isDirectory = false;
  try {
    isDirectory = statSync(value).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw invalid("Folder lokal tidak ditemukan atau bukan direktori.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function viewOf(profile: GitProviderProfile): GitProviderView {
  const view: GitProviderView = {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    hasToken: profile.token !== undefined && profile.token !== "",
  };
  if (profile.baseUrl !== undefined) view.baseUrl = profile.baseUrl;
  if (profile.root !== undefined) view.root = profile.root;
  return view;
}

export interface GitProviderInput {
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  root?: unknown;
  /** String isi = ganti token; "" = hapus; undefined = pertahankan. */
  token?: unknown;
}

export interface GitProviderStore {
  list(): GitProviderProfile[];
  get(id: string): GitProviderProfile | undefined;
  put(id: unknown, input: GitProviderInput): GitProviderProfile;
  delete(id: string): boolean;
}

export function gitProvidersPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "git-providers.json");
}

export function defaultGitProviderStore(
  env: Record<string, string | undefined> = process.env,
): GitProviderStore | undefined {
  if (env.JEJAK_INDEXER?.trim() === "0") return undefined;
  if (env.JEJAK_PERSIST?.trim() === "0") return new FileGitProviderStore(":memory:");
  return new FileGitProviderStore(gitProvidersPath(env));
}

export class FileGitProviderStore implements GitProviderStore {
  private items: GitProviderProfile[] | undefined;
  private readonly inMemory: boolean;

  constructor(private readonly path: string) {
    this.inMemory = path === ":memory:" || path === "";
  }

  private load(): GitProviderProfile[] {
    if (this.items !== undefined) return this.items;
    this.items = [];
    if (this.inMemory) return this.items;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (isRecord(parsed) && parsed.version === VERSION && Array.isArray(parsed.providers)) {
        for (const raw of parsed.providers) {
          if (!isRecord(raw)) continue;
          const { id, name, kind } = raw;
          if (typeof id !== "string" || !GIT_PROVIDER_ID.test(id)) continue;
          if (typeof name !== "string" || (kind !== "gitlab" && kind !== "local")) continue;
          const profile: GitProviderProfile = { id, name, kind };
          if (typeof raw.baseUrl === "string") profile.baseUrl = raw.baseUrl;
          if (typeof raw.root === "string") profile.root = raw.root;
          if (typeof raw.token === "string" && raw.token !== "") profile.token = raw.token;
          this.items.push(profile);
        }
      }
    } catch {
      // Berkas tak ada atau rusak: kosong; tidak ditimpa sampai ada tulis.
    }
    return this.items;
  }

  list(): GitProviderProfile[] {
    return this.load().map((item) => ({ ...item }));
  }

  get(id: string): GitProviderProfile | undefined {
    const found = this.load().find((item) => item.id === id);
    return found === undefined ? undefined : { ...found };
  }

  put(idInput: unknown, input: GitProviderInput): GitProviderProfile {
    if (typeof idInput !== "string" || !GIT_PROVIDER_ID.test(idInput)) {
      throw invalid("Id penyedia harus huruf kecil, angka, atau tanda hubung (maks 32).");
    }
    const items = this.load();
    const previous = items.find((item) => item.id === idInput);
    const kind = input.kind ?? previous?.kind;
    if (kind !== "gitlab" && kind !== "local") throw invalid("Jenis penyedia harus gitlab atau local.");
    const name = typeof input.name === "string" ? input.name.trim() : (previous?.name ?? "");
    if (name === "" || name.length > 80) throw invalid("Nama penyedia 1-80 karakter.");

    const profile: GitProviderProfile = { id: idInput, name, kind };
    if (kind === "gitlab") {
      profile.baseUrl = normalizeBaseUrl(input.baseUrl ?? previous?.baseUrl);
    } else {
      profile.root = normalizeRoot(input.root ?? previous?.root);
    }
    if (input.token === undefined) {
      if (previous?.token !== undefined && previous.kind === kind) profile.token = previous.token;
    } else if (typeof input.token !== "string") {
      throw invalid("Token harus berupa teks.");
    } else if (input.token !== "") {
      if (kind === "local") throw invalid("Penyedia lokal tidak memakai token.");
      if (input.token.length > 512 || /\s/.test(input.token)) throw invalid("Token tidak valid.");
      profile.token = input.token;
    }

    if (previous === undefined && items.length >= MAX_GIT_PROVIDERS) {
      throw invalid(`Batas ${MAX_GIT_PROVIDERS} penyedia terlampaui.`);
    }
    const next = items.filter((item) => item.id !== idInput);
    next.push(profile);
    next.sort((a, b) => a.id.localeCompare(b.id));
    this.persist(next);
    this.items = next;
    return { ...profile };
  }

  delete(id: string): boolean {
    const items = this.load();
    if (!items.some((item) => item.id === id)) return false;
    const next = items.filter((item) => item.id !== id);
    this.persist(next);
    this.items = next;
    return true;
  }

  private persist(items: GitProviderProfile[]): void {
    if (this.inMemory) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: VERSION, providers: items }, null, 2)}\n`;
    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, body, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Berkas sementara mungkin sudah hilang.
      }
      throw error;
    }
  }
}
