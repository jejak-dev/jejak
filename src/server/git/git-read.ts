import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findSecret } from "../memory/secret-guard";
import { runGit, type GitOptions } from "../files/changes";

export type GitState = "normal" | "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export type GitFileStatus =
  | "ditambah"
  | "diubah"
  | "dihapus"
  | "diganti"
  | "disalin"
  | "konflik"
  | "tipe-berubah";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  from?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  detached: boolean;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  state: GitState;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: string[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export type GitErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik" | "gagal";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const MAX_ENTRIES = 2000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const SHOW_COMMAND_BYTES = 128 * 1024;
const MAX_SHOW_LINES = 200;
const MAX_SHOW_BYTES = 64 * 1024;
const MAX_SUBJECT = 200;
const DEFAULT_LOG_LIMIT = 30;
const REDACTED = "[disembunyikan]";
const HASH_RE = /^[0-9a-f]{7,40}$/;
const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e";

function redact(text: string): string {
  return findSecret(text) === null ? text : REDACTED;
}

function mapStatus(code: string | undefined): GitFileStatus | null {
  switch (code) {
    case "A":
      return "ditambah";
    case "M":
      return "diubah";
    case "D":
      return "dihapus";
    case "R":
      return "diganti";
    case "C":
      return "disalin";
    case "T":
      return "tipe-berubah";
    case "U":
      return "konflik";
    default:
      return null;
  }
}

export type ParsedStatusV2 = Omit<GitStatus, "isRepo" | "state">;

/**
 * Mengurai `git status --porcelain=v2 --branch -z`. Rekaman dipisah NUL;
 * entri `2` (rename/copy) menyimpan path asal pada rekaman berikutnya.
 */
export function parseStatusV2(text: string): ParsedStatusV2 {
  const result: ParsedStatusV2 = {
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    truncated: false,
  };
  const records = text.split("\0");
  let count = 0;

  const add = (list: GitFile[], file: GitFile): void => {
    if (count >= MAX_ENTRIES) {
      result.truncated = true;
      return;
    }
    count += 1;
    list.push(file);
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "") continue;

    if (record.startsWith("# ")) {
      const space = record.indexOf(" ", 2);
      const key = space === -1 ? record.slice(2) : record.slice(2, space);
      const value = space === -1 ? "" : record.slice(space + 1);
      if (key === "branch.oid") {
        if (value !== "(initial)") result.head = value;
      } else if (key === "branch.head") {
        if (value === "(detached)") result.detached = true;
        else result.branch = value;
      } else if (key === "branch.upstream") {
        result.upstream = value;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match !== null) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }

    if (record.startsWith("? ")) {
      if (count >= MAX_ENTRIES) {
        result.truncated = true;
        continue;
      }
      count += 1;
      result.untracked.push(record.slice(2));
      continue;
    }

    if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      if (path === "") continue;
      const staged = mapStatus(xy[0]);
      const unstaged = mapStatus(xy[1]);
      if (staged !== null) add(result.staged, { path, status: staged });
      if (unstaged !== null) add(result.unstaged, { path, status: unstaged });
      continue;
    }

    if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      const from = records[index + 1];
      index += 1;
      if (path === "") continue;
      const staged = mapStatus(xy[0]);
      const unstaged = mapStatus(xy[1]);
      if (staged !== null) {
        const file: GitFile = { path, status: staged };
        if (from !== undefined && from !== "") file.from = from;
        add(result.staged, file);
      }
      if (unstaged !== null) add(result.unstaged, { path, status: unstaged });
      continue;
    }

    if (record.startsWith("u ")) {
      const parts = record.split(" ");
      const path = parts.slice(10).join(" ");
      if (path === "") continue;
      add(result.unstaged, { path, status: "konflik" });
    }
  }

  return result;
}

async function detectState(root: string, options: GitOptions): Promise<GitState> {
  const dir = await runGit(["rev-parse", "--git-dir"], root, options, SMALL_OUTPUT_BYTES);
  if (dir.code !== 0 || dir.stdout.trim() === "") return "normal";
  const gitDir = isAbsolute(dir.stdout.trim())
    ? dir.stdout.trim()
    : resolve(root, dir.stdout.trim());
  if (
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply"))
  ) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
  return "normal";
}

export async function gitStatus(root: string, options: GitOptions = {}): Promise<GitStatus> {
  const empty: GitStatus = {
    isRepo: false,
    detached: false,
    state: "normal",
    staged: [],
    unstaged: [],
    untracked: [],
    truncated: false,
  };

  const inside = await runGit(
    ["rev-parse", "--is-inside-work-tree"],
    root,
    options,
    SMALL_OUTPUT_BYTES,
  );
  if (inside.timedOut) {
    return { ...empty, isRepo: true, truncated: true };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return empty;
  }

  const status = await runGit(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    root,
    options,
    MAX_OUTPUT_BYTES,
  );
  if (status.code !== 0) {
    return { ...empty, isRepo: true, truncated: true };
  }

  const parsed = parseStatusV2(status.stdout);
  const truncated = parsed.truncated || status.truncated || status.timedOut;
  return {
    isRepo: true,
    ...parsed,
    truncated,
    state: await detectState(root, options),
  };
}

export function parseLog(text: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of text.split("\x1e")) {
    const clean = record.replace(/^[\r\n]+/, "");
    if (clean.trim() === "") continue;
    const fields = clean.split("\x1f");
    if (fields.length < 5) continue;
    const hash = fields[0]!.trim();
    const short = fields[1]!.trim();
    const rawSubject = fields[2]!.trim();
    const author = fields[3]!.trim();
    const date = fields[4]!.trim();
    if (hash === "") continue;
    const subject = rawSubject.length > MAX_SUBJECT ? rawSubject.slice(0, MAX_SUBJECT) : rawSubject;
    commits.push({ hash, short, subject: redact(subject), author, date });
  }
  return commits;
}

export async function gitLog(
  root: string,
  options: { limit?: number } = {},
  gitOptions: GitOptions = {},
): Promise<{ commits: GitCommit[] }> {
  const requested = options.limit ?? DEFAULT_LOG_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.min(100, Math.max(1, Math.floor(requested)))
    : DEFAULT_LOG_LIMIT;
  const result = await runGit(
    ["log", "-n", String(limit), `--format=${LOG_FORMAT}`],
    root,
    gitOptions,
    MAX_OUTPUT_BYTES,
  );
  if (result.code !== 0) {
    return { commits: [] };
  }
  return { commits: parseLog(result.stdout).slice(0, limit) };
}

export async function gitShow(
  root: string,
  hash: string,
  options: GitOptions = {},
): Promise<{ text: string; truncated: boolean }> {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) {
    throw new GitError("Hash commit tidak valid.", "tidak-valid");
  }

  const result = await runGit(
    ["show", "--stat", "--format=fuller", "--no-color", hash],
    root,
    options,
    SHOW_COMMAND_BYTES,
  );
  if (result.timedOut) {
    throw new GitError("Perintah git gagal dijalankan.", "gagal");
  }
  if (result.code !== 0) {
    throw new GitError("Commit tidak ditemukan.", "tidak-ditemukan");
  }

  const encoder = new TextEncoder();
  const lines = result.stdout.split("\n");
  let text = "";
  let bytes = 0;
  let used = 0;
  let truncated = result.truncated;
  for (const line of lines) {
    if (used >= MAX_SHOW_LINES) {
      truncated = true;
      break;
    }
    const piece = used === 0 ? redact(line) : `\n${redact(line)}`;
    const size = encoder.encode(piece).length;
    if (bytes + size > MAX_SHOW_BYTES) {
      truncated = true;
      break;
    }
    text += piece;
    bytes += size;
    used += 1;
  }

  return { text, truncated };
}
