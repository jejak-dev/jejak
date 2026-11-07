import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  jejakHome,
  loadRegistry,
  providersPath,
  saveRegistry,
} from "../src/server/provider-store";
import { parseRegistry, type ProviderRegistry } from "../src/server/provider";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function envHome(): Record<string, string> {
  return { JEJAK_HOME: join(root, "home") };
}

test("jejakHome memakai JEJAK_HOME yang dipangkas", () => {
  expect(jejakHome({ JEJAK_HOME: "  /tmp/kustom  " })).toBe("/tmp/kustom");
});

test("jejakHome jatuh ke ~/.jejak bila JEJAK_HOME kosong atau tidak diset", () => {
  const fallback = join(homedir(), ".jejak");
  expect(jejakHome({})).toBe(fallback);
  expect(jejakHome({ JEJAK_HOME: "" })).toBe(fallback);
  expect(jejakHome({ JEJAK_HOME: "   " })).toBe(fallback);
});

test("providersPath menggabungkan jejakHome dengan providers.json", () => {
  expect(providersPath(envHome())).toBe(join(root, "home", "providers.json"));
  expect(providersPath({})).toBe(join(homedir(), ".jejak", "providers.json"));
});

test("loadRegistry tanpa berkas mengembalikan registry dari env", async () => {
  const registry = await loadRegistry(join(root, "tidak-ada.json"), {
    JEJAK_API_KEY: "env-key",
    JEJAK_MODEL: "env-model",
  });

  expect(registry.profiles[0]?.apiKey).toBe("env-key");
  expect(registry.profiles[0]?.defaultModel).toBe("env-model");
});

test("saveRegistry lalu loadRegistry melakukan round-trip", async () => {
  const env = { API_KEY_DEEPSEEK: "deepseek-env-key" };
  const path = providersPath(envHome());
  const registry = parseRegistry(
    {
      activeProfileId: "deepseek",
      profiles: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.test/v1",
          apiKeyEnv: "API_KEY_DEEPSEEK",
          models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
          defaultModel: "deepseek-chat",
        },
        { id: "anthropic", name: "Anthropic", apiKey: "literal-key", models: [] },
      ],
    },
    env,
  );

  await saveRegistry(registry, path);

  expect(await loadRegistry(path, env)).toEqual(registry);
});

test("saveRegistry membuat direktori 0o700 dan berkas 0o600", async () => {
  const path = providersPath(envHome());
  await saveRegistry({ profiles: [{ id: "p", name: "P", models: [] }] }, path);

  const dirMode = (await stat(join(root, "home"))).mode & 0o777;
  const fileMode = (await stat(path)).mode & 0o777;

  expect(dirMode).toBe(0o700);
  expect(fileMode).toBe(0o600);
});

test("saveRegistry tidak menulis key yang berasal dari apiKeyEnv", async () => {
  const path = providersPath(envHome());
  const registry = parseRegistry(
    { profiles: [{ id: "p", name: "P", apiKeyEnv: "RAHASIA_ENV", models: [] }] },
    { RAHASIA_ENV: "nilai-rahasia-env" },
  );

  await saveRegistry(registry, path);

  const contents = await readFile(path, "utf8");
  expect(contents).not.toContain("nilai-rahasia-env");
  expect(contents).toContain('"apiKeyEnv": "RAHASIA_ENV"');
});

test("saveRegistry tetap menulis apiKey literal", async () => {
  const path = providersPath(envHome());
  const registry: ProviderRegistry = {
    profiles: [{ id: "p", name: "P", apiKey: "literal-key", models: [] }],
  };

  await saveRegistry(registry, path);

  expect(await readFile(path, "utf8")).toContain('"apiKey": "literal-key"');
});

test("loadRegistry melempar untuk JSON rusak tanpa membocorkan isi berkas", async () => {
  const path = join(root, "rusak.json");
  const sentinel = "isi-rahasia-berkas";
  await Bun.write(path, `{ ${sentinel} `);

  let message = "";
  try {
    await loadRegistry(path, {});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain(path);
  expect(message).not.toContain(sentinel);
});

test("loadRegistry melempar untuk registry tidak valid", async () => {
  const path = join(root, "tidak-valid.json");
  await Bun.write(path, JSON.stringify({ profiles: [{ id: "Besar", name: "X" }] }));

  await expect(loadRegistry(path, {})).rejects.toThrow(/tidak valid/);
});

test("saveRegistry menolak registry tidak valid dan tidak membuat berkas", async () => {
  const path = providersPath(envHome());

  await expect(
    saveRegistry({ profiles: [{ id: "Besar", name: "X", models: [] }] }, path),
  ).rejects.toThrow(/tidak valid/);
  await expect(stat(path)).rejects.toThrow();
});

test("saveRegistry tidak meninggalkan berkas sementara", async () => {
  const path = providersPath(envHome());
  await saveRegistry({ profiles: [{ id: "p", name: "P", models: [] }] }, path);

  const entries = await readdir(join(root, "home"));
  expect(entries).toEqual(["providers.json"]);
});
