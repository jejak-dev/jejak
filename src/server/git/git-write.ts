import { isAbsolute, win32 } from "node:path";
import { findSecret } from "../memory/secret-guard";
import { runGit, type GitOptions } from "../files/changes";
import { FileError, normalizeRelative } from "../files/path";
import { GitError, gitStatus, type GitState } from "./git-read";

const MAX_PATHS = 200;
const MAX_MESSAGE = 2000;
const MAX_STDERR_LINES = 20;
const MAX_STDERR_CHARS = 1000;
const COMMIT_TIMEOUT_MS = 60_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const REDACTED = "[disembunyikan]";

const STATE_LABEL: Record<Exclude<GitState, "normal">, string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

export interface GitStageInput {
  paths?: string[];
  all?: boolean;
}

export interface GitCommitResult {
  hash: string;
  short: string;
  subject: string;
}

/** Kunci per akar repo agar mutasi ke repo yang sama berjalan berurutan. */
const locks = new Map<string, Promise<void>>();

function invalid(message: string): GitError {
  return new GitError(message, "tidak-valid");
}

function conflict(message: string): GitError {
  return new GitError(message, "konflik");
}

function withLiteralPathspecs(options: GitOptions): GitOptions {
  return {
    ...options,
    env: { ...options.env, GIT_LITERAL_PATHSPECS: "1" },
  };
}

async function withLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  locks.set(root, queued);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (locks.get(root) === queued) locks.delete(root);
  }
}

function validatePath(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("Path harus berupa teks.");
  }
  if (value.includes("\0")) {
    throw invalid("Path tidak valid.");
  }
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw invalid("Path harus relatif terhadap folder kerja.");
  }
  let normalized: string;
  try {
    normalized = normalizeRelative(value);
  } catch (error) {
    if (error instanceof FileError) throw invalid(error.message);
    throw error;
  }
  if (normalized === "") {
    throw invalid("Path tidak valid.");
  }
  return normalized;
}

interface ParsedInput {
  paths?: string[];
  all?: boolean;
}

/** `paths` (1..200) dan `all:true` saling eksklusif; minimal satu wajib ada. */
function parseStageInput(input: GitStageInput): ParsedInput {
  if (typeof input !== "object" || input === null) {
    throw invalid("Permintaan stage tidak valid.");
  }
  const { paths, all } = input;
  if (all !== undefined && typeof all !== "boolean") {
    throw invalid('Field "all" harus berupa boolean.');
  }
  let parsedPaths: string[] | undefined;
  if (paths !== undefined) {
    if (!Array.isArray(paths)) {
      throw invalid("Field paths harus berupa array.");
    }
    if (paths.length === 0 || paths.length > MAX_PATHS) {
      throw invalid(`Jumlah path harus 1 sampai ${MAX_PATHS}.`);
    }
    parsedPaths = paths.map(validatePath);
  }
  const wantsAll = all === true;
  if (wantsAll === (parsedPaths !== undefined)) {
    throw invalid('Kirim "paths" (1..200) atau "all: true", tidak keduanya.');
  }
  return wantsAll ? { all: true } : { paths: parsedPaths };
}

export async function gitStage(
  root: string,
  input: GitStageInput,
  options: GitOptions = {},
): Promise<void> {
  const parsed = parseStageInput(input);
  const gitOptions = withLiteralPathspecs(options);
  await withLock(root, async () => {
    const args =
      parsed.all === true ? ["add", "-A"] : ["add", "--", ...parsed.paths!];
    const result = await runGit(args, root, gitOptions, SMALL_OUTPUT_BYTES);
    if (result.timedOut) {
      throw new GitError("Stage melebihi batas waktu.", "gagal");
    }
    if (result.code !== 0) {
      throw new GitError("Stage gagal dijalankan.", "gagal");
    }
  });
}

export async function gitUnstage(
  root: string,
  input: GitStageInput,
  options: GitOptions = {},
): Promise<void> {
  const parsed = parseStageInput(input);
  const gitOptions = withLiteralPathspecs(options);
  await withLock(root, async () => {
    const args =
      parsed.all === true ? ["reset", "-q"] : ["reset", "-q", "--", ...parsed.paths!];
    const result = await runGit(args, root, gitOptions, SMALL_OUTPUT_BYTES);
    if (result.timedOut) {
      throw new GitError("Unstage melebihi batas waktu.", "gagal");
    }
    if (result.code !== 0) {
      throw new GitError("Unstage gagal dijalankan.", "gagal");
    }
  });
}

function validateMessage(message: unknown): string {
  if (typeof message !== "string") {
    throw invalid("Pesan commit harus berupa teks.");
  }
  const value = message.trim();
  if (value === "" || value.length > MAX_MESSAGE) {
    throw invalid(`Pesan commit harus 1 sampai ${MAX_MESSAGE} karakter.`);
  }
  if (value.includes("\0")) {
    throw invalid("Pesan commit tidak valid.");
  }
  return value;
}

function friendlyStderr(stderr: string): string {
  const lines = stderr.split("\n").slice(0, MAX_STDERR_LINES);
  const text = lines
    .map((line) => (findSecret(line) === null ? line : REDACTED))
    .join("\n")
    .trim();
  return text.length > MAX_STDERR_CHARS ? text.slice(0, MAX_STDERR_CHARS) : text;
}

async function assertCommitable(root: string, options: GitOptions): Promise<void> {
  const status = await gitStatus(root, options);
  if (!status.isRepo) {
    throw invalid("Folder ini bukan repo git.");
  }
  if (status.state !== "normal") {
    throw conflict(
      `Sedang ada ${STATE_LABEL[status.state]}; selesaikan di terminal.`,
    );
  }
  if (status.staged.length === 0) {
    throw conflict("Tidak ada perubahan yang ter-stage.");
  }
  if (status.unstaged.some((file) => file.status === "konflik")) {
    throw conflict("Ada konflik yang belum diselesaikan.");
  }
}

export async function gitCommit(
  root: string,
  message: string,
  options: GitOptions = {},
): Promise<GitCommitResult> {
  const value = validateMessage(message);
  const gitOptions = withLiteralPathspecs(options);

  return withLock(root, async () => {
    await assertCommitable(root, gitOptions);

    const result = await runGit(
      ["commit", "-F", "-"],
      root,
      { ...gitOptions, timeoutMs: COMMIT_TIMEOUT_MS, allowHooks: true },
      SMALL_OUTPUT_BYTES,
      value,
    );

    if (result.timedOut) {
      throw new GitError("Commit melebihi batas waktu.", "gagal");
    }
    if (result.code !== 0) {
      const stderr = result.stderr;
      if (/tell me who you are|Author identity unknown/i.test(stderr)) {
        throw invalid("Identitas git (user.name dan user.email) belum diatur.");
      }
      if (stderr.includes("index.lock")) {
        throw conflict("Operasi git lain sedang berjalan.");
      }
      throw new GitError(
        `Commit gagal (kode ${result.code ?? "?"}): ${friendlyStderr(stderr)}`,
        "gagal",
      );
    }

    const head = await runGit(
      ["rev-parse", "HEAD"],
      root,
      gitOptions,
      SMALL_OUTPUT_BYTES,
    );
    const hash = head.stdout.trim();
    if (head.code !== 0 || hash === "") {
      throw new GitError("Commit selesai tetapi hash tidak terbaca.", "gagal");
    }

    const log = await runGit(
      ["log", "-1", "--format=%s"],
      root,
      gitOptions,
      SMALL_OUTPUT_BYTES,
    );
    const rawSubject = log.stdout.trim();
    const subject =
      rawSubject === ""
        ? ""
        : findSecret(rawSubject) === null
          ? rawSubject
          : REDACTED;

    return { hash, short: hash.slice(0, 7), subject };
  });
}
