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
  | { kind: "text"; text: string; depth: number }
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
      name: string;
      input: unknown;
      expiresAt?: string;
      status: PermissionStatus;
      message?: string;
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

    case "text":
      return [
        ...items,
        { kind: "text", text: event.text, depth: depthOf(event.parentToolUseId) },
      ];

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
        return next;
      });
    }

    case "user_message":
      return [...items, { kind: "user", text: event.text }];

    case "error":
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

      const closed = markRunningToolsFailed([...items]);
      if (closed.at(-1)?.kind === "result") {
        return [...closed.slice(0, -1), result];
      }
      return [...closed, result];
    }

    default:
      return [...items];
  }
}
