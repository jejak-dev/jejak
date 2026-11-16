import { expect, test } from "bun:test";
import {
  createSdkRunner,
  type SdkModule,
  type SdkQuery,
} from "../src/server/agent/sdk-runner";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import type { ResolvedProvider } from "../src/server/provider";

const PROVIDER: ResolvedProvider = {
  profileId: "proxy",
  baseUrl: "https://proxy.test/v1",
  apiKey: "sk-rahasia-palsu",
  model: "model-profil",
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

interface OpsiSdk {
  perintah?: { name: string; description?: string; argumentHint?: string; aliases?: string[] }[];
  /** supportedCommands melempar galat. */
  galat?: Error;
  /** supportedCommands tak pernah selesai. */
  menggantung?: boolean;
}

interface SdkTiruan {
  module: SdkModule;
  closed: () => boolean;
  dipanggil: () => number;
  opsi: () => Record<string, unknown> | undefined;
}

function sdkTiruan(opsi: OpsiSdk): SdkTiruan {
  let closed = false;
  let dipanggil = 0;
  let opsiTersimpan: Record<string, unknown> | undefined;
  const module: SdkModule = {
    query(args) {
      dipanggil += 1;
      opsiTersimpan = args.options;
      const query: SdkQuery = {
        close() {
          closed = true;
        },
        async supportedCommands() {
          if (opsi.galat !== undefined) throw opsi.galat;
          if (opsi.menggantung === true) {
            return new Promise<never>(() => {
              // tak pernah selesai
            });
          }
          return opsi.perintah ?? [];
        },
        async *[Symbol.asyncIterator]() {
          yield RESULT_OK;
        },
      };
      return query;
    },
  };
  return {
    module,
    closed: () => closed,
    dipanggil: () => dipanggil,
    opsi: () => opsiTersimpan,
  };
}

async function kumpulkan(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function baseInput(overrides: Partial<RunInput> = {}): RunInput {
  return { prompt: "halo", cwd: "/tmp/kerja", provider: PROVIDER, ...overrides };
}

test("daftar perintah dibaca dari SDK dan sesi ditutup", async () => {
  const sdk = sdkTiruan({
    perintah: [
      { name: "compact", description: "Padatkan", argumentHint: "" },
      { name: "ping", description: "PING", argumentHint: "<x>", aliases: ["p"] },
      { name: "tanpa-keterangan" },
    ],
  });
  const runner = createSdkRunner({ load: async () => sdk.module, baseEnv: {} });

  const hasil = await runner.listCommands?.({ cwd: "/tmp/kerja" });

  expect(sdk.dipanggil()).toBe(1);
  expect(sdk.closed()).toBe(true);
  expect(hasil).toEqual([
    { name: "compact", description: "Padatkan", argumentHint: "" },
    { name: "ping", description: "PING", argumentHint: "<x>", aliases: ["p"] },
    { name: "tanpa-keterangan", description: "", argumentHint: "" },
  ]);
});

test("sesi ditutup saat pembacaan perintah gagal", async () => {
  const sdk = sdkTiruan({ galat: new Error("SDK gagal") });
  const runner = createSdkRunner({ load: async () => sdk.module, baseEnv: {} });

  let galat: unknown;
  try {
    await runner.listCommands?.({ cwd: "/tmp/kerja" });
  } catch (caught) {
    galat = caught;
  }

  expect(galat).toBeInstanceOf(Error);
  expect((galat as Error).message).toBe("SDK gagal");
  expect(sdk.closed()).toBe(true);
});

test("sesi ditutup saat pembacaan perintah lewat batas waktu", async () => {
  const sdk = sdkTiruan({ menggantung: true });
  const runner = createSdkRunner({
    load: async () => sdk.module,
    baseEnv: {},
    commandTimeoutMs: 30,
  });

  let galat: unknown;
  try {
    await runner.listCommands?.({ cwd: "/tmp/kerja" });
  } catch (caught) {
    galat = caught;
  }

  expect(galat).toBeInstanceOf(Error);
  expect((galat as Error).message).toContain("batas waktu");
  expect(sdk.closed()).toBe(true);
});

test("SDK lama tanpa supportedCommands Report galat", async () => {
  const module: SdkModule = {
    query() {
      const query: SdkQuery = {
        close() {
          // tak ada apa-apa
        },
        async *[Symbol.asyncIterator]() {
          // kosong
        },
      };
      return query;
    },
  };
  const runner = createSdkRunner({ load: async () => module, baseEnv: {} });

  let galat: unknown;
  try {
    await runner.listCommands?.({ cwd: "/tmp/kerja" });
  } catch (caught) {
    galat = caught;
  }

  expect(galat).toBeInstanceOf(Error);
});

test("opsi cwd, settingSources, dan skill sama seperti saat giliran berjalan", async () => {
  const sdk = sdkTiruan({ perintah: [{ name: "compact" }] });
  const runner = createSdkRunner({
    load: async () => sdk.module,
    baseEnv: { PATH: "/usr/bin" },
  });

  await kumpulkan(
    runner.run(
      baseInput({
        claude: { userSettings: true, hooksEnabled: true, skills: ["tulis"] },
      }),
    ),
  );
  const opsiGiliran = sdk.opsi();

  await runner.listCommands?.({
    cwd: "/tmp/kerja",
    claude: { userSettings: true, hooksEnabled: true, skills: ["tulis"] },
  });
  const opsiPerintah = sdk.opsi();

  expect(opsiPerintah?.cwd).toBe(opsiGiliran?.cwd);
  expect(opsiPerintah?.cwd).toBe("/tmp/kerja");
  expect(opsiPerintah?.settingSources).toEqual(["project", "user"]);
  expect(opsiGiliran?.settingSources).toEqual(["project", "user"]);
  expect(opsiPerintah?.skills).toEqual(["tulis"]);
  expect(opsiGiliran?.skills).toEqual(["tulis"]);
});

test("sumber pengguna tak aktif memakai settingSources proyek saja", async () => {
  const sdk = sdkTiruan({ perintah: [] });
  const runner = createSdkRunner({ load: async () => sdk.module, baseEnv: {} });

  await runner.listCommands?.({
    cwd: "/tmp/kerja",
    claude: { userSettings: false, hooksEnabled: true },
  });

  expect(sdk.opsi()?.settingSources).toEqual(["project"]);
});
