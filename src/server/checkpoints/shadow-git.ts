import { nullDevice } from "../platform";

export interface ShadowSession {
  /** GIT_DIR repo bayangan (di dalam JEJAK_HOME, bukan milik pengguna). */
  gitDir: string;
  /** GIT_WORK_TREE folder kerja sesi. */
  workTree: string;
}

export interface ShadowGitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Dikirim lewat stdin bila ada. */
  stdinText?: string;
}

export interface ShadowGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export const SHADOW_TIMEOUT_MS = 30_000;
export const SHADOW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Konfigurasi yang menetralkan apa pun yang bisa dieksekusi git: hook, filter
 * eksternal, pager, fsmonitor, dan konfigurasi global/sistem pengguna.
 */
function safetyArgs(): string[] {
  return [
    "-c",
    `core.hooksPath=${nullDevice()}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "core.quotepath=false",
    "-c",
    "gc.auto=0",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.symlinks=true",
  ];
}

function shadowEnv(session: ShadowSession): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_DIR = session.gitDir;
  env.GIT_WORK_TREE = session.workTree;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = nullDevice();
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

/**
 * Menjalankan git untuk repo bayangan dengan array argumen (tanpa shell),
 * batas waktu, dan batas keluaran. Semua pathspec pemanggil memakai
 * `--literal-pathspecs`.
 */
export async function runShadowGit(
  session: ShadowSession,
  args: string[],
  options: ShadowGitOptions = {},
): Promise<ShadowGitResult> {
  const maxBytes = options.maxBytes ?? SHADOW_MAX_OUTPUT_BYTES;
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ["git", ...safetyArgs(), ...args],
      cwd: session.workTree,
      env: shadowEnv(session),
      stdin: options.stdinText === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Grup proses sendiri agar timeout juga membunuh anak proses git.
      detached: true,
    });
  } catch {
    return { code: null, stdout: "", stderr: "", truncated: false, timedOut: false };
  }

  if (options.stdinText !== undefined) {
    try {
      const sink = proc.stdin as { write(data: string): unknown; end(): unknown };
      sink.write(options.stdinText);
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

  const readAll = async (
    stream: ReadableStream<Uint8Array>,
    limit: number | null,
  ): Promise<{ text: string; truncated: boolean }> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (limit !== null && total + value.length > limit) {
          const remaining = limit - total;
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          truncated = true;
          killTree();
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } catch {
      // Aliran berhenti karena proses dibunuh; pakai hasil sejauh ini.
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Aliran sudah selesai.
      }
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return { text: new TextDecoder().decode(joined), truncated };
  };

  // stderr dikuras terpisah agar proses anak tidak memblokir saat pipa penuh.
  const stderrPromise = readAll(proc.stderr as ReadableStream<Uint8Array>, 64 * 1024);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, options.timeoutMs ?? SHADOW_TIMEOUT_MS);

  const [out, err] = await Promise.all([
    readAll(proc.stdout as ReadableStream<Uint8Array>, maxBytes),
    stderrPromise,
  ]);
  clearTimeout(timer);

  let code: number | null = null;
  try {
    code = await proc.exited;
  } catch {
    code = null;
  }

  return {
    code,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated,
    timedOut,
  };
}
