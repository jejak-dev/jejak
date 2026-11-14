import { expect, test } from "bun:test";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import { createSdkRunner, type SdkModule, type SdkQuery } from "../src/server/agent/sdk-runner";
import type { ClaudeLocation, ClaudeSource } from "../src/server/sdk/claude-locator";
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

interface Opsi {
  source: ClaudeSource;
  compiled?: boolean;
  lokasi?: ClaudeLocation | null;
  calls?: { count: number };
  jam?: { nilai: number };
}

function baseInput(): RunInput {
  return { prompt: "halo", cwd: "/tmp/kerja", provider: PROVIDER };
}

/** Jalankan satu giliran dan kembalikan opsi yang dikirim ke SDK. */
async function jalankan(opsi: Opsi): Promise<Record<string, unknown> | undefined> {
  let diterima: Record<string, unknown> | undefined;
  const module: SdkModule = {
    query(args) {
      diterima = args.options;
      const query: SdkQuery = {
        async *[Symbol.asyncIterator]() {
          yield RESULT_OK;
        },
      };
      return query;
    },
  };
  const lokasi =
    opsi.lokasi === undefined
      ? { path: "/bin/claude", version: "2.1.0", source: opsi.source }
      : opsi.lokasi;
  const calls = opsi.calls ?? { count: 0 };
  const jam = opsi.jam ?? { nilai: 1_000 };
  const locate = async (): Promise<ClaudeLocation | null> => {
    calls.count += 1;
    return lokasi;
  };
  const events: AgentEvent[] = [];
  for await (const event of createSdkRunner({
    load: async () => module,
    baseEnv: {},
    locateClaude: locate,
    isCompiled: () => opsi.compiled === true,
    now: () => jam.nilai,
  }).run(baseInput())) {
    events.push(event);
  }
  return diterima;
}

test("sumber env meneruskan pathToClaudeCodeExecutable", async () => {
  const options = await jalankan({ source: "env" });
  expect(options?.pathToClaudeCodeExecutable).toBe("/bin/claude");
});

test("sumber pengaturan meneruskan pathToClaudeCodeExecutable", async () => {
  const options = await jalankan({ source: "setting" });
  expect(options?.pathToClaudeCodeExecutable).toBe("/bin/claude");
});

test("sumber PATH tidak menimpa perilaku SDK di mode dev", async () => {
  const options = await jalankan({ source: "path", compiled: false });
  expect(options?.pathToClaudeCodeExecutable).toBeUndefined();
});

test("sumber lokasi umum tidak menimpa perilaku SDK di mode dev", async () => {
  const options = await jalankan({ source: "common", compiled: false });
  expect(options?.pathToClaudeCodeExecutable).toBeUndefined();
});

test("binary terkompilasi meneruskan jalur dari sumber apa pun", async () => {
  const path = await jalankan({ source: "path", compiled: true });
  expect(path?.pathToClaudeCodeExecutable).toBe("/bin/claude");
  const common = await jalankan({ source: "common", compiled: true });
  expect(common?.pathToClaudeCodeExecutable).toBe("/bin/claude");
});

test("lokasi null tidak menyetel apa pun", async () => {
  const options = await jalankan({ source: "env", lokasi: null });
  expect(options?.pathToClaudeCodeExecutable).toBeUndefined();
});

test("pencarian gagal tidak menggagalkan giliran", async () => {
  const options = await jalankan({ source: "env", lokasi: null });
  expect(options?.cwd).toBe("/tmp/kerja");
});

test("hasil lookup di-cache selama 30 detik", async () => {
  const calls = { count: 0 };
  const jam = { nilai: 1_000 };
  const module: SdkModule = {
    query() {
      const query: SdkQuery = {
        async *[Symbol.asyncIterator]() {
          yield RESULT_OK;
        },
      };
      return query;
    },
  };
  const locate = async (): Promise<ClaudeLocation | null> => {
    calls.count += 1;
    return { path: "/bin/claude", version: "2.1.0", source: "env" };
  };
  const runner = createSdkRunner({
    load: async () => module,
    baseEnv: {},
    locateClaude: locate,
    isCompiled: () => false,
    now: () => jam.nilai,
  });
  for (let giliran = 0; giliran < 2; giliran += 1) {
    for await (const _event of runner.run(baseInput())) {
      //Isi giliran dijalankan sampai habis.
    }
  }
  expect(calls.count).toBe(1);

  // Setelah 30 detik cache dibuang dan pencarian diulang.
  jam.nilai += 31_000;
  for await (const _event of runner.run(baseInput())) {
    //Isi giliran dijalankan sampai habis.
  }
  expect(calls.count).toBe(2);
});

test("sumber managed meneruskan pathToClaudeCodeExecutable", async () => {
  const options = await jalankan({ source: "managed" });
  expect(options?.pathToClaudeCodeExecutable).toBe("/bin/claude");
});
