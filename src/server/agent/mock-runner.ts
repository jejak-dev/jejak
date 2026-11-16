import type { AgentEvent, AgentRunner, CommandInfo } from "./events";

const DEFAULT_SCRIPT: AgentEvent[] = [
  { type: "session", sessionId: "mock-session", model: "mock-model" },
  { type: "thinking", text: "Saya perlu melihat isi berkas terlebih dahulu." },
  { type: "text", text: "Saya akan membaca berkas README.md untuk memahami proyek ini." },
  { type: "tool_call", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
  { type: "tool_result", id: "tool-1", output: "# Jejak\n\nWorkbench agent coding.", isError: false },
  { type: "text", text: "Berkas berhasil dibaca. Ringkasannya: Jejak adalah workbench agent coding." },
  { type: "context", tokens: 38_000 },
  {
    type: "result",
    ok: true,
    summary: "Demo mock selesai.",
    costUsd: 0,
    inputTokens: 12,
    outputTokens: 24,
    contextTokens: 38_000,
    contextWindow: 200_000,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    numTurns: 1,
  },
];

/**
 * Daftar perintah tiruan.
 *
 * Dipakai untuk uji UI dan e2e: memuat perintah bawaan, satu skill tiruan,
 * dan satu perintah kustom tiruan.
 */
export const MOCK_COMMANDS: CommandInfo[] = [
  { name: "compact", description: "Padatkan percakapan jadi ringkas.", argumentHint: "" },
  { name: "context", description: "Tampilkan penggunaan konteks sesi.", argumentHint: "" },
  { name: "usage", description: "Tampilkan penggunaan token sesi.", argumentHint: "" },
  { name: "init", description: "Buat berkas CLAUDE.md untuk proyek.", argumentHint: "" },
  { name: "contoh-skill", description: "Skill tiruan untuk uji tampilan perintah.", argumentHint: "" },
  { name: "ping", description: "Perintah kustom tiruan.", argumentHint: "<x>" },
];

export interface MockRunnerOptions {
  script?: AgentEvent[];
  delayMs?: number;
  /** Pecah teks jadi potongan `text_delta` bertahap (untuk menguji teks mengalir). */
  streamDelta?: boolean;
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
const GOAL_UPDATE_TOOL = "mcp__jejak-memory__goal_update";
const WORKSPACE_OVERVIEW_TOOL = "mcp__jejak-memory__workspace_overview";
const WORKSPACE_SERVICE_TOOL = "mcp__jejak-memory__workspace_service";

/** Penanda mode Goal di dalam blok `<tujuan>`. */
const GOAL_OPEN = "<tujuan>";
const GOAL_CLOSE = "</tujuan>";

function markerText(prompt: string, marker: string): string | undefined {
  const index = prompt.indexOf(marker);
  if (index === -1) return undefined;
  const rest = prompt.slice(index + marker.length).trim();
  return rest === "" ? undefined : rest;
}

/** Isi blok `<tujuan>` pada prompt Goal. */
function goalObjective(prompt: string): string | undefined {
  const start = prompt.indexOf(GOAL_OPEN);
  if (start === -1) return undefined;
  const end = prompt.indexOf(GOAL_CLOSE, start + GOAL_OPEN.length);
  if (end === -1) return undefined;
  return prompt.slice(start + GOAL_OPEN.length, end).trim();
}

/** Status yang diminta penanda `[goal]`, `[goal:done]`, atau `[goal:blocked]`. */
function goalMarker(objective: string): "progress" | "done" | "blocked" | undefined {
  if (objective.includes("[goal:blocked]")) return "blocked";
  if (objective.includes("[goal:done]")) return "done";
  if (objective.includes("[goal]")) return "progress";
  return undefined;
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

  // Jangkar percakapan sintetis: uuid pesan assistant terakhir giliran ini.
  let anchorCounter = 0;
  const withAnchor = (
    event: Extract<AgentEvent, { type: "result" }>,
  ): Extract<AgentEvent, { type: "result" }> => {
    if (!event.ok || event.anchorUuid !== undefined) return event;
    anchorCounter += 1;
    return { ...event, anchorUuid: `mock-anchor-${anchorCounter}` };
  };

  return {
    async *run(input) {
      const signal = input.signal;
      if (input.prompt.trim() === "/compact") {
        yield { type: "text", text: "Percakapan dipadatkan." };
        yield withAnchor({ type: "result", ok: true, contextTokens: 4_200, contextWindow: 200_000 });
        return;
      }
      let hasResult = false;

      // Penanda [mermaid]: jawaban berisi blok diagram (uji render Mermaid).
      if (input.prompt.includes("[mermaid]")) {
        yield { type: "session", sessionId: "mock-session", model: "mock-model" };
        yield {
          type: "text",
          text: "Alur singkat:\n\n```mermaid\nflowchart LR\n  A[Pesan] --> B{Agent}\n  B --> C[Tool]\n  B --> D[Jawaban]\n```\n\nSelesai.",
        };
        yield withAnchor({ type: "result", ok: true });
        return;
      }

      // Penanda [todo]: agent mengirim daftar langkah lewat TodoWrite (uji tab Todos).
      if (input.prompt.includes("[todo]")) {
        yield { type: "session", sessionId: "mock-session", model: "mock-model" };
        yield {
          type: "tool_call",
          id: "todo-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Baca README", status: "completed", activeForm: "Membaca README" },
              { content: "Tulis tes", status: "in_progress", activeForm: "Menulis tes" },
              { content: "Rapikan dokumen", status: "pending", activeForm: "Merapikan dokumen" },
            ],
          },
        };
        yield { type: "tool_result", id: "todo-1", output: "Todos diperbarui.", isError: false };
        yield { type: "text", text: "Daftar langkah dibuat." };
        yield withAnchor({ type: "result", ok: true });
        return;
      }

      if (input.workspace !== undefined) {
        yield {
          type: "text",
          text: `Workspace ${input.workspace.name}: ${input.workspace.repos.length} repo.`,
        };
      }

      if (input.requestPermission !== undefined && input.prompt.includes("[rencana]")) {
        let reply = "Rencana ditolak.";
        try {
          const decision = await input.requestPermission(
            {
              name: "ExitPlanMode",
              input: { plan: "# Rencana\n\n1. Tulis **skema** awal\n2. Buat tes\n3. Jalankan `bun test`" },
            },
            signal ?? new AbortController().signal,
          );
          if (decision.behavior === "allow") reply = "Rencana disetujui.";
          else reply = `Rencana ditolak: ${decision.message}`;
        } catch {
          // dibatalkan
        }
        yield { type: "text", text: reply };
        yield withAnchor({ type: "result", ok: true });
        return;
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
        yield withAnchor({ type: "result", ok: true });
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
          yield withAnchor({ type: "result", ok: true });
          return;
        }
      }

      const memory = input.memory;

      // Penanda [goal]: agent melaporkan status tujuan lewat tool goal_update.
      if (memory !== undefined && input.prompt.includes(GOAL_OPEN)) {
        const objective = goalObjective(input.prompt);
        const status = objective === undefined ? undefined : goalMarker(objective);
        if (status !== undefined) {
          const id = `goal-update-${crypto.randomUUID()}`;
          const args = {
            status,
            summary: `Laporan uji mode Goal: ${status}.`,
          };
          yield { type: "tool_call", id, name: GOAL_UPDATE_TOOL, input: args };
          let outcome: { text: string; isError: boolean };
          try {
            outcome = await memory.call("goal_update", args);
          } catch {
            outcome = { text: "Laporan tujuan gagal.", isError: true };
          }
          yield { type: "tool_result", id, output: outcome.text, isError: outcome.isError };
          yield { type: "text", text: "Status tujuan dilaporkan." };
          yield withAnchor({ type: "result", ok: true, summary: "Status tujuan dilaporkan." });
          return;
        }
      }

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
        yield withAnchor({ type: "result", ok: true, summary: "Pencarian memory selesai." });
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
        yield withAnchor({ type: "result", ok: true, summary: "Usulan memory dicatat." });
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

        yield withAnchor({ type: "result", ok: true, summary: "Data workspace dibaca." });
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
        if (options.streamDelta === true && event.type === "text") {
          for (let at = 0; at < event.text.length; at += 6) {
            yield { type: "text_delta", text: event.text.slice(at, at + 6) };
            await wait(40, signal);
          }
        }
        yield event.type === "result" ? withAnchor(event) : event;
      }
    },
    async listCommands(): Promise<CommandInfo[]> {
      return MOCK_COMMANDS.map((command) => ({ ...command }));
    },
  };
}
