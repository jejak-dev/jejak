import { createHash } from "node:crypto";
import { resolveInside } from "./path";
import { readTextFile } from "./read";

export type ChangeStatus = "M" | "A" | "D" | "R" | "U";

export interface DiffLine {
  t: "ctx" | "add" | "del";
  text: string;
}

export interface Hunk {
  /** sha256 hex dari blok mentah hunk (baris @@ sampai akhir hunk). */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  /** sha256 hex dari teks diff mentah berkas ini. */
  diffId: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: Hunk[];
}

export interface Changes {
  isRepo: boolean;
  files: ChangedFile[];
  truncated: boolean;
}

export interface GitOptions {
  timeoutMs?: number;
  /** Tambahan/penimpa environment; dipakai tes untuk mengganti PATH. */
  env?: Record<string, string | undefined>;
  /** Izinkan hook git berjalan (hanya untuk `commit`). Default: hook dimatikan. */
  allowHooks?: boolean;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbb9ee4";
const MAX_FILES = 200;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HUNK_LINES = 500;
const MAX_UNTRACKED_LINES = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

const SAFETY_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.quotepath=false",
];

/** `commit` boleh menjalankan hook pengguna; perintah lain tidak pernah. */
const HOOKS_DISABLED_ARGS = ["-c", "core.hooksPath=/dev/null"];

function safetyArgs(allowHooks: boolean): string[] {
  return allowHooks ? SAFETY_ARGS : [...SAFETY_ARGS, ...HOOKS_DISABLED_ARGS];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface GitRunResult {
  code: number | null;
  stdout: string;
  /** Awal stderr (maks 8 KiB), untuk pesan galat yang ramah. */
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function gitEnv(extra: Record<string, string | undefined> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Menjalankan git tanpa shell dengan flag dan env keamanan yang sama untuk
 * semua pemanggil (baca maupun tulis). `stdinText` dikirim lewat stdin bila ada.
 */
export async function runGit(
  args: string[],
  cwd: string,
  options: GitOptions,
  maxBytes: number,
  stdinText?: string,
): Promise<GitRunResult> {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ["git", ...safetyArgs(options.allowHooks === true), ...args],
      cwd,
      env: gitEnv(options.env),
      stdin: stdinText === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Grup proses sendiri supaya timeout juga membunuh anak proses git
      // (mis. pager/filter) yang bisa menahan pipa stdout.
      detached: true,
    });
  } catch {
    return { code: null, stdout: "", stderr: "", truncated: false, timedOut: false };
  }

  if (stdinText !== undefined) {
    try {
      const sink = proc.stdin as { write(data: string): unknown; end(): unknown };
      sink.write(stdinText);
      sink.end();
    } catch {
      // Proses sudah berhenti; hasil ditangani lewat kode keluar.
    }
  }

  const killTree = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill();
      } catch {
        // Proses sudah selesai.
      }
    }
  };

  // stderr harus tetap dikuras agar proses anak tidak memblokir saat pipa penuh.
  // Hanya 8 KiB pertama yang disimpan; sisanya dibuang supaya memori tetap kecil.
  const stderrChunks: Uint8Array[] = [];
  let stderrTotal = 0;
  const stderrDrain = (async () => {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stderrTotal < MAX_STDERR_BYTES) {
          const remaining = MAX_STDERR_BYTES - stderrTotal;
          const kept = value.length > remaining ? value.subarray(0, remaining) : value;
          stderrChunks.push(kept);
          stderrTotal += kept.length;
        }
      }
    } catch {
      // Pipa ditutup saat proses dibunuh.
    }
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total += Math.max(remaining, 0);
        truncated = true;
        killTree();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // Aliran berhenti karena proses dibunuh atau galat baca; pakai hasil sejauh ini.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Aliran sudah selesai.
    }
  }

  let code: number | null = null;
  try {
    code = await proc.exited;
  } catch {
    code = null;
  }
  clearTimeout(timer);

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  await stderrDrain;
  const stderrMerged = new Uint8Array(stderrTotal);
  let stderrOffset = 0;
  for (const chunk of stderrChunks) {
    stderrMerged.set(chunk, stderrOffset);
    stderrOffset += chunk.length;
  }

  return {
    code,
    stdout: new TextDecoder("utf-8", { fatal: false }).decode(merged),
    stderr: new TextDecoder("utf-8", { fatal: false }).decode(stderrMerged),
    truncated: truncated || (timedOut && total > 0),
    timedOut,
  };
}

function decodeQuotedPath(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = 1;
  while (index < quoted.length - 1) {
    const char = quoted[index]!;
    if (char !== "\\") {
      const codePoint = quoted.codePointAt(index)!;
      const text = String.fromCodePoint(codePoint);
      for (const byte of encoder.encode(text)) bytes.push(byte);
      index += text.length;
      continue;
    }
    index += 1;
    const escaped = quoted[index];
    if (escaped === undefined) break;
    if (escaped >= "0" && escaped <= "7") {
      let octal = "";
      while (octal.length < 3 && index < quoted.length - 1) {
        const digit = quoted[index]!;
        if (digit < "0" || digit > "7") break;
        octal += digit;
        index += 1;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      continue;
    }
    const simple: Record<string, number> = {
      n: 10,
      t: 9,
      r: 13,
      b: 8,
      f: 12,
      v: 11,
      a: 7,
      "\\": 92,
      '"': 34,
    };
    const value = simple[escaped];
    if (value === undefined) {
      for (const byte of encoder.encode(escaped)) bytes.push(byte);
    } else {
      bytes.push(value);
    }
    index += 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/** Mengambil path dari satu medan (mis. isi setelah "--- "), mendekode kutipan dan tab. */
function parsePathField(raw: string): string | null {
  let value: string;
  if (raw.startsWith('"')) {
    let index = 1;
    let end = -1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        end = index;
        break;
      }
      index += 1;
    }
    value = end === -1 ? raw : decodeQuotedPath(raw.slice(0, end + 1));
  } else {
    value = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  }
  if (value === "/dev/null") return null;
  return value;
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseDiffHeaderPaths(line: string): { a?: string; b?: string } {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted !== null) {
    return {
      a: stripPrefix(decodeQuotedPath(quoted[1]!), "a/"),
      b: stripPrefix(decodeQuotedPath(quoted[2]!), "b/"),
    };
  }

  let index = rest.indexOf(" b/");
  while (index !== -1) {
    const left = stripPrefix(rest.slice(0, index), "a/");
    const right = stripPrefix(rest.slice(index + 1), "b/");
    if (left === right) return { a: left, b: right };
    index = rest.indexOf(" b/", index + 1);
  }

  const fallback = rest.indexOf(" b/");
  if (fallback === -1) return {};
  return {
    a: stripPrefix(rest.slice(0, fallback), "a/"),
    b: stripPrefix(rest.slice(fallback + 1), "b/"),
  };
}

interface Section {
  headerPaths: { a?: string; b?: string };
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** Baris mentah dari `diff --git` sampai sebelum berkas berikutnya. */
  rawLines: string[];
  /** Baris mentah hunk yang sedang diurai. */
  rawHunk: string[] | null;
}

function finalizeHunk(section: Section): void {
  const raw = section.rawHunk;
  section.rawHunk = null;
  if (raw === null) return;
  const hunk = section.hunks[section.hunks.length - 1];
  if (hunk !== undefined) hunk.id = sha256Hex(raw.join("\n"));
}

function sectionToFile(section: Section): ChangedFile | null {
  let status: ChangeStatus;
  let path: string | undefined;
  let oldPath: string | undefined;
  const headerPath = section.headerPaths.b ?? section.headerPaths.a;

  if (section.renameFrom !== undefined && section.renameTo !== undefined) {
    status = "R";
    path = section.renameTo;
    oldPath = section.renameFrom;
  } else if (section.oldPath === null) {
    status = "A";
    path = section.newPath ?? headerPath;
  } else if (section.newPath === null) {
    status = "D";
    path = section.oldPath ?? headerPath;
  } else {
    status = "M";
    path = section.newPath ?? section.oldPath ?? headerPath;
  }
  path ??= headerPath;

  if (path === undefined) return null;

  const file: ChangedFile = {
    path,
    status,
    diffId: sha256Hex(section.rawLines.join("\n")),
    additions: section.additions,
    deletions: section.deletions,
    binary: section.binary,
    hunks: section.hunks,
  };
  if (status === "R" && oldPath !== undefined) file.oldPath = oldPath;
  return file;
}

export function parseUnifiedDiff(output: string): { files: ChangedFile[]; truncated: boolean } {
  const lines = output.split("\n");
  const files: ChangedFile[] = [];
  let truncated = false;
  let section: Section | null = null;
  let hunk: Hunk | null = null;

  const flush = (): void => {
    if (section === null) return;
    finalizeHunk(section);
    const file = sectionToFile(section);
    if (file !== null) files.push(file);
    section = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      section = {
        headerPaths: parseDiffHeaderPaths(line),
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        rawLines: [line],
        rawHunk: null,
      };
      hunk = null;
      continue;
    }
    if (section === null) continue;
    // Baris kosong hanya muncul sebagai pemisah di ujung keluaran git.
    if (line !== "") section.rawLines.push(line);

    if (line.startsWith("@@ ")) {
      finalizeHunk(section);
      const match = HUNK_RE.exec(line);
      if (match === null) {
        hunk = null;
        continue;
      }
      hunk = {
        id: "",
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      section.hunks.push(hunk);
      section.rawHunk = [line];
      continue;
    }

    const marker = line[0];
    if (hunk !== null && (marker === " " || marker === "+" || marker === "-" || marker === "\\")) {
      section.rawHunk?.push(line);
      if (marker === "\\") continue;
      if (marker === "+") section.additions += 1;
      if (marker === "-") section.deletions += 1;
      if (hunk.lines.length < MAX_HUNK_LINES) {
        hunk.lines.push({
          t: marker === " " ? "ctx" : marker === "+" ? "add" : "del",
          text: line.slice(1),
        });
      } else {
        truncated = true;
      }
      continue;
    }

    finalizeHunk(section);
    hunk = null;

    if (line.startsWith("--- ")) {
      const parsed = parsePathField(line.slice(4));
      section.oldPath = parsed === null ? null : stripPrefix(parsed, "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const parsed = parsePathField(line.slice(4));
      section.newPath = parsed === null ? null : stripPrefix(parsed, "b/");
      continue;
    }
    if (line.startsWith("new file mode ")) {
      section.oldPath = null;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      section.newPath = null;
      continue;
    }
    if (line.startsWith("rename from ")) {
      section.renameFrom = parsePathField(line.slice("rename from ".length)) ?? undefined;
      continue;
    }
    if (line.startsWith("rename to ")) {
      section.renameTo = parsePathField(line.slice("rename to ".length)) ?? undefined;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      section.binary = true;
      continue;
    }
  }
  flush();

  return { files, truncated };
}

export interface RawDiffFile {
  /** Baris dari `diff --git` sampai baris `+++` (disambung dengan newline). */
  header: string;
  /** Blok mentah tiap hunk beserta sha256-nya. */
  hunks: Array<{ id: string; text: string }>;
}

/**
 * Mengambil header dan blok mentah hunk dari keluaran `git diff` satu berkas.
 * Dipakai untuk menyusun patch terbalik tanpa merekonstruksi teks.
 */
export function splitRawFileDiff(output: string): RawDiffFile | null {
  const lines = output.split("\n");
  const header: string[] = [];
  const hunks: Array<{ id: string; text: string }> = [];
  let current: string[] | null = null;
  let sawHeaderEnd = false;
  let sawDiff = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (sawDiff) break; // lebih dari satu berkas: hanya berkas pertama yang dipakai
      sawDiff = true;
      header.push(line);
      continue;
    }
    if (!sawDiff) continue;

    if (!sawHeaderEnd) {
      if (line.startsWith("@@ ")) {
        sawHeaderEnd = true;
      } else {
        header.push(line);
        if (line.startsWith("+++ ")) sawHeaderEnd = true;
        continue;
      }
    }

    if (line.startsWith("@@ ")) {
      if (current !== null) hunks.push({ id: sha256Hex(current.join("\n")), text: current.join("\n") });
      current = [line];
      continue;
    }
    if (current === null) continue;
    if (line === "") {
      // Baris kosong di ujung keluaran git menandakan hunk selesai.
      hunks.push({ id: sha256Hex(current.join("\n")), text: current.join("\n") });
      current = null;
      continue;
    }
    current.push(line);
  }
  if (current !== null) {
    hunks.push({ id: sha256Hex(current.join("\n")), text: current.join("\n") });
  }
  if (!sawDiff) return null;

  // Buang baris kosong di ujung header (pemisah keluaran git).
  while (header.length > 0 && header[header.length - 1] === "") header.pop();
  return { header: header.join("\n"), hunks };
}

interface UntrackedResult {
  file: ChangedFile;
  truncated: boolean;
}

async function untrackedEntry(cwd: string, rel: string): Promise<UntrackedResult> {
  try {
    // resolveInside menolak symlink yang menunjuk keluar folder kerja.
    await resolveInside(cwd, rel);
    const read = await readTextFile(cwd, rel);
    if (read.binary || read.truncated) {
      return {
        file: {
          path: rel,
          status: "U",
          diffId: sha256Hex(`untracked\0${rel}\0binary`),
          additions: 0,
          deletions: 0,
          binary: true,
          hunks: [],
        },
        truncated: false,
      };
    }

    const allLines = (read.content ?? "").split("\n");
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
    if (allLines.length === 0) {
      return {
        file: {
          path: rel,
          status: "U",
          diffId: sha256Hex(`untracked\0${rel}\0empty`),
          additions: 0,
          deletions: 0,
          binary: false,
          hunks: [],
        },
        truncated: false,
      };
    }
    const stored = allLines.slice(0, MAX_UNTRACKED_LINES);
    const header = `@@ -0,0 +1,${allLines.length} @@`;
    const hunk: Hunk = {
      id: sha256Hex([header, ...allLines.map((text) => `+${text}`)].join("\n")),
      header,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: allLines.length,
      lines: stored.map((text) => ({ t: "add", text })),
    };
    return {
      file: {
        path: rel,
        status: "U",
        diffId: hunk.id,
        additions: allLines.length,
        deletions: 0,
        binary: false,
        hunks: [hunk],
      },
      truncated: allLines.length > MAX_UNTRACKED_LINES,
    };
  } catch {
    // Tidak terbaca aman (symlink keluar cwd, hilang, dll): laporkan sebagai biner.
    return {
      file: {
        path: rel,
        status: "U",
        diffId: sha256Hex(`untracked\0${rel}\0binary`),
        additions: 0,
        deletions: 0,
        binary: true,
        hunks: [],
      },
      truncated: false,
    };
  }
}

export async function getChanges(cwd: string, options: GitOptions = {}): Promise<Changes> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, options, SMALL_OUTPUT_BYTES);
  if (inside.timedOut) {
    // Git menggantung; laporkan sebagai hasil sebagian, bukan "bukan repo".
    return { isRepo: true, files: [], truncated: true };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { isRepo: false, files: [], truncated: false };
  }

  const head = await runGit(["rev-parse", "--verify", "HEAD"], cwd, options, SMALL_OUTPUT_BYTES);
  const hasHead = head.code === 0 && head.stdout.trim() !== "";
  const diffArgs = ["-U3", "--relative", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color"];

  let diff = await runGit(
    ["diff", hasHead ? "HEAD" : EMPTY_TREE, ...diffArgs],
    cwd,
    options,
    MAX_OUTPUT_BYTES,
  );
  if (!hasHead && diff.code !== 0 && !diff.timedOut) {
    // Repo baru biasanya belum punya objek tree kosong di object database.
    // `git diff --cached` membandingkan indeks dengan tree kosong secara implisit.
    diff = await runGit(["diff", "--cached", ...diffArgs], cwd, options, MAX_OUTPUT_BYTES);
  }

  let truncated = diff.truncated || diff.timedOut;
  const parsed = parseUnifiedDiff(diff.stdout);
  truncated = truncated || parsed.truncated;
  const files = parsed.files;

  if (!diff.timedOut) {
    // Anggaran 2 MiB berlaku untuk total keluaran git, bukan per perintah.
    const budget = MAX_OUTPUT_BYTES - new TextEncoder().encode(diff.stdout).length;
    if (budget <= 0) {
      truncated = true;
    } else {
      const untracked = await runGit(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        cwd,
        options,
        budget,
      );
      truncated = truncated || untracked.truncated || untracked.timedOut;
      if (untracked.code === 0) {
        for (const rel of untracked.stdout.split("\0")) {
          if (rel === "") continue;
          const result = await untrackedEntry(cwd, rel);
          if (result.truncated) truncated = true;
          files.push(result.file);
        }
      }
    }
  }

  let limited = files;
  if (limited.length > MAX_FILES) {
    truncated = true;
    limited = limited.slice(0, MAX_FILES);
  }

  return { isRepo: true, files: limited, truncated };
}
