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
  | { type: "error"; message: string }
  | {
      type: "permission_request";
      id: string;
      toolUseId?: string;
      name: string;
      input: unknown;
      /** Batas waktu keputusan (ISO); setelah itu izin ditolak otomatis. */
      expiresAt?: string;
    }
  | { type: "permission_resolved"; id: string; decision: "allow" | "deny"; message?: string };

export interface PermissionRequest { toolUseId?: string; name: string; input: unknown }
export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
export type PermissionHandler = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;

export interface RunInput {
  prompt: string;
  cwd: string;
  provider: ResolvedProvider;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  requestPermission?: PermissionHandler;
}

export interface AgentRunner {
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
