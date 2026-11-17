import { expect, test } from "bun:test";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import { createSdkRunner, filterCommandEnv, type SdkModule, type SdkQuery } from "../src/server/agent/sdk-runner";
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
  env: { DB_PASSWORD: "rahasia-panjang", DB_HOST: "localhost" },
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

test("tanpa commandEnv tidak ada hook PostToolUse dan PreToolUse tak menyentuh Bash", async () => {
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

test("opsi env SDK memuat env perintah", async () => {
  const options = await runWith({ commandEnv: COMMAND_ENV });
  const env = options?.env as Record<string, string | undefined>;
  expect(env.DB_PASSWORD).toBe("rahasia-panjang");
  expect(env.DB_HOST).toBe("localhost");
});

test("PreToolUse tidak lagi mengembalikan updatedInput", async () => {
  const options = await runWith({
    commandEnv: COMMAND_ENV,
    secretGuard: () => undefined,
  });
  const pre = hookOf(options, "PreToolUse");
  expect(
    await pre({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "psql -c 'select 1'", description: "cek" },
    }),
  ).toEqual({});
});

test("env perintah tidak menimpa nama terlarang", async () => {
  const options = await runWith({
    commandEnv: {
      ...COMMAND_ENV,
      env: {
        DB_PASSWORD: "rahasia-panjang",
        PATH: "/tmp/jahat",
        LD_PRELOAD: "/tmp/jahat.so",
        anthropic_api_key: "kunci-palsu",
        BASH_ENV: "/tmp/jahat.sh",
      },
    },
  });
  const env = options?.env as Record<string, string | undefined>;
  expect(env.DB_PASSWORD).toBe("rahasia-panjang");
  expect(env.PATH).not.toBe("/tmp/jahat");
  expect(env.LD_PRELOAD).toBeUndefined();
  expect(env.anthropic_api_key).toBeUndefined();
  expect(env.BASH_ENV).toBeUndefined();
});

test("guard menolak tanpa updatedInput", async () => {
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

test("filterCommandEnv membuang nama terlarang, meloloskan yang aman", () => {
  expect(
    filterCommandEnv({
      PATH: "/tmp/x",
      LD_PRELOAD: "/tmp/x.so",
      anthropic_api_key: "x",
      BASH_ENV: "/tmp/x.sh",
      DYLD_INSERT_LIBRARIES: "x",
      JEJAK_HOME: "/tmp/x",
      DB_PASSWORD: "rahasia",
    }),
  ).toEqual({ DB_PASSWORD: "rahasia" });
  expect(filterCommandEnv(undefined)).toEqual({});
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
