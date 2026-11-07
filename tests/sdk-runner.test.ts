import { expect, test } from "bun:test";
import { createRunner } from "../src/server/agent";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import {
  buildSdkEnv,
  createSdkRunner,
  type SdkModule,
  type SdkQuery,
} from "../src/server/agent/sdk-runner";
import type { ResolvedProvider } from "../src/server/provider";

const API_KEY = "sk-rahasia-palsu";

const PROVIDER: ResolvedProvider = {
  profileId: "proxy",
  baseUrl: "https://proxy.test/v1",
  apiKey: API_KEY,
  model: "model-profil",
  lightModel: "model-ringan",
};

function baseInput(overrides: Partial<RunInput> = {}): RunInput {
  return { prompt: "halo", cwd: "/tmp/kerja", provider: PROVIDER, ...overrides };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

interface FakeQueryOptions {
  messages: unknown[];
  throwAfter?: number;
  error?: Error;
  onOptions?: (options: Record<string, unknown> | undefined) => void;
}

interface FakeHandle {
  module: SdkModule;
  closed: () => boolean;
}

function fakeSdk(options: FakeQueryOptions): FakeHandle {
  let closed = false;
  const module: SdkModule = {
    query(args) {
      options.onOptions?.(args.options);
      const query: SdkQuery = {
        close() {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < options.messages.length; index += 1) {
            if (options.throwAfter === index) {
              throw options.error ?? new Error("kegagalan SDK");
            }
            yield options.messages[index];
          }
          if (options.throwAfter === options.messages.length) {
            throw options.error ?? new Error("kegagalan SDK");
          }
        },
      };
      return query;
    },
  };
  return { module, closed: () => closed };
}

const INIT = { type: "system", subtype: "init", session_id: "s-1", model: "model-profil" };
const TOOL_USE = {
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.ts" } }],
  },
};
const TOOL_RESULT = {
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: "tu-1", content: "isi", is_error: false }],
  },
};
const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "selesai",
  total_cost_usd: 0.01,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
};

test("runner SDK memetakan pesan menjadi event berurutan", async () => {
  const sdk = fakeSdk({ messages: [INIT, TOOL_USE, TOOL_RESULT, RESULT_OK] });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()),
  );

  expect(events).toEqual([
    { type: "session", sessionId: "s-1", model: "model-profil" },
    { type: "tool_call", id: "tu-1", name: "Read", input: { file_path: "a.ts" } },
    { type: "tool_result", id: "tu-1", output: "isi", isError: false },
    {
      type: "result",
      ok: true,
      summary: "selesai",
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 5,
      numTurns: 1,
    },
  ]);
});

test("options query memuat cwd, model, permissionMode, settingSources, dan env profil", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({
      load: async () => sdk.module,
      baseEnv: {
        ANTHROPIC_AUTH_TOKEN: "token-langganan",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-langganan",
        ANTHROPIC_API_KEY: "key-lama",
        PATH: "/usr/bin",
      },
    }).run(baseInput()),
  );

  expect(received?.cwd).toBe("/tmp/kerja");
  expect(received?.model).toBe("model-profil");
  expect(received?.permissionMode).toBe("default");
  expect(received?.settingSources).toEqual(["project"]);

  const env = received?.env as Record<string, string | undefined>;
  expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
  expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.test/v1");
  expect(env.ANTHROPIC_MODEL).toBe("model-profil");
  expect(env.PATH).toBe("/usr/bin");
  expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
  expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
});

test("permissionMode dari input diteruskan dan model dihilangkan bila tidak ada", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ provider: { profileId: "tanpa-model" }, permissionMode: "plan" }),
    ),
  );

  expect(received?.permissionMode).toBe("plan");
  expect("model" in (received ?? {})).toBe(false);
});

test("buildSdkEnv membuang env profil lain tanpa memutasi base", () => {
  const base = {
    ANTHROPIC_API_KEY: "lama",
    ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_BASE_URL: "https://lama.test",
    ANTHROPIC_MODEL: "lama",
    ANTHROPIC_SMALL_FAST_MODEL: "lama-ringan",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    HOME: "/home/u",
  };

  const env = buildSdkEnv(base, PROVIDER);

  expect(env).toEqual({
    HOME: "/home/u",
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_BASE_URL: "https://proxy.test/v1",
    ANTHROPIC_MODEL: "model-profil",
    ANTHROPIC_SMALL_FAST_MODEL: "model-ringan",
  });
  expect(base.ANTHROPIC_API_KEY).toBe("lama");
  expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
});

test("modul SDK tidak terpasang menghasilkan error dan satu result gagal", async () => {
  const events = await collect(
    createSdkRunner({
      load: async () => {
        throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
      },
    }).run(baseInput()),
  );

  expect(events).toHaveLength(2);
  const error = events[0]!;
  expect(error.type).toBe("error");
  if (error.type === "error") {
    expect(error.message).toContain("belum terpasang");
  }
  expect(events[1]).toEqual({
    type: "result",
    ok: false,
    error: expect.stringContaining("belum terpasang") as unknown as string,
  });
});

test("exception di tengah iterasi menyamarkan apiKey", async () => {
  const sdk = fakeSdk({
    messages: [INIT],
    throwAfter: 1,
    error: new Error(`gagal memanggil API dengan key ${API_KEY}`),
  });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()),
  );

  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).toContain("***");

  const error = events[1]!;
  expect(error.type).toBe("error");
  if (error.type === "error") {
    expect(error.message).toContain("***");
  }
  const result = events[events.length - 1]!;
  expect(result.type).toBe("result");
  if (result.type === "result") {
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(API_KEY);
  }
});

test("abort lewat signal menghasilkan tepat satu result dibatalkan dan memanggil close", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({
    messages: [INIT],
    onOptions: (options) => (received = options),
  });

  const controller = new AbortController();
  controller.abort();

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ signal: controller.signal }),
    ),
  );

  const abortController = received?.abortController as AbortController;
  expect(abortController.signal.aborted).toBe(true);

  const results = events.filter((event) => event.type === "result");
  expect(results).toHaveLength(1);
  expect(results[0]).toEqual({ type: "result", ok: false, error: "dibatalkan" });
  expect(sdk.closed()).toBe(true);
});

test("close selalu dipanggil meski iterasi melempar", async () => {
  const sdk = fakeSdk({ messages: [], throwAfter: 0, error: new Error("meledak") });

  await collect(createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()));

  expect(sdk.closed()).toBe(true);
});

test("close yang melempar tidak menggagalkan run", async () => {
  let closed = false;
  const module: SdkModule = {
    query() {
      const query: SdkQuery = {
        close() {
          closed = true;
          throw new Error("close rusak");
        },
        async *[Symbol.asyncIterator]() {
          yield RESULT_OK;
        },
      };
      return query;
    },
  };

  const events = await collect(
    createSdkRunner({ load: async () => module, baseEnv: {} }).run(baseInput()),
  );

  expect(closed).toBe(true);
  expect(events.map((event) => event.type)).toEqual(["result"]);
});

test("hasil yang belum keluar saat stream selesai diberi result gagal", async () => {
  const sdk = fakeSdk({ messages: [INIT] });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()),
  );

  expect(events[events.length - 1]).toEqual({
    type: "result",
    ok: false,
    error: "sesi berakhir tanpa hasil",
  });
});

test("createRunner memakai mock saat MOCK=true dan SDK saat tidak", async () => {
  const mockRunner = createRunner({ MOCK: "TRUE " });
  const mockEvents = await collect(mockRunner.run(baseInput()));
  expect(mockEvents[0]?.type).toBe("session");
  expect(mockEvents[mockEvents.length - 1]?.type).toBe("result");

  const sdkRunner = createRunner({});
  expect(typeof sdkRunner.run).toBe("function");
  expect(sdkRunner).not.toBe(mockRunner);
});
