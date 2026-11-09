import { expect, test } from "bun:test";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import { createSdkRunner, type SdkModule, type SdkQuery } from "../src/server/agent/sdk-runner";
import type { ResolvedProvider } from "../src/server/provider";

const PROVIDER: ResolvedProvider = {
  profileId: "proxy",
  baseUrl: "https://proxy.test/v1",
  apiKey: "sk-uji",
  model: "model-uji",
};

function baseInput(overrides: Partial<RunInput> = {}): RunInput {
  return { prompt: "halo", cwd: "/tmp/kerja", provider: PROVIDER, ...overrides };
}

const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "selesai",
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function runWith(
  input: Partial<RunInput>,
): Promise<Record<string, unknown> | undefined> {
  let received: Record<string, unknown> | undefined;
  const module: SdkModule = {
    query(args) {
      received = args.options;
      const query: SdkQuery = {
        async *[Symbol.asyncIterator]() {
          yield RESULT_OK;
        },
      };
      return query;
    },
  };
  const events: AgentEvent[] = [];
  for await (const event of createSdkRunner({ load: async () => module, baseEnv: {} }).run(
    baseInput(input),
  )) {
    events.push(event);
  }
  return received;
}

type HookInput = Record<string, unknown>;
type HookFn = (input: HookInput) => Promise<unknown>;

function hookOf(options: Record<string, unknown> | undefined): HookFn {
  const hooks = options?.hooks as
    | { PreToolUse?: Array<{ hooks?: unknown[] }> }
    | undefined;
  const first = hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (typeof first !== "function") throw new Error("hook PreToolUse tidak terpasang");
  return first as HookFn;
}

test("hooks PreToolUse hanya terpasang bila secretGuard ada", async () => {
  const tanpa = await runWith({});
  expect(tanpa?.hooks).toBeUndefined();

  const dengan = await runWith({ secretGuard: () => undefined });
  expect(Array.isArray((dengan?.hooks as { PreToolUse?: unknown[] }).PreToolUse)).toBe(true);
});

test("hook menolak dengan bentuk keluaran yang benar", async () => {
  const options = await runWith({
    secretGuard: () => ({ reason: "ditolak kebijakan", rule: ".env" }),
  });
  const hook = hookOf(options);

  const verdict = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: ".env" },
  });
  expect(verdict).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "ditolak kebijakan",
    },
  });
});

test("hook mengembalikan {} bila guard undefined, melempar, atau event lain", async () => {
  const passthrough = await runWith({ secretGuard: () => undefined });
  expect(
    await hookOf(passthrough)({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
    }),
  ).toEqual({});

  const throwing = await runWith({
    secretGuard: () => {
      throw new Error("rusak");
    },
  });
  expect(
    await hookOf(throwing)({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: ".env" },
    }),
  ).toEqual({});

  const other = await runWith({ secretGuard: () => ({ reason: "x" }) });
  expect(
    await hookOf(other)({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: ".env" },
    }),
  ).toEqual({});
});

test("agent_id diteruskan sebagai agentId", async () => {
  const calls: Array<{ toolName: string; toolInput: unknown; agentId?: string }> = [];
  const options = await runWith({
    secretGuard: (call) => {
      calls.push(call);
      return undefined;
    },
  });
  const hook = hookOf(options);

  await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "a.ts" },
    agent_id: "sub-1",
  });
  await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Grep",
    tool_input: { pattern: "x" },
  });

  expect(calls).toEqual([
    { toolName: "Read", toolInput: { file_path: "a.ts" }, agentId: "sub-1" },
    { toolName: "Grep", toolInput: { pattern: "x" }, agentId: undefined },
  ]);
});
