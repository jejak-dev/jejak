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

const CLAUDE_BASE = { userSettings: false, hooksEnabled: true };

test("tanpa claude: settingSources project, tanpa settings/skills", async () => {
  const options = await runWith({});
  expect(options?.settingSources).toEqual(["project"]);
  expect(options?.settings).toBeUndefined();
  expect(options?.skills).toBeUndefined();
});

test("userSettings menambah sumber user", async () => {
  expect((await runWith({ claude: CLAUDE_BASE }))?.settingSources).toEqual(["project"]);
  expect(
    (await runWith({ claude: { ...CLAUDE_BASE, userSettings: true } }))?.settingSources,
  ).toEqual(["project", "user"]);
});

test("hooksEnabled false menambah disableAllHooks tanpa mengganggu hook Jejak", async () => {
  const options = await runWith({
    claude: { ...CLAUDE_BASE, hooksEnabled: false },
    secretGuard: () => undefined,
  });
  expect(options?.settings).toEqual({ disableAllHooks: true });
  expect(Array.isArray((options?.hooks as { PreToolUse?: unknown[] }).PreToolUse)).toBe(true);

  const enabled = await runWith({ claude: CLAUDE_BASE });
  expect(enabled?.settings).toBeUndefined();
});

test("skills diteruskan hanya bila terdefinisi", async () => {
  expect((await runWith({ claude: CLAUDE_BASE }))?.skills).toBeUndefined();
  const options = await runWith({
    claude: { ...CLAUDE_BASE, skills: ["pdf", "docx"] },
  });
  expect(options?.skills).toEqual(["pdf", "docx"]);
});
