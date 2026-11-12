import {
  type Dirent,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join, sep } from "node:path";
import { runGit } from "../files/changes";
import { createAdapter, type AdapterDeps, type RemoteRepo } from "../gitprovider/adapters";
import type {
  GitProviderKind,
  GitProviderProfile,
  GitProviderStore,
} from "../gitprovider/provider-store";
import { jejakHome } from "../provider-store";
import { ASKPASS, cloneUrlProblem, gitMessage, repoKey } from "../indexer/repo-indexer";
import { isSecretFilePath } from "../security/secret-paths";

export type WikiErrorCode = "tidak-valid" | "tidak-ditemukan" | "belum-sinkron" | "gagal";

export class WikiError extends Error {
  constructor(
    message: string,
    public readonly code: WikiErrorCode,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

export const MAX_WIKIS = 50;
export const MAX_WIKI_PAGES = 500;
export const MAX_WIKI_PAGE_BYTES = 256 * 1024;
export const MAX_WIKI_SIDEBAR_BYTES = 64 * 1024;
export const MAX_WIKI_SLUG = 300;

const KEY_RE = /^[0-9a-f]{16}$/;
const CLONE_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 30_000;

/** Pengaman yang selalu ikut pada setiap perintah git milik layanan ini. */
export const WIKI_SAFETY_ARGS = ["-c", "core.hooksPath=/dev/null"] as const;

/** Ekstensi wiki yang dibaca; di luar daftar ini berkas diabaikan. */
const FORMATS: Record<string, "markdown" | "text"> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".rdoc": "text",
  ".asciidoc": "text",
  ".adoc": "text",
  ".txt": "text",
};

/** Nama berkas khusus GitLab: `_Sidebar` ditampilkan terpisah, `_Footer` diabaikan. */
const SIDEBAR_BASENAME = "_Sidebar";
const FOOTER_BASENAME = "_Footer";

/** Folder cache wiki di bawah JEJAK_HOME. */
export function wikiRoot(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "cache", "wikis");
}

/**
 * Alamat klon wiki GitLab: alamat repo dengan akhiran `.git` diganti `.wiki.git`.
 * Bila alamat repo tidak berakhiran `.git`, `.wiki.git` ditambahkan.
 */
export function wikiCloneUrl(cloneUrl: string): string {
  return cloneUrl.endsWith(".git")
    ? `${cloneUrl.slice(0, -".git".length)}.wiki.git`
    : `${cloneUrl}.wiki.git`;
}

/** Argumen pengaman git: hook dimatikan dan protokol dibatasi. */
export function wikiGitArgs(kind: GitProviderKind): string[] {
  const protocols =
    kind === "local"
      ? ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"]
      : [
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.http.allow=always",
        ];
  return [...WIKI_SAFETY_ARGS, ...protocols];
}

/** Argumen klon dangkal: tanpa submodul, tanpa hook, satu cabang saja. */
export function wikiCloneArgs(kind: GitProviderKind, url: string, target: string): string[] {
  return [
    ...wikiGitArgs(kind),
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--",
    url,
    target,
  ];
}

export interface WikiMeta {
  commit: string;
  fetchedAt: string;
  providerId: string;
  fullPath: string;
}

export interface WikiPageEntry {
  slug: string;
  title: string;
  format: "markdown" | "text";
}

export interface WikiPage extends WikiPageEntry {
  content: string;
  truncated: boolean;
  commit: string;
  fetchedAt: string;
}

export interface WikiListing {
  commit: string;
  fetchedAt: string;
  pages: WikiPageEntry[];
  sidebar?: string;
}

export interface WikiSyncResult {
  commit: string;
  fetchedAt: string;
  pages: WikiPageEntry[];
}

/** Berkas di dalam klon; `path` menyimpan ekstensi untuk dibaca dari disk. */
interface WikiFile {
  slug: string;
  title: string;
  format: "markdown" | "text";
  path: string;
}

interface WikiScan {
  files: WikiFile[];
  pages: WikiPageEntry[];
  sidebar?: string;
}

export interface WikiServiceOptions {
  root: string;
  providers: GitProviderStore;
  /** Mencari repo milik penyedia; disuntik agar tes tidak memanggil jaringan. */
  resolveRepo: (
    providerId: string,
    fullPath: string,
  ) => Promise<{ provider: GitProviderProfile; repo: RemoteRepo }>;
  now?: () => Date;
}

/**
 * Pembaca wiki proyek lewat git: klon dangkal ke cache lokal, lalu membaca
 * berkas markdown dari disk. Hanya baca; tidak pernah menulis ke wiki.
 */
export class WikiService {
  private readonly root: string;
  private readonly providers: GitProviderStore;
  private readonly resolveRepo: WikiServiceOptions["resolveRepo"];
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: WikiServiceOptions) {
    this.root = options.root;
    this.providers = options.providers;
    this.resolveRepo = options.resolveRepo;
    this.now = options.now ?? (() => new Date());
  }

  private dir(key: string): string {
    if (!KEY_RE.test(key)) throw new WikiError("Kunci wiki tidak valid.", "tidak-valid");
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

  /** Jumlah wiki yang sudah tersinkron di cache. */
  private count(): number {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      if (!KEY_RE.test(name)) continue;
      if (existsSync(join(this.root, name, "meta.json"))) total += 1;
    }
    return total;
  }

  private profile(providerId: string): GitProviderProfile {
    const profile = this.providers.get(providerId);
    if (profile === undefined) {
      throw new WikiError(`Penyedia "${providerId}" tidak ditemukan.`, "tidak-ditemukan");
    }
    return profile;
  }

  /**
   * Klon wiki (atau segarkan cache yang ada). Alamat klon selalu dibentuk
   * server dari `cloneUrl` adapter dan diperiksa asal-usulnya.
   */
  async sync(providerId: string, fullPath: string): Promise<WikiSyncResult> {
    const profile = this.profile(providerId);
    const resolved = await this.resolveRepo(providerId, fullPath);
    const repo = resolved.repo;

    let url: string;
    if (profile.kind === "gitlab") {
      const problem = cloneUrlProblem(profile, repo.cloneUrl);
      if (problem !== undefined) throw new WikiError(problem, "tidak-valid");
      url = wikiCloneUrl(repo.cloneUrl);
      const wikiProblem = cloneUrlProblem(profile, url);
      if (wikiProblem !== undefined) throw new WikiError(wikiProblem, "tidak-valid");
    } else if (profile.kind === "local") {
      // Penyedia lokal untuk uji: alamat `file://` dianggap sudah wiki.
      const problem = cloneUrlProblem(profile, repo.cloneUrl);
      if (problem !== undefined) throw new WikiError(problem, "tidak-valid");
      url = repo.cloneUrl;
    } else {
      throw new WikiError("Penyedia ini tidak punya wiki.", "tidak-valid");
    }

    const key = repoKey(providerId, fullPath);
    return this.exclusive(key, async () => {
      const dir = this.dir(key);
      if (!existsSync(dir) && this.count() >= MAX_WIKIS) {
        throw new WikiError(`Batas ${MAX_WIKIS} wiki terlampaui.`, "tidak-valid");
      }
      const askpass = this.ensureAskpass();
      const env: Record<string, string | undefined> = {
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        ...(profile.token === undefined || profile.token === ""
          ? {}
          : { JEJAK_GIT_TOKEN: profile.token }),
      };
      const protocols = wikiGitArgs(profile.kind);
      const repoDir = this.repoDir(key);
      mkdirSync(dir, { recursive: true, mode: 0o700 });

      let refreshed = false;
      if (existsSync(join(repoDir, ".git"))) {
        const fetched = await runGit(
          [...protocols, "fetch", "--depth", "1", "--no-tags", "origin"],
          repoDir,
          { env, timeoutMs: CLONE_TIMEOUT_MS },
          64 * 1024,
        );
        if (fetched.code === 0) {
          const reset = await runGit(
            [...protocols, "reset", "--hard", "-q", "@{upstream}"],
            repoDir,
            { env, timeoutMs: GIT_TIMEOUT_MS },
            64 * 1024,
          );
          refreshed = reset.code === 0;
        }
        if (!refreshed) rmSync(repoDir, { recursive: true, force: true });
      }
      if (!refreshed) {
        const cloned = await runGit(
          wikiCloneArgs(profile.kind, url, repoDir),
          dir,
          { env, timeoutMs: CLONE_TIMEOUT_MS },
          64 * 1024,
        );
        if (cloned.code !== 0) {
          rmSync(repoDir, { recursive: true, force: true });
          throw cloneError(cloned.stderr, profile.token, cloned.timedOut);
        }
      }

      const head = await runGit(["rev-parse", "HEAD"], repoDir, { timeoutMs: GIT_TIMEOUT_MS }, 1024);
      const commit = head.stdout.trim().slice(0, 40);
      const fetchedAt = this.now().toISOString();
      const meta: WikiMeta = { commit, fetchedAt, providerId, fullPath };
      writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      const scan = this.scan(repoDir);
      return { commit, fetchedAt, pages: scan.pages };
    });
  }

  /** Daftar halaman dari cache wiki; galat bila belum pernah disinkronkan. */
  async listPages(providerId: string, fullPath: string): Promise<WikiListing> {
    const meta = this.meta(providerId, fullPath);
    const key = repoKey(providerId, fullPath);
    const scan = this.scan(this.repoDir(key));
    const listing: WikiListing = {
      commit: meta.commit,
      fetchedAt: meta.fetchedAt,
      pages: scan.pages,
    };
    if (scan.sidebar !== undefined) listing.sidebar = scan.sidebar;
    return listing;
  }

  /** Isi satu halaman; slug harus ada di daftar halaman yang dihitung server. */
  async getPage(providerId: string, fullPath: string, slug: unknown): Promise<WikiPage> {
    const safeSlug = validateSlug(slug);
    const meta = this.meta(providerId, fullPath);
    const key = repoKey(providerId, fullPath);
    const repoDir = this.repoDir(key);
    const scan = this.scan(repoDir);
    const found = scan.files.find((file) => file.slug === safeSlug);
    if (found === undefined) {
      throw new WikiError("Halaman wiki tidak ditemukan.", "tidak-ditemukan");
    }

    let root: string;
    let target: string;
    try {
      root = realpathSync(repoDir);
      target = realpathSync(join(root, found.path));
    } catch {
      throw new WikiError("Halaman wiki tidak ditemukan.", "tidak-ditemukan");
    }
    if (target !== root && !target.startsWith(root + sep)) {
      throw new WikiError("Halaman wiki tidak tersedia.", "tidak-valid");
    }
    if (isSecretFilePath(found.path)) {
      throw new WikiError("Halaman wiki tidak tersedia.", "tidak-valid");
    }

    const buffer = readFileSync(target);
    const slice = buffer.subarray(0, MAX_WIKI_PAGE_BYTES);
    return {
      slug: found.slug,
      title: found.title,
      format: found.format,
      content: slice.toString("utf8"),
      truncated: buffer.length > MAX_WIKI_PAGE_BYTES,
      commit: meta.commit,
      fetchedAt: meta.fetchedAt,
    };
  }

  private meta(providerId: string, fullPath: string): WikiMeta {
    const key = repoKey(providerId, fullPath);
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir(key), "meta.json"), "utf8")) as Partial<WikiMeta>;
      if (typeof parsed.commit !== "string" || typeof parsed.fetchedAt !== "string") {
        throw new Error("meta rusak");
      }
      return {
        commit: parsed.commit,
        fetchedAt: parsed.fetchedAt,
        providerId: typeof parsed.providerId === "string" ? parsed.providerId : providerId,
        fullPath: typeof parsed.fullPath === "string" ? parsed.fullPath : fullPath,
      };
    } catch {
      throw new WikiError("Wiki belum disinkronkan. Jalankan sinkronisasi lebih dulu.", "belum-sinkron");
    }
  }

  /**
   * Menelusuri folder klon: `.git` diabaikan, symlink tidak diikuti,
   * berkas rahasia dan ekstensi tak dikenal dilewati.
   */
  private scan(repoDir: string): WikiScan {
    const files: WikiFile[] = [];
    let sidebar: string | undefined;

    const walk = (dir: string, prefix: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        // Symlink tidak pernah diikuti (bisa menunjuk keluar folder klon).
        if (entry.isSymbolicLink()) continue;
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        const format = FORMATS[ext];
        if (format === undefined) continue;
        if (isSecretFilePath(rel)) continue;
        const base = entry.name.slice(0, entry.name.length - ext.length);
        if (base === "") continue;
        const slug = rel.slice(0, rel.length - ext.length);
        if (base === SIDEBAR_BASENAME) {
          if (sidebar === undefined) sidebar = readSidebar(join(dir, entry.name));
          continue;
        }
        if (base === FOOTER_BASENAME) continue;
        files.push({ slug, title: base.replace(/-/g, " "), format, path: rel });
      }
    };
    walk(repoDir, "");

    const sorted = [...files].sort((a, b) => {
      // Halaman utama GitLab (`Home`) selalu di urutan pertama.
      const aHome = a.slug.toLowerCase() === "home" ? 0 : 1;
      const bHome = b.slug.toLowerCase() === "home" ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      return a.slug.localeCompare(b.slug);
    });
    const limited = sorted.slice(0, MAX_WIKI_PAGES);
    const scan: WikiScan = {
      files: limited,
      pages: limited.map((file) => ({ slug: file.slug, title: file.title, format: file.format })),
    };
    if (sidebar !== undefined) scan.sidebar = sidebar;
    return scan;
  }
}

/** Isi `_Sidebar`, dibatasi 64 KB. */
function readSidebar(path: string): string {
  try {
    return readFileSync(path).subarray(0, MAX_WIKI_SIDEBAR_BYTES).toString("utf8");
  } catch {
    return "";
  }
}

/** Slug halaman: teks pendek tanpa karakter kontrol, `..`, atau path absolut. */
function validateSlug(slug: unknown): string {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > MAX_WIKI_SLUG) {
    throw new WikiError("Slug halaman tidak valid.", "tidak-valid");
  }
  for (const char of slug) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new WikiError("Slug halaman tidak valid.", "tidak-valid");
    }
  }
  if (slug.includes("..") || slug.includes("\\") || slug.startsWith("/")) {
    throw new WikiError("Slug halaman tidak valid.", "tidak-valid");
  }
  return slug;
}

/** Galat klon: pesan aman tanpa token, plus petunjuk scope bila ditolak. */
function cloneError(stderr: string, token: string | undefined, timedOut: boolean): WikiError {
  const detail = gitMessage(stderr, token);
  if (timedOut) {
    return new WikiError(
      "Wiki proyek ini belum ada atau tidak dapat diakses. Waktu habis saat mengambil wiki.",
      "gagal",
    );
  }
  if (/\b401\b|\b403\b|authentication|denied/i.test(stderr)) {
    return new WikiError(
      "Wiki proyek ini belum ada atau tidak dapat diakses. Wiki yang ada memerlukan token GitLab dengan scope read_repository.",
      "gagal",
    );
  }
  return new WikiError(
    `Wiki proyek ini belum ada atau tidak dapat diakses. Detail: ${detail}`,
    "gagal",
  );
}

/**
 * Pencarian repo bawaan: memakai adapter penyedia (jaringan) lalu memilih
 * repo dengan `fullPath` yang cocok.
 */
export function defaultResolveRepo(
  providers: GitProviderStore,
  deps: AdapterDeps = {},
): (providerId: string, fullPath: string) => Promise<{ provider: GitProviderProfile; repo: RemoteRepo }> {
  return async (providerId, fullPath) => {
    const profile = providers.get(providerId);
    if (profile === undefined) {
      throw new WikiError(`Penyedia "${providerId}" tidak ditemukan.`, "tidak-ditemukan");
    }
    let repos: RemoteRepo[];
    try {
      repos = await createAdapter(profile, deps).listRepos();
    } catch (error) {
      const message = error instanceof Error ? error.message : "galat";
      throw new WikiError(`Penyedia tidak dapat dihubungi: ${message}`, "gagal");
    }
    const repo = repos.find((candidate) => candidate.fullPath === fullPath);
    if (repo === undefined) {
      throw new WikiError("Repo tidak ditemukan di penyedia.", "tidak-ditemukan");
    }
    return { provider: profile, repo };
  };
}
