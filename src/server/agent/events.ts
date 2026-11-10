import type { ResolvedProvider } from "../provider";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type AgentEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text"; text: string; parentToolUseId?: string }
  | { type: "thinking"; text: string; parentToolUseId?: string }
  /** Potongan teks yang sedang mengalir; transien (tidak disimpan), digantikan event `text` final. */
  | { type: "text_delta"; text: string; parentToolUseId?: string }
  /** Ukuran konteks (token) setelah satu panggilan model; tampil sebagai cincin penggunaan. */
  | { type: "context"; tokens: number }
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
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      estimatedCostUsd?: number;
      numTurns?: number;
      /** Ukuran konteks (token) pada panggilan model terakhir giliran ini. */
      contextTokens?: number;
      /** Jendela konteks model menurut SDK; perkiraan untuk model non-Claude. */
      contextWindow?: number;
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
  | {
      type: "permission_resolved";
      id: string;
      decision: "allow" | "deny";
      message?: string;
      /** Jawaban pengguna untuk AskUserQuestion (pertanyaan -> jawaban). */
      answers?: Record<string, string>;
    }
  | { type: "notice"; text: string; level?: "info" | "warn" }
  | { type: "user_message"; text: string };

export const PERMISSION_EXPIRED_MESSAGE = "waktu izin habis";
export const PERMISSION_STOPPED_MESSAGE = "sesi dihentikan";

export interface PermissionRequest { toolUseId?: string; name: string; input: unknown }
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };
export type PermissionHandler = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;

export interface RunMemory {
  url?: string;
  token?: string;
  indexLine: string;
  /** Nama tool yang tersedia untuk sesi ini (tanpa awalan `mcp__`). */
  tools?: string[];
  call(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
}

export interface RunWorkspace {
  name: string;
  repos: { name: string; path: string; kind: string }[];
  additionalDirectories: string[];
}

/** Pengaturan sumber Claude untuk satu giliran (dihitung pemanggil). */
export interface RunClaudeConfig {
  /** Muat `~/.claude` lewat `settingSources: ["project","user"]`. */
  userSettings: boolean;
  /** `false` -> `settings: { disableAllHooks: true }` (hook Jejak tetap aktif). */
  hooksEnabled: boolean;
  /** Bila terdefinisi, hanya skill ini yang diaktifkan (filter konteks SDK). */
  skills?: string[];
}

/** Server MCP eksternal yang aktif, diselesaikan per giliran dari layanan. */
export type ResolvedMcpServer =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: "http"; url: string; headers: Record<string, string> };

export interface RunInput {
  prompt: string;
  cwd: string;
  provider: ResolvedProvider;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  requestPermission?: PermissionHandler;
  resumeSessionId?: string;
  memory?: RunMemory;
  workspace?: RunWorkspace;
  /** Server MCP eksternal (nilai penuh); tidak pernah dikirim ke klien. */
  mcpServers?: ResolvedMcpServer[];
  /** Pengaturan sumber Claude; tanpa field ini perilaku lama persis. */
  claude?: RunClaudeConfig;
  /** Folder tambahan yang boleh dibaca agent tanpa kartu izin (mis. lampiran pesan). */
  extraDirectories?: string[];
  /** Opsi `sandbox` SDK (opaque); tanpa field ini perilaku lama persis. */
  sandbox?: Record<string, unknown>;
  /**
   * Batas percobaan ulang API di dalam SDK (`CLAUDE_CODE_MAX_RETRIES`). Diisi saat
   * ada profil cadangan agar fallback tidak menunggu retry SDK yang panjang.
   */
  maxRetries?: number;
  /**
   * Kebijakan penolakan akses berkas rahasia. Mengembalikan alasan bila tool harus
   * ditolak lewat hook `PreToolUse`; `undefined` berarti diteruskan.
   */
  secretGuard?: (call: {
    toolName: string;
    toolInput: unknown;
    agentId?: string;
  }) => { reason: string; rule?: string } | undefined;
}

export interface AgentRunner {
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
