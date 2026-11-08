import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { runShadowGit, type ShadowSession } from "./shadow-git";

export type CheckpointKind = "turn" | "manual" | "pre-rewind";

export interface CheckpointItem {
  id: string;
  kind: CheckpointKind;
  turn?: number;
  label: string;
  createdAt: string;
  files: number;
}

export type ChangeAction = "restore" | "recreate" | "remove";

export interface CheckpointChange {
  path: string;
  action: ChangeAction;
}

export interface PreviewResult {
  changes: CheckpointChange[];
  truncated: boolean;
}

export interface RewindResult {
  safetyId: string;
  restored: number;
  recreated: number;
  removed: number;
}

export interface CreateCheckpointInput {
  kind: CheckpointKind;
  turn?: number;
  label?: string;
}

export type CreateCheckpointResult =
  | { enabled: true; item: CheckpointItem }
  | { enabled: false; reason: string };

export interface ListCheckpointsResult {
  enabled: boolean;
  reason?: string;
  items: CheckpointItem[];
}

export interface CheckpointServiceOptions {
  /** Direktori akar, default `<JEJAK_HOME>/checkpoints` oleh pemanggil. */
  root: string;
  now?: () => Date;
  /** Peta mutex yang bisa dibagi antar layanan; default peta internal. */
  mutexes?: Map<string, Promise<unknown>>;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CheckpointError";
  }
}

const SESSION_ID_RE = /^s_[0-9a-f]{8}$/;
const CID_RE = /^[0-9a-fA-F]{40}$/;
const KINDS: readonly CheckpointKind[] = ["turn", "manual", "pre-rewind"];
const MAX_ITEMS = 50;
const MAX_CHANGES = 500;
const GROUP_SIZE = 50;
const INDEX_FILE = "index.json";
const DISABLED_FILE = "disabled.json";
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DEFAULT_LABEL = "Titik manual";
const DISABLED_MESSAGE = "Folder kerja terlalu besar untuk checkpoint";

const BASE_EXCLUDES = [
  ".git",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  ".venv/",
  "__pycache__/",
  ".DS_Store",
];

const DEFAULTS = {
  maxFiles: 20_000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
} as const;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function trimCommitText(text: string): string {
  return text.replace(CONTROL_RE, "").slice(0, 80);
}

function isSafeRelative(rel: string): boolean {
  if (rel === "" || rel.includes("\0")) return false;
  if (isAbsolute(rel) || win32.isAbsolute(rel)) return false;
  const segments = rel.split("/");
  return !segments.includes("..") && !segments.includes("");
}

function validateRelative(rel: string): string {
  if (!isSafeRelative(rel)) {
    throw new CheckpointError("Path checkpoint tidak valid.", 400);
  }
  return rel;
}

/** Pola gitignore literal, dengan path berakar di folder kerja. */
export function excludePattern(rel: string): string {
  let escaped = "";
  for (const char of rel) {
    escaped += "\\*?[#! ".includes(char) ? `\\${char}` : char;
  }
  return `/${escaped}`;
}

function parseZ(stdout: string): string[] {
  return stdout.split("\0").filter((item) => item !== "");
}

function parseStatusZ(stdout: string): Array<{ status: string; path: string }> {
  const parts = stdout.split("\0");
  const result: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? "";
    const path = parts[i + 1] ?? "";
    if (status === "" || path === "") continue;
    result.push({ status, path });
  }
  return result;
}

function parseIndex(raw: string): CheckpointItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: CheckpointItem[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !CID_RE.test(record.id)) continue;
    if (!KINDS.includes(record.kind as CheckpointKind)) continue;
    if (typeof record.label !== "string" || typeof record.createdAt !== "string") continue;
    if (typeof record.files !== "number") continue;
    const item: CheckpointItem = {
      id: record.id.toLowerCase(),
      kind: record.kind as CheckpointKind,
      label: record.label,
      createdAt: record.createdAt,
      files: record.files,
    };
    if (typeof record.turn === "number") item.turn = record.turn;
    items.push(item);
  }
  return items;
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

function actionFor(status: string): ChangeAction | null {
  if (status === "A") return "remove";
  if (status === "M" || status === "T") return "restore";
  if (status === "D") return "recreate";
  return null;
}

interface SessionState {
  sessionId: string;
  dir: string;
  gitDir: string;
  workTree: string;
  shadow: ShadowSession;
}

interface Candidates {
  all: string[];
  tracked: Set<string>;
}

export class CheckpointService {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly mutexes: Map<string, Promise<unknown>>;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;

  constructor(options: CheckpointServiceOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
    this.mutexes = options.mutexes ?? new Map();
    this.maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes;
  }

  private sessionIdOf(id: string): string {
    if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
      throw new CheckpointError("Sesi tidak valid.", 400);
    }
    return id;
  }

  private sessionDir(id: string): string {
    const sessionId = this.sessionIdOf(id);
    const dir = resolve(this.root, sessionId);
    if (dir !== join(this.root, sessionId) || !inside(this.root, dir)) {
      throw new CheckpointError("Sesi tidak valid.", 400);
    }
    return dir;
  }

  private state(id: string, cwd: string): SessionState {
    const sessionId = this.sessionIdOf(id);
    const dir = this.sessionDir(sessionId);
    const gitDir = join(dir, "git");
    return {
      sessionId,
      dir,
      gitDir,
      workTree: cwd,
      shadow: { gitDir, workTree: cwd },
    };
  }

  private withMutex<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    this.mutexes.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async list(sessionId: string, _cwd: string): Promise<ListCheckpointsResult> {
    const id = this.sessionIdOf(sessionId);
    return this.withMutex(id, async () => {
      const reason = await this.disabledReason(id);
      if (reason !== null) {
        return { enabled: false, reason, items: [] };
      }
      return { enabled: true, items: await this.readIndex(id) };
    });
  }

  async remove(sessionId: string): Promise<void> {
    const id = this.sessionIdOf(sessionId);
    const dir = this.sessionDir(id);
    await this.withMutex(id, async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }

  async create(
    sessionId: string,
    cwd: string,
    input: CreateCheckpointInput,
  ): Promise<CreateCheckpointResult> {
    const state = this.state(sessionId, cwd);
    return this.withMutex(state.sessionId, () => this.createLocked(state, input));
  }

  async preview(sessionId: string, cwd: string, cid: string): Promise<PreviewResult> {
    const state = this.state(sessionId, cwd);
    return this.withMutex(state.sessionId, async () => {
      const target = await this.requirePoint(state, cid);
      const current = await this.snapshotCurrent(state);
      return this.diffChanges(state, target.id, current);
    });
  }

  async rewind(sessionId: string, cwd: string, cid: string): Promise<RewindResult> {
    const state = this.state(sessionId, cwd);
    return this.withMutex(state.sessionId, () => this.rewindLocked(state, cid));
  }

  // ---------------------------------------------------------------------------

  private async disabledReason(sessionId: string): Promise<string | null> {
    const dir = this.sessionDir(sessionId);
    try {
      const raw = await readFile(join(dir, DISABLED_FILE), "utf8");
      const parsed = JSON.parse(raw) as { reason?: unknown };
      return typeof parsed.reason === "string" ? parsed.reason : DISABLED_MESSAGE;
    } catch {
      return null;
    }
  }

  private async readIndex(sessionId: string): Promise<CheckpointItem[]> {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), INDEX_FILE), "utf8");
      return parseIndex(raw);
    } catch {
      return [];
    }
  }

  private async writeAtomic(dir: string, name: string, body: string): Promise<void> {
    await this.ensureDir(dir);
    const target = join(dir, name);
    const temp = join(dir, `.${name}.${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, body, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await chmod(target, 0o600);
  }

  private async writeDisabled(state: SessionState, reason: string): Promise<void> {
    await this.writeAtomic(state.dir, DISABLED_FILE, `${JSON.stringify({ reason })}\n`);
  }

  private async writeIndex(state: SessionState, items: CheckpointItem[]): Promise<void> {
    await this.writeAtomic(state.dir, INDEX_FILE, `${JSON.stringify(items, null, 2)}\n`);
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      // Sebagian sistem berkas tidak mendukung chmod.
    }
  }

  private async ensureRepo(state: SessionState): Promise<void> {
    await this.ensureDir(this.root);
    await this.ensureDir(state.dir);
    try {
      const info = await stat(join(state.gitDir, "HEAD"));
      if (info.isFile()) return;
    } catch {
      // Repo bayangan belum ada.
    }
    const init = await runShadowGit(state.shadow, ["init", "-q", "--template="]);
    if (init.code !== 0) {
      throw new CheckpointError("Checkpoint tidak dapat disiapkan.", 500);
    }
    for (const [key, value] of [
      ["user.name", "jejak"],
      ["user.email", "jejak@localhost"],
      ["commit.gpgsign", "false"],
      ["core.fileMode", "true"],
    ] as const) {
      await runShadowGit(state.shadow, ["config", key, value]);
    }
    try {
      await chmod(state.gitDir, 0o700);
    } catch {
      // Abaikan.
    }
  }

  private async writeExclude(state: SessionState, large: string[]): Promise<void> {
    const infoDir = join(state.gitDir, "info");
    await mkdir(infoDir, { recursive: true, mode: 0o700 });
    const lines = [...BASE_EXCLUDES, ...large.map((rel) => excludePattern(rel))];
    await writeFile(join(infoDir, "exclude"), `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  private async candidates(state: SessionState): Promise<Candidates> {
    const trackedResult = await runShadowGit(state.shadow, [
      "--literal-pathspecs",
      "ls-files",
      "-z",
    ]);
    const untrackedResult = await runShadowGit(state.shadow, [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const tracked = new Set(parseZ(trackedResult.stdout));
    const all = new Set(tracked);
    for (const item of parseZ(untrackedResult.stdout)) all.add(item);
    return { all: Array.from(all), tracked };
  }

  private async largeFiles(state: SessionState, paths: string[]): Promise<string[]> {
    const large: string[] = [];
    for (const rel of paths) {
      if (!isSafeRelative(rel)) continue;
      try {
        const info = await lstat(join(state.workTree, rel));
        if (info.isFile() && info.size > this.maxFileBytes) large.push(rel);
      } catch {
        // Berkas hilang di antara pendaftaran dan pemeriksaan.
      }
    }
    return large;
  }

  /** Tulis exclude dasar, cari berkas > 5 MiB, lalu bangun ulang exclude. */
  private async prepareExclude(state: SessionState): Promise<Candidates & { large: string[] }> {
    await this.writeExclude(state, []);
    const first = await this.candidates(state);
    const large = await this.largeFiles(state, first.all);
    if (large.length > 0) await this.writeExclude(state, large);
    const second = large.length > 0 ? await this.candidates(state) : first;
    return { ...second, large };
  }

  private async stagedSize(state: SessionState, paths: string[]): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    for (const rel of paths) {
      if (!isSafeRelative(rel)) continue;
      try {
        const info = await lstat(join(state.workTree, rel));
        if (!info.isFile()) continue;
        if (info.size > this.maxFileBytes) continue;
        count += 1;
        bytes += info.size;
      } catch {
        // Berkas hilang; tidak dihitung.
      }
    }
    return { count, bytes };
  }

  private async untrackLarge(state: SessionState, large: string[], tracked: Set<string>): Promise<void> {
    const paths = large.filter((rel) => tracked.has(rel));
    for (const group of chunk(paths, GROUP_SIZE)) {
      await runShadowGit(state.shadow, [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "-q",
        "--ignore-unmatch",
        "--",
        ...group,
      ]);
    }
  }

  private async head(state: SessionState): Promise<string | null> {
    const result = await runShadowGit(state.shadow, ["rev-parse", "--verify", "HEAD"]);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return CID_RE.test(value) ? value.toLowerCase() : null;
  }

  private async countFiles(state: SessionState, cid: string): Promise<number> {
    const result = await runShadowGit(state.shadow, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      cid,
    ]);
    return result.code === 0 ? parseZ(result.stdout).length : 0;
  }

  private async commitCurrent(state: SessionState, message: string): Promise<string> {
    const add = await runShadowGit(state.shadow, ["add", "-A"]);
    if (add.code !== 0 || add.timedOut) {
      throw new CheckpointError("Checkpoint tidak dapat dibuat.", 500);
    }
    const commit = await runShadowGit(state.shadow, [
      "commit",
      "--allow-empty",
      "--no-verify",
      "-q",
      "-m",
      message,
    ]);
    if (commit.code !== 0 || commit.timedOut) {
      throw new CheckpointError("Checkpoint tidak dapat dibuat.", 500);
    }
    const head = await this.head(state);
    if (head === null) {
      throw new CheckpointError("Checkpoint tidak dapat dibuat.", 500);
    }
    return head;
  }

  private async snapshotCurrent(state: SessionState): Promise<string> {
    const prepared = await this.prepareExclude(state);
    await this.untrackLarge(state, prepared.large, prepared.tracked);
    return this.commitCurrent(state, "current");
  }

  private validateLabel(label: string | undefined): string {
    const value = (label ?? "").trim();
    if (value === "") return DEFAULT_LABEL;
    if (value.length > 80 || CONTROL_RE.test(value)) {
      throw new CheckpointError("Label checkpoint harus 1..80 karakter tanpa karakter kontrol.", 400);
    }
    return value;
  }

  private async createLocked(
    state: SessionState,
    input: CreateCheckpointInput,
  ): Promise<CreateCheckpointResult> {
    const reason = await this.disabledReason(state.sessionId);
    if (reason !== null) {
      return { enabled: false, reason };
    }
    if (!KINDS.includes(input.kind)) {
      throw new CheckpointError("Jenis titik checkpoint tidak valid.", 400);
    }

    let label = "";
    if (input.kind === "pre-rewind") {
      label = trimCommitText(input.label ?? "Sebelum rewind") || "Sebelum rewind";
    } else if (input.kind === "manual") {
      label = this.validateLabel(input.label);
    }

    await this.ensureRepo(state);
    const prepared = await this.prepareExclude(state);
    const sizes = await this.stagedSize(state, prepared.all);
    if (sizes.count > this.maxFiles || sizes.bytes > this.maxTotalBytes) {
      const reasonText = `${DISABLED_MESSAGE} (${sizes.count} berkas, ${Math.ceil(
        sizes.bytes / (1024 * 1024),
      )} MiB; batas ${this.maxFiles} berkas / ${Math.ceil(
        this.maxTotalBytes / (1024 * 1024),
      )} MiB).`;
      await this.writeDisabled(state, reasonText);
      return { enabled: false, reason: reasonText };
    }

    await this.untrackLarge(state, prepared.large, prepared.tracked);

    const suffix =
      input.turn !== undefined
        ? String(input.turn)
        : label !== ""
          ? label
          : input.kind;
    const id = await this.commitCurrent(state, trimCommitText(`${input.kind}:${suffix}`));
    const files = await this.countFiles(state, id);

    const item: CheckpointItem = {
      id,
      kind: input.kind,
      label:
        label !== "" ? label : input.turn !== undefined ? `Giliran ${input.turn}` : input.kind,
      createdAt: this.now().toISOString(),
      files,
    };
    if (input.turn !== undefined) item.turn = input.turn;

    const items = await this.readIndex(state.sessionId);
    items.unshift(item);
    await this.writeIndex(state, items.slice(0, MAX_ITEMS));
    return { enabled: true, item };
  }

  private async requirePoint(state: SessionState, cid: string): Promise<CheckpointItem> {
    if (typeof cid !== "string" || !CID_RE.test(cid)) {
      throw new CheckpointError("Titik checkpoint tidak valid.", 400);
    }
    const wanted = cid.toLowerCase();
    const items = await this.readIndex(state.sessionId);
    const found = items.find((item) => item.id === wanted);
    if (found === undefined) {
      throw new CheckpointError(`Titik checkpoint "${cid}" tidak ditemukan.`, 404);
    }
    return found;
  }

  private async diffChanges(
    state: SessionState,
    target: string,
    current: string,
  ): Promise<PreviewResult> {
    const result = await runShadowGit(state.shadow, [
      "--literal-pathspecs",
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      target,
      current,
    ]);
    if (result.code !== 0 || result.timedOut) {
      throw new CheckpointError("Perubahan checkpoint tidak dapat dibaca.", 500);
    }
    const entries = parseStatusZ(result.stdout);
    const changes: CheckpointChange[] = [];
    let truncated = entries.length > MAX_CHANGES;
    for (const entry of entries) {
      if (changes.length >= MAX_CHANGES) break;
      const action = actionFor(entry.status);
      if (action === null) continue;
      const path = entry.path;
      if (!isSafeRelative(path)) continue;
      if (await this.isOversizedNow(state, path)) continue;
      changes.push({ path, action });
    }
    if (changes.length >= MAX_CHANGES && entries.length > changes.length) truncated = true;
    return { changes, truncated };
  }

  private async isOversizedNow(state: SessionState, rel: string): Promise<boolean> {
    try {
      const info = await lstat(join(state.workTree, rel));
      return info.isFile() && info.size > this.maxFileBytes;
    } catch {
      return false;
    }
  }

  private async rewindLocked(state: SessionState, cid: string): Promise<RewindResult> {
    const target = await this.requirePoint(state, cid);
    const reason = await this.disabledReason(state.sessionId);
    if (reason !== null) {
      throw new CheckpointError(reason, 409);
    }

    const safety = await this.createLocked(state, {
      kind: "pre-rewind",
      label: `Sebelum rewind ke ${target.label}`,
    });
    if (!safety.enabled) {
      throw new CheckpointError(safety.reason, 409);
    }
    const safetyId = safety.item.id;

    const preview = await this.diffChanges(state, target.id, safetyId);
    const recreateSet = new Set(
      preview.changes.filter((change) => change.action === "recreate").map((change) => change.path),
    );
    const restore = preview.changes
      .filter((change) => change.action === "restore" || change.action === "recreate")
      .map((change) => change.path);
    const remove = preview.changes
      .filter((change) => change.action === "remove")
      .map((change) => change.path);

    let restored = 0;
    let recreated = 0;
    let removed = 0;

    for (const group of chunk(restore, GROUP_SIZE)) {
      const result = await runShadowGit(state.shadow, [
        "--literal-pathspecs",
        "checkout",
        target.id,
        "--",
        ...group,
      ]);
      if (result.code !== 0 || result.timedOut) {
        throw this.rewindFailure(safetyId);
      }
      for (const path of group) {
        if (recreateSet.has(path)) recreated += 1;
        else restored += 1;
      }
    }

    if (remove.length > 0) {
      const existingDirs = await this.dirsAtPoint(state, target.id);
      const root = await realpathWorkTree(state);
      for (const rel of remove) {
        try {
          if (await this.removePath(root, rel, existingDirs)) removed += 1;
        } catch (error) {
          throw this.rewindFailure(safetyId, error);
        }
      }
    }

    return { safetyId, restored, recreated, removed };
  }

  private rewindFailure(safetyId: string, cause?: unknown): CheckpointError {
    // Pesan galat tidak boleh memuat path absolut; hanya galat milik layanan
    // ini yang aman ditampilkan.
    const detail = cause instanceof CheckpointError ? `: ${cause.message}` : "";
    return new CheckpointError(
      `Rewind gagal. Keadaan sebelum rewind tersimpan di titik ${safetyId}${detail}`,
      500,
    );
  }

  private async dirsAtPoint(state: SessionState, cid: string): Promise<Set<string>> {
    const result = await runShadowGit(state.shadow, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      cid,
    ]);
    const dirs = new Set<string>();
    if (result.code !== 0) return dirs;
    for (const file of parseZ(result.stdout)) {
      let parent = dirname(file);
      while (parent !== "." && parent !== "" && !dirs.has(parent)) {
        dirs.add(parent);
        parent = dirname(parent);
      }
    }
    return dirs;
  }

  /**
   * Menghapus satu berkas yang tidak ada di titik target. Komponen induk harus
   * bukan symlink dan realpath induk harus tetap di dalam folder kerja; hanya
   * direktori kosong yang boleh dibuang setelahnya.
   */
  private async removePath(
    root: string,
    rel: string,
    existingDirs: Set<string>,
  ): Promise<boolean> {
    const normalized = validateRelative(rel);
    const abs = resolve(root, normalized);
    if (abs === root || !inside(root, abs)) {
      throw new CheckpointError("Path checkpoint tidak valid.", 400);
    }

    const parent = dirname(abs);
    let current = parent;
    while (true) {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new CheckpointError("Path melewati symlink; tidak dihapus.", 409);
      }
      if (current === root) break;
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }    const parentReal = await realpathOrNull(parent);
    if (parentReal === null || !inside(root, parentReal)) {
      throw new CheckpointError("Path di luar folder kerja; tidak dihapus.", 409);
    }

    const target = await lstatOrNull(abs);
    if (target === null) return false;
    if (target.isDirectory()) {
      throw new CheckpointError("Target bukan berkas; tidak dihapus.", 409);
    }
    await unlink(abs);

    let dir = parent;
    while (dir !== root && inside(root, dir)) {
      const relDir = dir.slice(root.length + 1);
      if (existingDirs.has(relDir)) break;
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
    return true;
  }
}

async function realpathWorkTree(state: SessionState): Promise<string> {
  return realpath(state.workTree);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Nama folder sesi valid di direktori checkpoint (dipakai doctor). */
export async function listSessionDirs(root: string): Promise<string[]> {
  try {
    const names = await readdir(root);
    return names.filter((name) => SESSION_ID_RE.test(name));
  } catch {
    return [];
  }
}
