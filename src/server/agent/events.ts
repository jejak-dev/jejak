import type { ResolvedProvider } from "../provider";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type AgentEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text"; text: string; parentToolUseId?: string }
  | { type: "thinking"; text: string; parentToolUseId?: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; parentToolUseId?: string }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | {
      type: "result";
      ok: boolean;
      summary?: string;
      error?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      numTurns?: number;
    }
  | { type: "error"; message: string };

export interface RunInput {
  prompt: string;
  cwd: string;
  provider: ResolvedProvider;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
}

export interface AgentRunner {
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
