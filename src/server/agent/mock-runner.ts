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
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
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

const MEMORY_SEARCH_TOOL = "mcp__jejak-memory__memory_search";
const MEMORY_PROPOSE_TOOL = "mcp__jejak-memory__memory_propose";
const WORKSPACE_OVERVIEW_TOOL = "mcp__jejak-memory__workspace_overview";
const WORKSPACE_SERVICE_TOOL = "mcp__jejak-memory__workspace_service";

function markerText(prompt: string, marker: string): string | undefined {
  const index = prompt.indexOf(marker);
  if (index === -1) return undefined;
  const rest = prompt.slice(index + marker.length).trim();
  return rest === "" ? undefined : rest;
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

      if (input.workspace !== undefined) {
        yield {
          type: "text",
          text: `Workspace ${input.workspace.name}: ${input.workspace.repos.length} repo.`,
        };
      }

      if (input.requestPermission !== undefined && input.prompt.includes("[tanya]")) {
        let reply = "Pertanyaan dilewati.";
        try {
          const decision = await input.requestPermission(
            {
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Mau lanjut ke bagian mana?",
                    header: "Fokus",
                    multiSelect: false,
                    options: [
                      { label: "Push", description: "Siapkan remote lalu push." },
                      { label: "Rilis 3", description: "Baca roadmap dan usulkan irisan." },
                    ],
                  },
                  {
                    question: "Fokus pengujian?",
                    header: "Tes",
                    multiSelect: true,
                    options: [
                      { label: "Unit", description: "Tes kecil per modul." },
                      { label: "Load", description: "Uji beban dan latensi." },
                    ],
                  },
                ],
              },
            },
            signal ?? new AbortController().signal,
          );
          const updated = decision.behavior === "allow" ? decision.updatedInput : undefined;
          const answers =
            typeof updated === "object" && updated !== null
              ? (updated as { answers?: unknown }).answers
              : undefined;
          if (answers !== undefined) reply = `Jawaban: ${JSON.stringify(answers)}`;
        } catch {
          // dibatalkan
        }
        yield { type: "text", text: reply };
        yield { type: "result", ok: true };
        return;
      }

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

      const memory = input.memory;
      if (memory !== undefined && input.prompt.includes("[memori]")) {
        const query = markerText(input.prompt, "[memori]") ?? "memori";
        const id = `memory-search-${crypto.randomUUID()}`;
        yield { type: "tool_call", id, name: MEMORY_SEARCH_TOOL, input: { query } };
        let outcome: { text: string; isError: boolean };
        try {
          outcome = await memory.call("memory_search", { query });
        } catch {
          outcome = { text: "Pencarian memory gagal.", isError: true };
        }
        yield { type: "tool_result", id, output: outcome.text, isError: outcome.isError };
        yield { type: "result", ok: true, summary: "Pencarian memory selesai." };
        return;
      }

      if (memory !== undefined && input.prompt.includes("[usul]")) {
        const id = `memory-propose-${crypto.randomUUID()}`;
        const args = {
          layer: "profile",
          title: "Usulan demo",
          body: "Pengguna suka jawaban singkat.",
        };
        yield { type: "tool_call", id, name: MEMORY_PROPOSE_TOOL, input: args };
        let outcome: { text: string; isError: boolean };
        try {
          outcome = await memory.call("memory_propose", args);
        } catch {
          outcome = { text: "Usulan gagal dicatat.", isError: true };
        }
        yield { type: "tool_result", id, output: outcome.text, isError: outcome.isError };
        yield { type: "result", ok: true, summary: "Usulan memory dicatat." };
        return;
      }

      if (memory !== undefined && input.prompt.includes("[ws]")) {
        const overviewId = `workspace-overview-${crypto.randomUUID()}`;
        yield { type: "tool_call", id: overviewId, name: WORKSPACE_OVERVIEW_TOOL, input: {} };
        let overview: { text: string; isError: boolean };
        try {
          overview = await memory.call("workspace_overview", {});
        } catch {
          overview = { text: "Data workspace gagal dibaca.", isError: true };
        }
        yield {
          type: "tool_result",
          id: overviewId,
          output: overview.text,
          isError: overview.isError,
        };

        const firstRepo = input.workspace?.repos[0];
        if (input.workspace !== undefined && firstRepo !== undefined) {
          const serviceId = `workspace-service-${crypto.randomUUID()}`;
          const args = { name: firstRepo.name };
          yield { type: "tool_call", id: serviceId, name: WORKSPACE_SERVICE_TOOL, input: args };
          let service: { text: string; isError: boolean };
          try {
            service = await memory.call("workspace_service", args);
          } catch {
            service = { text: "Kartu service gagal dibaca.", isError: true };
          }
          yield {
            type: "tool_result",
            id: serviceId,
            output: service.text,
            isError: service.isError,
          };
        }

        yield { type: "result", ok: true, summary: "Data workspace dibaca." };
        return;
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
