import type { AgentEvent } from "../../server/agent/events";

export type ToolStatus = "berjalan" | "selesai" | "gagal";

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
  | { kind: "error"; message: string }
  | {
      kind: "result";
      ok: boolean;
      summary?: string;
      error?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
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

    case "error":
      return [...items, { kind: "error", message: event.message }];

    case "result": {
      const result: TimelineItem = { kind: "result", ok: event.ok };
      if (event.summary !== undefined) result.summary = event.summary;
      if (event.error !== undefined) result.error = event.error;
      if (event.costUsd !== undefined) result.costUsd = event.costUsd;
      if (event.inputTokens !== undefined) result.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) result.outputTokens = event.outputTokens;
      if (event.numTurns !== undefined) result.numTurns = event.numTurns;

      const closed = markRunningToolsFailed([...items]);
      const index = closed.findIndex((item) => item.kind === "result");
      if (index === -1) {
        return [...closed, result];
      }
      return closed.map((item, position) => (position === index ? result : item));
    }

    default:
      return [...items];
  }
}
