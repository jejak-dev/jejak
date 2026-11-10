import {
  PERMISSION_EXPIRED_MESSAGE,
  PERMISSION_STOPPED_MESSAGE,
  type AgentEvent,
} from "../../server/agent/events";

export type ToolStatus = "berjalan" | "selesai" | "gagal";

export type PermissionStatus = "menunggu" | "diizinkan" | "ditolak" | "kedaluwarsa" | "dihentikan";

export type TimelineItem =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string; depth: number }
  | { kind: "text"; text: string; depth: number; streaming?: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      summary: string;
      status: ToolStatus;
      output?: string;
      depth: number;
    }
  | {
      kind: "permission";
      id: string;
      toolUseId?: string;
      name: string;
      input: unknown;
      expiresAt?: string;
      status: PermissionStatus;
      message?: string;
      answers?: Record<string, string>;
    }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string; level: "info" | "warn" }
  | {
      kind: "result";
      ok: boolean;
      summary?: string;
      error?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      estimatedCostUsd?: number;
      numTurns?: number;
      contextTokens?: number;
      contextWindow?: number;
    };

const MAX_SUMMARY = 80;

function truncate(value: string): string {
  return value.length > MAX_SUMMARY ? `${value.slice(0, MAX_SUMMARY)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(value: string): string {
  const newline = value.search(/\r?\n/);
  return newline === -1 ? value : value.slice(0, newline);
}

export function summarizeToolInput(name: string, input: unknown): string {
  void name;
  if (!isRecord(input)) {
    return "";
  }

  for (const key of ["file_path", "path"] as const) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return truncate(value);
    }
  }

  const command = input.command;
  if (typeof command === "string" && command !== "") {
    return truncate(firstLine(command));
  }

  for (const key of ["pattern", "url"] as const) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return truncate(value);
    }
  }

  return "";
}

export function startTimeline(prompt: string): TimelineItem[] {
  return [{ kind: "user", text: prompt }];
}

function depthOf(parentToolUseId: string | undefined): number {
  return parentToolUseId === undefined ? 0 : 1;
}

/** Pesan yang dikirim server saat giliran dibatalkan pengguna. */
export const CANCELLED_MESSAGE = "dibatalkan";

/** Potongan teks yang tak sempat digantikan teks final dibiarkan apa adanya, tetapi tak lagi "mengalir". */
function settleStreaming(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === "text" && item.streaming === true) {
      const { streaming: _streaming, ...rest } = item;
      return rest;
    }
    return item;
  });
}

function markRunningToolsFailed(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) =>
    item.kind === "tool" && item.status === "berjalan" ? { ...item, status: "gagal" } : item,
  );
}

export function reduceTimeline(
  items: readonly TimelineItem[],
  event: AgentEvent,
): TimelineItem[] {
  switch (event.type) {
    case "session":
      return [...items];

    case "text_delta": {
      const depth = depthOf(event.parentToolUseId);
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "text" && last.streaming === true && last.depth === depth) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...items, { kind: "text", text: event.text, depth, streaming: true }];
    }

    case "text": {
      const depth = depthOf(event.parentToolUseId);
      const last = items[items.length - 1];
      const final: TimelineItem = { kind: "text", text: event.text, depth };
      // Teks final menggantikan potongan yang sedang mengalir.
      if (last !== undefined && last.kind === "text" && last.streaming === true) {
        return [...items.slice(0, -1), final];
      }
      return [...items, final];
    }

    case "thinking":
      return [
        ...items,
        { kind: "thinking", text: event.text, depth: depthOf(event.parentToolUseId) },
      ];

    case "tool_call":
      return [
        ...items,
        {
          kind: "tool",
          id: event.id,
          name: event.name,
          input: event.input,
          summary: summarizeToolInput(event.name, event.input),
          status: "berjalan",
          depth: depthOf(event.parentToolUseId),
        },
      ];

    case "tool_result": {
      const status: ToolStatus = event.isError ? "gagal" : "selesai";
      const index = items.findIndex(
        (item) => item.kind === "tool" && item.id === event.id && item.status === "berjalan",
      );

      if (index === -1) {
        return [
          ...items,
          {
            kind: "tool",
            id: event.id,
            name: "(tidak diketahui)",
            input: undefined,
            summary: "",
            status,
            output: event.output,
            depth: 0,
          },
        ];
      }

      return items.map((item, position) => {
        if (position !== index || item.kind !== "tool") return item;
        return { ...item, status, output: event.output };
      });
    }

    case "permission_request": {
      const item: TimelineItem = {
        kind: "permission",
        id: event.id,
        name: event.name,
        input: event.input,
        status: "menunggu",
      };
      if (event.toolUseId !== undefined) item.toolUseId = event.toolUseId;
      if (event.expiresAt !== undefined) item.expiresAt = event.expiresAt;
      return [...items, item];
    }

    case "permission_resolved": {
      const status: PermissionStatus =
        event.decision === "allow"
          ? "diizinkan"
          : event.message === PERMISSION_EXPIRED_MESSAGE
            ? "kedaluwarsa"
            : event.message === PERMISSION_STOPPED_MESSAGE
              ? "dihentikan"
              : "ditolak";
      const showMessage = status === "ditolak" && event.message !== undefined && event.message !== "";
      return items.map((item) => {
        if (item.kind !== "permission" || item.id !== event.id) return item;
        const next: TimelineItem = { ...item, status };
        if (showMessage) next.message = event.message;
        if (event.answers !== undefined) next.answers = event.answers;
        return next;
      });
    }

    case "user_message":
      return [...items, { kind: "user", text: event.text }];

    case "error":
      items = settleStreaming([...items]);
      // Penghentian oleh pengguna bukan galat: tampil sebagai catatan netral.
      if (event.message === CANCELLED_MESSAGE) {
        return [...items, { kind: "notice", text: "Sesi dihentikan.", level: "info" }];
      }
      return [...items, { kind: "error", message: event.message }];

    case "notice":
      return [
        ...items,
        { kind: "notice", text: event.text, level: event.level ?? "info" },
      ];

    case "result": {
      const result: TimelineItem = { kind: "result", ok: event.ok };
      if (event.summary !== undefined) result.summary = event.summary;
      if (event.error !== undefined) result.error = event.error;
      if (event.costUsd !== undefined) result.costUsd = event.costUsd;
      if (event.inputTokens !== undefined) result.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) result.outputTokens = event.outputTokens;
      if (event.cacheReadTokens !== undefined) result.cacheReadTokens = event.cacheReadTokens;
      if (event.cacheWriteTokens !== undefined) result.cacheWriteTokens = event.cacheWriteTokens;
      if (event.estimatedCostUsd !== undefined) result.estimatedCostUsd = event.estimatedCostUsd;
      if (event.numTurns !== undefined) result.numTurns = event.numTurns;
      if (event.contextTokens !== undefined) result.contextTokens = event.contextTokens;
      if (event.contextWindow !== undefined) result.contextWindow = event.contextWindow;

      const closed = markRunningToolsFailed(settleStreaming([...items]));
      if (closed.at(-1)?.kind === "result") {
        return [...closed.slice(0, -1), result];
      }
      return [...closed, result];
    }

    default:
      return [...items];
  }
}

/**
 * Satu aksi tool yang meminta izin muncul dua kali (baris tool dan kartu izin).
 * Sisakan satu: kartu izin saat menunggu atau ditolak, baris tool saat diizinkan.
 * Pertanyaan agent dan rencana tetap dipegang kartu izin.
 */
export function dedupeToolPermission(items: readonly TimelineItem[]): TimelineItem[] {
  const permissionByTool = new Map<string, Extract<TimelineItem, { kind: "permission" }>>();
  for (const item of items) {
    if (item.kind === "permission" && item.toolUseId !== undefined) {
      permissionByTool.set(item.toolUseId, item);
    }
  }
  if (permissionByTool.size === 0) return [...items];

  const toolIds = new Set<string>();
  for (const item of items) if (item.kind === "tool") toolIds.add(item.id);

  return items.filter((item) => {
    if (item.kind === "tool") {
      const permission = permissionByTool.get(item.id);
      if (permission === undefined) return true;
      // Pertanyaan/rencana: baris tool disembunyikan oleh Timeline sendiri.
      return permission.status === "diizinkan";
    }
    if (item.kind === "permission" && item.toolUseId !== undefined) {
      if (item.name === "AskUserQuestion" || item.name === "ExitPlanMode") return true;
      return !(item.status === "diizinkan" && toolIds.has(item.toolUseId));
    }
    return true;
  });
}
