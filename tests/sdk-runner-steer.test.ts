import { expect, test } from "bun:test";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import type { SteerUserMessage } from "../src/server/agent/steer-input";
import { createSdkRunner, type SdkModule } from "../src/server/agent/sdk-runner";
import type { ResolvedProvider } from "../src/server/provider";

const PROVIDER: ResolvedProvider = {
  profileId: "proxy",
  baseUrl: "https://proxy.test/v1",
  apiKey: "sk-rahasia-palsu",
  model: "model-profil",
};

const INIT = { type: "system", subtype: "init", session_id: "s-1", model: "model-profil" };
const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "selesai",
  total_cost_usd: 0.01,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
};
const RESULT_PERANTARA = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "perantara",
  queued_turn_count: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
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

type SteerStep =
  | { kind: "sdk"; message: unknown }
  | { kind: "steer"; text: string };

interface SteerFake {
  module: SdkModule;
  /** Prompt yang diterima SDK. */
  prompts: unknown[];
  /** Pesan prompt yang dibaca SDK. */
  read: SteerUserMessage[];
  /** Hasil pemanggilan steer pada langkah "steer". */
  steerOk: boolean[];
  /** Fungsi steer yang didaftarkan runner. */
  holder: { steer?: (text: string) => boolean };
}

/**
 * SDK palsu yang membaca prompt streaming sebagai iterable.
 *
 * Prompt string dibaca sebagai pesan biasa; prompt streaming dibaca lewat
 * iterator, dan iterasi SDK berakhir saat prompt habis (input ditutup
 * runner).
 */
function steerSdk(steps: SteerStep[] = []): SteerFake {
  const prompts: unknown[] = [];
  const read: SteerUserMessage[] = [];
  const steerOk: boolean[] = [];
  const holder: { steer?: (text: string) => boolean } = {};

  const module: SdkModule = {
    query(args) {
      prompts.push(args.prompt);
      const prompt = args.prompt;
      return {
        async *[Symbol.asyncIterator]() {
          if (typeof prompt === "string") {
            for (const step of steps) {
              if (step.kind === "sdk") yield step.message;
            }
            return;
          }
          const iterator = (prompt as AsyncIterable<SteerUserMessage>)[Symbol.asyncIterator]();
          const pertama = await iterator.next();
          if (!pertama.done) read.push(pertama.value);
          for (const step of steps) {
            if (step.kind === "sdk") {
              yield step.message;
              continue;
            }
            const fungsi = holder.steer;
            const masuk = fungsi === undefined ? false : fungsi(step.text);
            steerOk.push(masuk);
            if (masuk) {
              const berikut = await iterator.next();
              if (!berikut.done) read.push(berikut.value);
            }
          }
          // Input ditutup runner (hasil akhir atau batal); prompt habis.
          const akhir = await iterator.next();
          if (!akhir.done) read.push(akhir.value);
        },
      };
    },
  };

  return { module, prompts, read, steerOk, holder };
}

test("tanpa registerSteer prompt tetap string", async () => {
  const fake = steerSdk([{ kind: "sdk", message: RESULT_OK }]);
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  const events = await collect(runner.run(baseInput()));

  expect(typeof fake.prompts[0]).toBe("string");
  expect(fake.prompts[0]).toBe("halo");
  expect(events.at(-1)?.type).toBe("result");
});

test("registerSteer mendaftarkan fungsi lalu(undefined) di akhir giliran", async () => {
  const fake = steerSdk([
    { kind: "sdk", message: INIT },
    { kind: "steer", text: "tambahan" },
    { kind: "sdk", message: RESULT_OK },
  ]);
  const calls: (unknown)[] = [];
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  const events = await collect(
    runner.run(
      baseInput({
        registerSteer: (steer) => {
          calls.push(steer);
          fake.holder.steer = steer;
        },
      }),
    ),
  );

  expect(calls).toHaveLength(2);
  expect(typeof calls[0]).toBe("function");
  expect(calls[1]).toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(["session", "result"]);
});

test("steer selama giliran mendorong pesan priority next ke iterable", async () => {
  const fake = steerSdk([
    { kind: "sdk", message: INIT },
    { kind: "steer", text: "tambahan" },
    { kind: "sdk", message: RESULT_OK },
  ]);
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  await collect(
    runner.run(
      baseInput({
        registerSteer: (steer) => {
          fake.holder.steer = steer;
        },
      }),
    ),
  );

  expect(fake.steerOk).toEqual([true]);
  expect(fake.read).toHaveLength(2);
  expect(fake.read[0]?.message.content).toBe("halo");
  expect(fake.read[0]?.priority).toBeUndefined();
  expect(fake.read[1]?.message.content).toBe("tambahan");
  expect(fake.read[1]?.priority).toBe("next");
});

test("result akhir menutup input prompt", async () => {
  const fake = steerSdk([
    { kind: "sdk", message: RESULT_OK },
  ]);
  let steer: ((text: string) => boolean) | undefined;
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  await collect(
    runner.run(
      baseInput({
        registerSteer: (registered) => {
          // Hanya fungsi yang disimpan; panggilan `undefined` di akhir giliran
          // tak menimpa.
          if (registered !== undefined) steer = registered;
        },
      }),
    ),
  );

  // Input ditutup: steer ditolak.
  expect(typeof steer).toBe("function");
  expect(steer?.("tambahan")).toBe(false);
});

test("result perantara tak di-yield dan input tetap terbuka", async () => {
  const fake = steerSdk([
    { kind: "sdk", message: RESULT_PERANTARA },
    { kind: "steer", text: "antar" },
    { kind: "sdk", message: RESULT_OK },
  ]);
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  const events = await collect(
    runner.run(
      baseInput({
        registerSteer: (steer) => {
          fake.holder.steer = steer;
        },
      }),
    ),
  );

  // Hasil perantara tidak diteruskan; hanya hasil terakhir yang keluar.
  const hasil = events.filter((event) => event.type === "result");
  expect(hasil).toHaveLength(1);
  expect(hasil[0]?.type === "result" && hasil[0].summary).toBe("selesai");
  // Input masih terbuka saat hasil perantara datang: steer diterima.
  expect(fake.steerOk).toEqual([true]);
  expect(fake.read.map((message) => message.message.content)).toEqual([
    "halo",
    "antar",
  ]);
});

test("batal menutup input prompt", async () => {
  const fake = steerSdk([{ kind: "sdk", message: INIT }]);
  const controller = new AbortController();
  const runner = createSdkRunner({ load: async () => fake.module, baseEnv: {} });

  const mengumpulkan = collect(
    runner.run(baseInput({ signal: controller.signal })),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  const events = await mengumpulkan;
  const hasil = events.find((event) => event.type === "result");
  expect(hasil?.type === "result" && hasil.ok).toBe(false);
  expect(hasil?.type === "result" && hasil.error).toBe("dibatalkan");
});
