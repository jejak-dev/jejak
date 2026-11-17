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

const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "selesai",
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const COMMAND_ENV = {
  file: "/tmp/kerja/.env",
  keys: ["DB_PASSWORD", "DB_HOST"],
  values: ["rahasia-panjang", "localhost"],
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
  for await (const event of createSdkRunner({ load: async () => module, baseEnv: {} }).run({
    prompt: "halo",
    cwd: "/tmp/kerja",
    provider: PROVIDER,
    ...input,
  })) {
    events.push(event);
  }
  return received;
}

type HookFn = (input: Record<string, unknown>) => Promise<unknown>;

function hookOf(options: Record<string, unknown> | undefined, event: string): HookFn {
  const hooks = options?.hooks as
    | Record<string, Array<{ hooks?: unknown[] }>>
    | undefined;
  const first = hooks?.[event]?.[0]?.hooks?.[0];
  if (typeof first !== "function") throw new Error(`hook ${event} tidak terpasang`);
  return first as HookFn;
}

test("tanpa commandEnv tidak ada hook PostToolUse dan Bash tak dibungkus", async () => {
  const options = await runWith({ secretGuard: () => undefined });
  const hooks = options?.hooks as Record<string, unknown> | undefined;
  expect(hooks?.PostToolUse).toBeUndefined();

  const pre = hookOf(options, "PreToolUse");
  expect(
    await pre({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }),
  ).toEqual({});
});

test("PreToolUse membungkus perintah Bash dengan berkas env", async () => {
  const options = await runWith({ commandEnv: COMMAND_ENV });
  const pre = hookOf(options, "PreToolUse");

  const verdict = (await pre({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "psql -c 'select 1'", description: "cek" },
  })) as { hookSpecificOutput: Record<string, unknown> };

  expect(verdict.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(verdict.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(verdict.hookSpecificOutput.updatedInput).toEqual({
    command:
      "set -a; . '/tmp/kerja/.env' >/dev/null 2>&1; set +a; psql -c 'select 1'",
    description: "cek",
  });
});

test("jalur berkas dengan petik di-quote aman", async () => {
  const options = await runWith({
    commandEnv: { ...COMMAND_ENV, file: "/tmp/kerja/it's/.env" },
  });
  const pre = hookOf(options, "PreToolUse");
  const verdict = (await pre({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  })) as { hookSpecificOutput: { updatedInput: { command: string } } };
  expect(verdict.hookSpecificOutput.updatedInput.command).toContain(
    ". '/tmp/kerja/it'\\''s/.env'",
  );
});

test("guard menolak: Bash tidak dibungkus", async () => {
  const options = await runWith({
    commandEnv: COMMAND_ENV,
    secretGuard: () => ({ reason: "ditolak", rule: "x" }),
  });
  const pre = hookOf(options, "PreToolUse");
  const verdict = (await pre({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  })) as { hookSpecificOutput: Record<string, unknown> };
  expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(verdict.hookSpecificOutput.updatedInput).toBeUndefined();
});

test("PostToolUse menyamarkan nilai pada string dan objek", async () => {
  const options = await runWith({ commandEnv: COMMAND_ENV });
  const post = hookOf(options, "PostToolUse");

  const asString = (await post({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
    tool_response: "DB_PASSWORD=rahasia-panjang",
  })) as { hookSpecificOutput: { updatedToolOutput: unknown } };
  expect(asString.hookSpecificOutput.updatedToolOutput).toBe(
    "DB_PASSWORD=[disembunyikan:env]",
  );

  const asObject = (await post({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
    tool_response: {
      stdout: "host=localhost",
      stderr: "gagal rahasia-panjang",
      code: 1,
    },
  })) as { hookSpecificOutput: { updatedToolOutput: Record<string, unknown> } };
  expect(asObject.hookSpecificOutput.updatedToolOutput).toEqual({
    stdout: "host=[disembunyikan:env]",
    stderr: "gagal [disembunyikan:env]",
    code: 1,
  });
});

test("PostToolUse mengembalikan {} bila tak ada nilai yang cocok", async () => {
  const options = await runWith({ commandEnv: COMMAND_ENV });
  const post = hookOf(options, "PostToolUse");
  expect(
    await post({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "a.ts", code: 0 },
    }),
  ).toEqual({});
});
