import { toSdkEnv, type ResolvedProvider } from "../provider";
import type { AgentEvent, AgentRunner, RunInput, PermissionRequest } from "./events";
import { mapSdkMessage } from "./sdk-mapper";

const SDK_MODULE: string = "@anthropic-ai/claude-agent-sdk";

const SDK_NOT_INSTALLED =
  "Claude Agent SDK belum terpasang. Pasang paket @anthropic-ai/claude-agent-sdk sendiri " +
  "(lisensi Anthropic; tidak dibundel dengan Jejak) atau jalankan dengan MOCK=true.";

const PROFILE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

export interface SdkQuery extends AsyncIterable<unknown> {
  close?(): void;
}

export interface SdkModule {
  query(args: { prompt: string; options?: Record<string, unknown> }): SdkQuery;
}

export interface SdkRunnerOptions {
  load?: () => Promise<SdkModule>;
  baseEnv?: Record<string, string | undefined>;
}

async function defaultLoad(): Promise<SdkModule> {
  const imported: unknown = await import(SDK_MODULE);
  return imported as SdkModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSdkModule(value: unknown): SdkModule {
  if (!isRecord(value) || typeof value.query !== "function") {
    throw new Error("Modul SDK tidak valid: fungsi query tidak ditemukan.");
  }
  return value as unknown as SdkModule;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitize(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    return text;
  }
  return text.split(apiKey).join("***");
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

const MEMORY_TOOL_ALLOWLIST = [
  "mcp__jejak-memory__memory_search",
  "mcp__jejak-memory__memory_propose",
];

export function buildSdkEnv(
  base: Record<string, string | undefined>,
  resolved: ResolvedProvider,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of PROFILE_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...toSdkEnv(resolved) };
}

export function createSdkRunner(options: SdkRunnerOptions = {}): AgentRunner {
  const load = options.load ?? defaultLoad;
  const baseEnv = options.baseEnv ?? process.env;

  return {
    async *run(input: RunInput) {
      let sdk: SdkModule;
      try {
        sdk = requireSdkModule(await load());
      } catch {
        yield { type: "error", message: SDK_NOT_INSTALLED };
        yield { type: "result", ok: false, error: SDK_NOT_INSTALLED };
        return;
      }

      const abortController = new AbortController();
      const forwardAbort = (): void => abortController.abort();
      const signal = input.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          abortController.abort();
        } else {
          signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }

      const memory = input.memory;
      let append = `Folder kerja sesi ini adalah ${sanitizeCwd(input.cwd)}. Semua path relatif merujuk ke folder itu. Saat membaca atau mengubah berkas, pakai path relatif atau path absolut yang diawali folder tersebut; jangan menebak path lain seperti /home/... atau /Users/....`;
      if (memory !== undefined) {
        append = `${append} ${sanitizeCwd(memory.indexLine)}`;
      }

      const sdkOptions: Record<string, unknown> = {
        cwd: input.cwd,
        env: buildSdkEnv(baseEnv, input.provider),
        permissionMode: input.permissionMode ?? "default",
        abortController,
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append,
        },
      };
      if (memory !== undefined && memory.url !== undefined && memory.token !== undefined) {
        sdkOptions.mcpServers = {
          "jejak-memory": {
            type: "http",
            url: memory.url,
            headers: { Authorization: `Bearer ${memory.token}` },
          },
        };
        sdkOptions.allowedTools = [...MEMORY_TOOL_ALLOWLIST];
      }
      if (input.provider.model !== undefined) {
        sdkOptions.model = input.provider.model;
      }
      if (input.resumeSessionId !== undefined) {
        sdkOptions.resume = input.resumeSessionId;
      }

      // Add canUseTool handler if requestPermission is provided
      const requestPermission = input.requestPermission;
      if (requestPermission !== undefined) {
        sdkOptions.canUseTool = async (
          toolName: string,
          toolInput: unknown,
          ctx: { signal?: AbortSignal; toolUseID?: string } | undefined,
        ): Promise<
          { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }
        > => {
          const request: PermissionRequest = {
            toolUseId: ctx?.toolUseID,
            name: toolName,
            input: toolInput,
          };

          try {
            const decision = await requestPermission(request, ctx?.signal ?? abortController.signal);

            if (decision.behavior === "allow") {
              return { behavior: "allow", updatedInput: toolInput };
            } else {
              return { behavior: "deny", message: decision.message };
            }
          } catch {
            return { behavior: "deny", message: "izin gagal diproses" };
          }
        };
      }

      let query: SdkQuery | undefined;
      let sawResult = false;
      try {
        query = sdk.query({ prompt: input.prompt, options: sdkOptions });
        for await (const message of query) {
          for (const event of mapSdkMessage(message)) {
            if (event.type === "result") sawResult = true;
            yield event;
          }
        }

        if (!sawResult) {
          if (abortController.signal.aborted) {
            yield { type: "result", ok: false, error: "dibatalkan" };
          } else {
            yield { type: "result", ok: false, error: "sesi berakhir tanpa hasil" };
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          yield { type: "error", message: "dibatalkan" };
          if (!sawResult) yield { type: "result", ok: false, error: "dibatalkan" };
          return;
        }
        let message = sanitize(errorMessage(error), input.provider.apiKey);
        if (input.memory?.token !== undefined && input.memory.token !== "") {
          message = message.split(input.memory.token).join("***");
        }
        yield { type: "error", message };
        if (!sawResult) yield { type: "result", ok: false, error: message };
      } finally {
        if (signal !== undefined) {
          signal.removeEventListener("abort", forwardAbort);
        }
        try {
          query?.close?.();
        } catch {
          // close milik SDK tidak boleh menggagalkan run.
        }
      }
    },
  };
}
