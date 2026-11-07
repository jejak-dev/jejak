import { toSdkEnv, type ResolvedProvider } from "../provider";
import type { AgentEvent, AgentRunner, RunInput } from "./events";
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

      const sdkOptions: Record<string, unknown> = {
        cwd: input.cwd,
        env: buildSdkEnv(baseEnv, input.provider),
        permissionMode: input.permissionMode ?? "default",
        abortController,
        settingSources: ["project"],
      };
      if (input.provider.model !== undefined) {
        sdkOptions.model = input.provider.model;
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
        const message = sanitize(errorMessage(error), input.provider.apiKey);
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
