import { chmod, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGit, type GitOptions } from "../files/changes";
import { withLock } from "./lock";

export type WorktreeErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik" | "gagal";

export class WorktreeError extends Error {
  /** Angka yang dilaporkan saat penolakan `konflik`; dipakai rute. */
  readonly dirtyFiles?: number;
  readonly commitsAhead?: number;

  constructor(
    message: string,
    public readonly code: WorktreeErrorCode,
    numbers: { dirtyFiles?: number; commitsAhead?: number } = {},
  ) {
    super(message);
    this.name = "WorktreeError";
    if (numbers.dirtyFiles !== undefined) this.dirtyFiles = numbers.dirtyFiles;
    if (numbers.commitsAhead !== undefined) this.commitsAhead = numbers.commitsAhead;
  }
}

export interface WorktreeInfo {
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  subdir?: string;
  removed?: boolean;
  missing?: boolean;
}

export interface WorktreeInspect {
  exists: boolean;
  dirtyFiles: number;
  commitsAhead: number;
  branchExists: boolean;
}

export interface WorktreeCreateInput {
  sessionId: string;
  title: string;
  cwd: string;
}

export interface WorktreeCreateResult {
  info: WorktreeInfo;
  dirtyInSource: boolean;
}

export interface WorktreeServiceOptions {
  /** Akar penyimpanan worktree, biasanya `<JEJAK_HOME>/worktrees`. */
  root: string;
  git?: GitOptions;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SLUG = 30;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 60_000;

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Slug aman dari judul: huruf kecil, a-z0-9 dan `-`, maks 30 karakter. */
export function worktreeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return slug === "" ? "sesi" : slug;
}

export class WorktreeService {
  private readonly root: string;
  private readonly git: GitOptions;

  constructor(options: WorktreeServiceOptions) {
    this.root = resolve(options.root);
    this.git = options.git ?? {};
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.root, 0o700);
    } catch {
      // Sebagian sistem berkas tidak mendukung chmod.
    }
  }

  private pathFor(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new WorktreeError("Id sesi tidak valid untuk worktree.", "tidak-valid");
    }
    const path = join(this.root, sessionId);
    if (dirname(path) !== this.root || !insideRoot(this.root, path)) {
      throw new WorktreeError("Path worktree berada di luar akar.", "tidak-valid");
    }
    return path;
  }

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const path = this.pathFor(input.sessionId);

    const top = await runGit(
      ["rev-parse", "--show-toplevel"],
      input.cwd,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    const topLevel = top.stdout.trim();
    if (top.code !== 0 || topLevel === "") {
      throw new WorktreeError("Folder kerja bukan repo git dengan commit.", "tidak-valid");
    }
    let repoRoot: string;
    try {
      repoRoot = await realpath(topLevel);
    } catch {
      repoRoot = topLevel;
    }

    const head = await runGit(
      ["rev-parse", "--verify", "HEAD"],
      repoRoot,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    const baseCommit = head.stdout.trim();
    if (head.code !== 0 || baseCommit === "") {
      throw new WorktreeError("Folder kerja bukan repo git dengan commit.", "tidak-valid");
    }

    const prefix = await runGit(
      ["rev-parse", "--show-prefix"],
      input.cwd,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    const subdirRaw = prefix.code === 0 ? prefix.stdout.trim().replace(/\/$/, "") : "";
    const subdir = subdirRaw === "" ? undefined : subdirRaw;

    const branch = `jejak/${worktreeSlug(input.title)}-${input.sessionId}`;
    const check = await runGit(
      ["check-ref-format", "--branch", branch],
      repoRoot,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    if (check.code !== 0) {
      throw new WorktreeError("Nama cabang worktree tidak valid.", "tidak-valid");
    }

    const status = await runGit(
      ["status", "--porcelain"],
      repoRoot,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    const dirtyInSource = status.code === 0 && status.stdout.trim() !== "";

    await this.ensureRoot();

    const info: WorktreeInfo = {
      repoRoot,
      path,
      branch,
      baseCommit,
      ...(subdir === undefined ? {} : { subdir }),
    };

    await withLock(repoRoot, async () => {
      // Jangan pernah menyentuh folder yang sudah ada: bisa jadi milik worktree lain.
      const pathExisted = await this.folderExists(path);
      if (pathExisted) {
        throw new WorktreeError("Folder worktree sudah ada.", "konflik");
      }
      const existed = await this.branchExists(repoRoot, branch);
      const add = await runGit(
        ["worktree", "add", "-b", branch, path, baseCommit],
        repoRoot,
        { ...this.git, timeoutMs: GIT_TIMEOUT_MS },
        SMALL_OUTPUT_BYTES,
      );
      if (add.code !== 0 || add.timedOut) {
        await this.cleanupFailedAdd(repoRoot, path, branch, existed, pathExisted);
        throw new WorktreeError("Worktree gagal dibuat.", "gagal");
      }
    });

    return { info, dirtyInSource };
  }

  private async cleanupFailedAdd(
    repoRoot: string,
    path: string,
    branch: string,
    existed: boolean,
    pathExisted: boolean,
  ): Promise<void> {
    // Hanya hapus folder yang memang belum ada sebelum percobaan add.
    if (!pathExisted && insideRoot(this.root, path)) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // Sisa folder dibersihkan lagi oleh prune bila terdaftar.
      }
    }
    await runGit(["worktree", "prune"], repoRoot, this.git, SMALL_OUTPUT_BYTES);
    if (!existed) {
      await runGit(["branch", "-D", branch], repoRoot, this.git, SMALL_OUTPUT_BYTES);
    }
  }

  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const result = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot,
      this.git,
      SMALL_OUTPUT_BYTES,
    );
    return result.code === 0;
  }

  private async folderExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async inspect(info: WorktreeInfo): Promise<WorktreeInspect> {
    const exists = await this.folderExists(info.path);
    let dirtyFiles = 0;
    if (exists) {
      const status = await runGit(
        ["status", "--porcelain"],
        info.path,
        this.git,
        SMALL_OUTPUT_BYTES,
      );
      if (status.code === 0) {
        dirtyFiles = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
      }
    }

    const branchExists = await this.branchExists(info.repoRoot, info.branch);
    let commitsAhead = 0;
    if (branchExists) {
      const count = await runGit(
        ["rev-list", "--count", `${info.baseCommit}..${info.branch}`],
        info.repoRoot,
        this.git,
        SMALL_OUTPUT_BYTES,
      );
      const parsed = Number(count.stdout.trim());
      if (count.code === 0 && Number.isSafeInteger(parsed) && parsed > 0) {
        commitsAhead = parsed;
      }
    }

    return { exists, dirtyFiles, commitsAhead, branchExists };
  }

  async remove(info: WorktreeInfo, options: { force?: boolean } = {}): Promise<void> {
    if (!insideRoot(this.root, resolve(info.path))) {
      throw new WorktreeError("Path worktree berada di luar akar.", "tidak-valid");
    }
    const force = options.force === true;
    await withLock(info.repoRoot, async () => {
      const inspect = await this.inspect(info);
      if (inspect.exists) {
        if (!force && (inspect.dirtyFiles > 0 || inspect.commitsAhead > 0)) {
          throw new WorktreeError(
            `Worktree masih punya ${inspect.dirtyFiles} berkas berubah dan ${inspect.commitsAhead} commit belum digabung.`,
            "konflik",
            { dirtyFiles: inspect.dirtyFiles, commitsAhead: inspect.commitsAhead },
          );
        }
        const args = ["worktree", "remove", ...(force ? ["--force"] : []), info.path];
        const result = await runGit(
          args,
          info.repoRoot,
          { ...this.git, timeoutMs: GIT_TIMEOUT_MS },
          SMALL_OUTPUT_BYTES,
        );
        if (result.code !== 0 || result.timedOut) {
          throw new WorktreeError("Worktree gagal dihapus.", "gagal");
        }
      }
      await runGit(["worktree", "prune"], info.repoRoot, this.git, SMALL_OUTPUT_BYTES);
    });
  }

  async restore(info: WorktreeInfo): Promise<void> {
    if (!insideRoot(this.root, resolve(info.path))) {
      throw new WorktreeError("Path worktree berada di luar akar.", "tidak-valid");
    }
    await withLock(info.repoRoot, async () => {
      if (await this.folderExists(info.path)) return;
      if (!(await this.branchExists(info.repoRoot, info.branch))) {
        throw new WorktreeError("Cabang worktree tidak ditemukan.", "tidak-ditemukan");
      }
      await runGit(["worktree", "prune"], info.repoRoot, this.git, SMALL_OUTPUT_BYTES);
      const result = await runGit(
        ["worktree", "add", info.path, info.branch],
        info.repoRoot,
        { ...this.git, timeoutMs: GIT_TIMEOUT_MS },
        SMALL_OUTPUT_BYTES,
      );
      if (result.code !== 0 || result.timedOut) {
        throw new WorktreeError("Worktree gagal dipulihkan.", "gagal");
      }
    });
  }
}
