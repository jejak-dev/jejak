import { expect, test } from "bun:test";
import { createRunner } from "../src/server/agent";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import {
  buildSdkEnv,
  withMaxRetries,
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

test("resumeSessionId diteruskan sebagai opsi resume ke query", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ resumeSessionId: "s-lama" }),
    ),
  );

  expect(received?.resume).toBe("s-lama");
});

test("tanpa resumeSessionId tidak ada kunci resume pada opsi query", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()));

  expect("resume" in (received ?? {})).toBe(false);
});

test("systemPrompt preset claude_code dan append berisi cwd yang diberikan", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ cwd: "/var/workspace/projek" }),
    ),
  );

  const prompt = received?.systemPrompt as Record<string, unknown> | undefined;
  expect(prompt?.type).toBe("preset");
  expect(prompt?.preset).toBe("claude_code");
  expect(typeof prompt?.append).toBe("string");
  expect(prompt?.append as string).toContain("/var/workspace/projek");
});

test("systemPrompt append tidak memuat karakter kontrol/baris baru dari cwd", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  // CWD dengan baris baru dan null byte
  const cwdKotor = `/tmp/kerja\nbaris\x00kontrol\r`;
  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ cwd: cwdKotor }),
    ),
  );

  const prompt = received?.systemPrompt as Record<string, unknown> | undefined;
  expect(prompt?.type).toBe("preset");
  expect(prompt?.preset).toBe("claude_code");
  expect(typeof prompt?.append).toBe("string");
  const append = prompt?.append as string | undefined;
  expect(append).not.toContain("\n");
  expect(append).not.toContain("\r");
  expect(append).not.toContain("\x00");
  expect(append).toContain("/tmp/kerja baris kontrol");
});

test("opsi lain tidak berubah setelah penambahan systemPrompt", async () => {  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({
      load: async () => sdk.module,
      baseEnv: { ANTHROPIC_API_KEY: "key", PATH: "/usr/bin" },
    }).run(baseInput({ cwd: "/tmp/kerja" })),
  );

  expect(received?.cwd).toBe("/tmp/kerja");
  expect(received?.permissionMode).toBe("default");
  expect(received?.settingSources).toEqual(["project"]);

  const env = received?.env as Record<string, string | undefined>;
  expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
  expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
});

const MEMORY_TOKEN = "mcp-token-rahasia-0123456789";

function memoryInput(overrides: Partial<RunInput> = {}): RunInput {
  return baseInput({
    memory: {
      url: "http://127.0.0.1:3000/mcp",
      token: MEMORY_TOKEN,
      indexLine: "Jejak menyimpan memory lintas sesi.",
      call: async () => ({ text: "", isError: false }),
    },
    ...overrides,
  });
}

test("memory dengan url menambahkan mcpServers, allowedTools, dan indexLine", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(memoryInput()),
  );

  expect(received?.mcpServers).toEqual({
    "jejak-memory": {
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: `Bearer ${MEMORY_TOKEN}` },
      alwaysLoad: true,
    },
  });
  expect(received?.allowedTools).toEqual([
    "mcp__jejak-memory__memory_search",
    "mcp__jejak-memory__memory_propose",
  ]);

  const prompt = received?.systemPrompt as Record<string, unknown> | undefined;
  const append = prompt?.append as string;
  expect(append).toContain("/tmp/kerja");
  expect(append).toContain("Jejak menyimpan memory lintas sesi.");
  expect(append.indexOf("Jejak menyimpan memory")).toBeGreaterThan(append.indexOf("/tmp/kerja"));
});

test("memory tanpa url tetap menambah indexLine tanpa mcpServers", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({
        memory: {
          indexLine: "Indeks memory khusus.",
          call: async () => ({ text: "", isError: false }),
        },
      }),
    ),
  );

  expect("mcpServers" in (received ?? {})).toBe(false);
  expect("allowedTools" in (received ?? {})).toBe(false);
  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).toContain("Indeks memory khusus.");
});

test("tanpa memory tidak ada mcpServers, allowedTools, atau indexLine", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()));

  expect("mcpServers" in (received ?? {})).toBe(false);
  expect("allowedTools" in (received ?? {})).toBe(false);
  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).not.toContain("memory_search");
});

test("indexLine dibersihkan dari karakter kontrol", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({
        memory: {
          indexLine: "baris\nsatu\x00dua",
          call: async () => ({ text: "", isError: false }),
        },
      }),
    ),
  );

  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).not.toContain("\n");
  expect(append).not.toContain("\x00");
  expect(append).toContain("baris satu dua");
});

test("token memory tidak muncul di event atau pesan galat", async () => {
  const sdk = fakeSdk({
    messages: [INIT],
    throwAfter: 1,
    error: new Error(`gagal menghubungi ${MEMORY_TOKEN}`),
  });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(memoryInput()),
  );

  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(MEMORY_TOKEN);
  const error = events.find((event) => event.type === "error");
  expect(error?.type).toBe("error");
  if (error?.type === "error") {
    expect(error.message).toContain("***");
  }
});

test("workspace menambahkan additionalDirectories dan satu kalimat di systemPrompt", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({
        cwd: "/tmp/kantor/api",
        workspace: {
          name: "Kantor",
          repos: [
            { name: "api", path: "/tmp/kantor/api", kind: "backend" },
            { name: "web", path: "/tmp/kantor/web", kind: "frontend" },
          ],
          additionalDirectories: ["/tmp/kantor/web"],
        },
      }),
    ),
  );

  expect(received?.additionalDirectories).toEqual(["/tmp/kantor/web"]);
  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).toContain('workspace "Kantor"');
  expect(append).toContain("api (backend) di /tmp/kantor/api");
  expect(append).toContain("web (frontend) di /tmp/kantor/web");
  expect(append).toContain("Kartu service tidak disertakan di sini.");
});

test("workspace kosong tidak menambah additionalDirectories", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({
        workspace: { name: "Solo", repos: [], additionalDirectories: [] },
      }),
    ),
  );

  expect("additionalDirectories" in (received ?? {})).toBe(false);
  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).toContain('workspace "Solo"');
});

test("nama workspace/repo dengan karakter kontrol disanitasi di append", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({
        workspace: {
          name: "Kantor\nBaru",
          repos: [{ name: "api\rx", path: "/tmp/api\x00", kind: "back\nend" }],
          additionalDirectories: [],
        },
      }),
    ),
  );

  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).not.toContain("\n");
  expect(append).not.toContain("\r");
  expect(append).not.toContain("\x00");
  expect(append).toContain("Kantor Baru");
  expect(append).toContain("api x");
});

test("tanpa workspace opsi SDK tidak berubah dan append tanpa kalimat workspace", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(baseInput()),
  );

  expect("additionalDirectories" in (received ?? {})).toBe(false);
  const append = (received?.systemPrompt as Record<string, unknown> | undefined)?.append as string;
  expect(append).not.toContain("workspace");
  expect(append).not.toContain("Kartu service");
});

function workspaceInput(overrides: Partial<RunInput> = {}): RunInput {
  return memoryInput({
    workspace: {
      name: "Kantor",
      repos: [
        { name: "api", path: "/tmp/kantor/api", kind: "backend" },
        { name: "web", path: "/tmp/kantor/web", kind: "frontend" },
      ],
      additionalDirectories: ["/tmp/kantor/web"],
    },
    ...overrides,
  });
}

test("allowedTools berisi tool workspace hanya bila input.workspace ada", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(workspaceInput()),
  );

  expect(received?.allowedTools).toEqual([
    "mcp__jejak-memory__memory_search",
    "mcp__jejak-memory__memory_propose",
    "mcp__jejak-memory__workspace_overview",
    "mcp__jejak-memory__workspace_service",
  ]);
  expect(received?.mcpServers).toEqual({
    "jejak-memory": {
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: `Bearer ${MEMORY_TOKEN}` },
      alwaysLoad: true,
    },
  });
});

test("RunMemory.tools dipakai apa adanya dan tool workspace diabaikan tanpa input.workspace", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({
        memory: {
          url: "http://127.0.0.1:3000/mcp",
          token: MEMORY_TOKEN,
          indexLine: "Indeks.",
          tools: ["memory_search", "memory_propose", "workspace_overview"],
          call: async () => ({ text: "", isError: false }),
        },
      }),
    ),
  );

  expect(received?.allowedTools).toEqual([
    "mcp__jejak-memory__memory_search",
    "mcp__jejak-memory__memory_propose",
  ]);

  let withWorkspace: Record<string, unknown> | undefined;
  const sdkWs = fakeSdk({
    messages: [RESULT_OK],
    onOptions: (options) => (withWorkspace = options),
  });
  await collect(
    createSdkRunner({ load: async () => sdkWs.module, baseEnv: {} }).run(
      workspaceInput({
        memory: {
          url: "http://127.0.0.1:3000/mcp",
          token: MEMORY_TOKEN,
          indexLine: "Indeks.",
          tools: ["memory_search", "workspace_overview", "workspace_service"],
          call: async () => ({ text: "", isError: false }),
        },
      }),
    ),
  );

  expect(withWorkspace?.allowedTools).toEqual([
    "mcp__jejak-memory__memory_search",
    "mcp__jejak-memory__workspace_overview",
    "mcp__jejak-memory__workspace_service",
  ]);
});

test("daftar tool kosong tidak memasang mcpServers maupun allowedTools", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({
        memory: {
          url: "http://127.0.0.1:3000/mcp",
          token: MEMORY_TOKEN,
          indexLine: "Indeks.",
          tools: [],
          call: async () => ({ text: "", isError: false }),
        },
      }),
    ),
  );

  expect("mcpServers" in (received ?? {})).toBe(false);
  expect("allowedTools" in (received ?? {})).toBe(false);
});

test("token tidak bocor saat workspace aktif", async () => {
  const sdk = fakeSdk({
    messages: [INIT],
    throwAfter: 1,
    error: new Error(`gagal menghubungi ${MEMORY_TOKEN} di /tmp/kantor/api`),
  });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(workspaceInput()),
  );

  expect(JSON.stringify(events)).not.toContain(MEMORY_TOKEN);
  const error = events.find((event) => event.type === "error");
  expect(error?.type).toBe("error");
  if (error?.type === "error") {
    expect(error.message).toContain("***");
  }
});

test("bypassPermissions menyetel allowDangerouslySkipPermissions dan tetap memasang canUseTool", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({
        permissionMode: "bypassPermissions",
        requestPermission: async () => ({ behavior: "allow" }),
      }),
    ),
  );

  expect(received?.permissionMode).toBe("bypassPermissions");
  expect(received?.allowDangerouslySkipPermissions).toBe(true);
  expect(typeof received?.canUseTool).toBe("function");
});

test("mode lain tidak menyetel allowDangerouslySkipPermissions", async () => {
  const modes = ["default", "acceptEdits", "plan"] as const;
  for (const mode of modes) {
    let received: Record<string, unknown> | undefined;
    const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

    await collect(
      createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
        baseInput({ permissionMode: mode }),
      ),
    );

    expect(received?.permissionMode).toBe(mode);
    expect(received !== undefined && "allowDangerouslySkipPermissions" in received).toBe(false);
  }
});

const STDIO_SECRET = "nilai-env-rahasia-server";
const HTTP_SECRET = "nilai-header-rahasia-server";

type ExternalServer = NonNullable<RunInput["mcpServers"]>[number];

function externalStdio(): ExternalServer {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { GITHUB_TOKEN: STDIO_SECRET },
  };
}

function externalHttp(): ExternalServer {
  return {
    name: "remote",
    transport: "http",
    url: "https://mcp.test/sse",
    headers: { Authorization: `Bearer ${HTTP_SECRET}` },
  };
}

test("server MCP eksternal digabung dengan jejak-memory tanpa menambah allowedTools", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({ mcpServers: [externalStdio(), externalHttp()] }),
    ),
  );

  expect(received?.mcpServers).toEqual({
    "jejak-memory": {
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: `Bearer ${MEMORY_TOKEN}` },
      alwaysLoad: true,
    },
    "ext-github": {
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: STDIO_SECRET },
      alwaysLoad: true,
    },
    "ext-remote": {
      type: "http",
      url: "https://mcp.test/sse",
      headers: { Authorization: `Bearer ${HTTP_SECRET}` },
      alwaysLoad: true,
    },
  });
  expect(received?.allowedTools).toEqual([
    "mcp__jejak-memory__memory_search",
    "mcp__jejak-memory__memory_propose",
  ]);
});

test("tanpa memory, mcpServers hanya berisi server eksternal dan tanpa allowedTools", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ mcpServers: [externalStdio()] }),
    ),
  );

  expect(received?.mcpServers).toEqual({
    "ext-github": {
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: STDIO_SECRET },
      alwaysLoad: true,
    },
  });
  expect("allowedTools" in (received ?? {})).toBe(false);
  expect(JSON.stringify(received?.allowedTools ?? null)).not.toContain("github");
});

test("tanpa server eksternal opsi persis seperti sebelumnya", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({ mcpServers: [] }),
    ),
  );

  expect(received?.mcpServers).toEqual({
    "jejak-memory": {
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: `Bearer ${MEMORY_TOKEN}` },
      alwaysLoad: true,
    },
  });
});

test("pesan galat membersihkan sentinel env/header server eksternal", async () => {
  const sdk = fakeSdk({
    messages: [INIT],
    throwAfter: 1,
    error: new Error(`gagal ${STDIO_SECRET} dan ${HTTP_SECRET}`),
  });

  const events = await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      baseInput({ mcpServers: [externalStdio(), externalHttp()] }),
    ),
  );

  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(STDIO_SECRET);
  expect(serialized).not.toContain(HTTP_SECRET);
  const error = events.find((event) => event.type === "error");
  expect(error?.type).toBe("error");
  if (error?.type === "error") {
    expect(error.message).toContain("***");
  }
});

test("semua server MCP (memory dan eksternal) memakai alwaysLoad", async () => {
  let received: Record<string, unknown> | undefined;
  const sdk = fakeSdk({ messages: [RESULT_OK], onOptions: (options) => (received = options) });

  await collect(
    createSdkRunner({ load: async () => sdk.module, baseEnv: {} }).run(
      memoryInput({ mcpServers: [externalStdio(), externalHttp()] }),
    ),
  );

  const servers = received?.mcpServers as Record<string, Record<string, unknown>>;
  expect(Object.keys(servers).sort()).toEqual(["ext-github", "ext-remote", "jejak-memory"]);
  for (const server of Object.values(servers)) {
    expect(server.alwaysLoad).toBe(true);
  }
});

test("withMaxRetries menyetel CLAUDE_CODE_MAX_RETRIES tanpa menimpa nilai pengguna", () => {
  const base = { A: "1" };
  expect(withMaxRetries(base, undefined)).toBe(base);
  expect(withMaxRetries(base, 2)).toEqual({ A: "1", CLAUDE_CODE_MAX_RETRIES: "2" });
  expect(base).toEqual({ A: "1" });
  expect(withMaxRetries({ CLAUDE_CODE_MAX_RETRIES: "7" }, 2)).toEqual({
    CLAUDE_CODE_MAX_RETRIES: "7",
  });
});
