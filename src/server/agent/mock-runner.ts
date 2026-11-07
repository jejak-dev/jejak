import type { AgentEvent, AgentRunner } from "./events";

const DEFAULT_SCRIPT: AgentEvent[] = [
  { type: "session", sessionId: "mock-session", model: "mock-model" },
  { type: "thinking", text: "Saya perlu melihat isi berkas terlebih dahulu." },
  { type: "text", text: "Saya akan membaca berkas README.md untuk memahami proyek ini." },
  { type: "tool_call", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
  { type: "tool_result", id: "tool-1", output: "# Jejak\n\nWorkbench agent coding.", isError: false },
  { type: "text", text: "Berkas berhasil dibaca. Ringkasannya: Jejak adalah workbench agent coding." },
  {
    type: "result",
    ok: true,
    summary: "Demo mock selesai.",
    costUsd: 0,
    inputTokens: 12,
    outputTokens: 24,
    numTurns: 1,
  },
];

export interface MockRunnerOptions {
  script?: AgentEvent[];
  delayMs?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createMockRunner(options: MockRunnerOptions = {}): AgentRunner {
  const delayMs = options.delayMs ?? 0;
  const provided = options.script;
  const script =
    provided === undefined
      ? DEFAULT_SCRIPT
      : provided.some((event) => event.type === "result")
        ? provided
        : [...provided, { type: "result", ok: true } satisfies AgentEvent];

  return {
    async *run(input) {
      const signal = input.signal;
      let hasResult = false;

      if (input.requestPermission !== undefined && input.prompt.includes("[izin]")) {
        let allowed = false;
        try {
          const decision = await input.requestPermission(
            { name: "Write", input: { file_path: "contoh.txt", content: "halo" } },
            signal ?? new AbortController().signal,
          );
          allowed = decision.behavior === "allow";
        } catch {
          allowed = false;
        }
        if (!allowed) {
          yield { type: "text", text: "Izin ditolak, aksi dibatalkan." };
          yield { type: "result", ok: true };
          return;
        }
      }

      // Normal mock behavior without [izin]
      for (let index = 0; index < script.length; index += 1) {
        if (signal?.aborted) {
          if (!hasResult) {
            yield { type: "error", message: "dibatalkan" };
            yield { type: "result", ok: false, error: "dibatalkan" };
          }
          return;
        }
        if (index > 0) {
          await wait(delayMs, signal);
          if (signal?.aborted) {
            if (!hasResult) {
              yield { type: "error", message: "dibatalkan" };
              yield { type: "result", ok: false, error: "dibatalkan" };
            }
            return;
          }
        }
        const event = script[index]!;
        if (event.type === "result") hasResult = true;
        yield event;
      }
    },
  };
}
