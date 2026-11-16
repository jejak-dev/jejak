import { describe, expect, test } from "bun:test";
import {
  ApiError,
  createApiClient,
  type ClaudeHookItem,
  type ClaudePluginItem,
  type ClaudeSkillItem,
} from "../src/client/lib/api";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONFIG = { userSettings: false, hooksEnabled: true };

const INSTRUCTIONS = {
  path: "/kerja/CLAUDE.md",
  exists: true,
  content: "# Aturan",
};

const SKILL: ClaudeSkillItem = {
  scope: "project",
  name: "contoh",
  description: "contoh skill",
  path: "/kerja/.claude/skills/contoh/SKILL.md",
  enabled: true,
};

describe("getClaudeConfig / putClaudeConfig", () => {
  test("GET /api/claude/config", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(CONFIG));
    const api = createApiClient({ fetch });

    expect(await api.getClaudeConfig()).toEqual(CONFIG);
    expect(calls[0]?.url).toBe("/api/claude/config");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("PUT hanya mengirim field yang diberikan", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ...CONFIG, userSettings: true }));
    const api = createApiClient({ fetch });

    const result = await api.putClaudeConfig({ userSettings: true });

    expect(result.userSettings).toBe(true);
    expect(calls[0]?.url).toBe("/api/claude/config");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ userSettings: true }));
  });

  test("respons tidak valid menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ userSettings: true }));
    const api = createApiClient({ fetch });

    await expect(api.getClaudeConfig()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("instruksi", () => {
  test("getInstructions mengirim scope dan cwd ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(INSTRUCTIONS));
    const api = createApiClient({ fetch });

    expect(await api.getInstructions("project", "/kerja satu")).toEqual(INSTRUCTIONS);
    expect(calls[0]?.url).toBe(
      "/api/claude/instructions?scope=project&cwd=%2Fkerja%20satu",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("cakupan pengguna tidak mengirim cwd kosong", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ path: "/home/u/.claude/CLAUDE.md", exists: false, content: "" }),
    );
    const api = createApiClient({ fetch });

    await api.getInstructions("user", "");
    expect(calls[0]?.url).toBe("/api/claude/instructions?scope=user");
  });

  test("putInstructions mengirim body content", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(INSTRUCTIONS));
    const api = createApiClient({ fetch });

    await api.putInstructions("project", "# Baru", "/kerja");
    expect(calls[0]?.url).toBe(
      "/api/claude/instructions?scope=project&cwd=%2Fkerja",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ content: "# Baru" }));
  });

  test("503 mengikuti pola ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Pengaturan Claude dimatikan." }, 503),
    );
    const api = createApiClient({ fetch });

    const error = await api.getInstructions("user").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
  });
});

describe("skills", () => {
  test("listSkills membuka bungkus skills dan meng-encode cwd", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ skills: [SKILL] }));
    const api = createApiClient({ fetch });

    expect(await api.listSkills("/kerja satu")).toEqual([SKILL]);
    expect(calls[0]?.url).toBe("/api/claude/skills?cwd=%2Fkerja%20satu");
  });

  test("getSkill meng-encode nama di jalur", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ...SKILL, content: "isi" }));
    const api = createApiClient({ fetch });

    const skill = await api.getSkill("project", "nama satu", "/kerja");
    expect(skill.content).toBe("isi");
    expect(calls[0]?.url).toBe(
      "/api/claude/skills/project/nama%20satu?cwd=%2Fkerja",
    );
  });

  test("putSkill menulis ke jalur scope/nama", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ...SKILL, content: "baru" }));
    const api = createApiClient({ fetch });

    await api.putSkill("user", "contoh", "baru", "/kerja");
    expect(calls[0]?.url).toBe("/api/claude/skills/user/contoh?cwd=%2Fkerja");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ content: "baru" }));
  });

  test("setSkillEnabled memakai rute /enabled", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ scope: "project", name: "contoh", enabled: false }),
    );
    const api = createApiClient({ fetch });

    const result = await api.setSkillEnabled("project", "contoh", false, "/kerja");
    expect(result).toEqual({ scope: "project", name: "contoh", enabled: false });
    expect(calls[0]?.url).toBe(
      "/api/claude/skills/project/contoh/enabled?cwd=%2Fkerja",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ enabled: false }));
  });

  test("respons skills tanpa array menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ items: [] }));
    const api = createApiClient({ fetch });

    await expect(api.listSkills("/kerja")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("hooks", () => {
  test("listHooks membuka bungkus hooks", async () => {
    const hook: ClaudeHookItem = {
      source: "proyek",
      event: "PreToolUse",
      command: "echo",
      active: true,
    };
    const { fetch, calls } = fakeFetch(() => jsonResponse({ hooks: [hook] }));
    const api = createApiClient({ fetch });

    expect(await api.listHooks("/kerja")).toEqual([hook]);
    expect(calls[0]?.url).toBe("/api/claude/hooks?cwd=%2Fkerja");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("respons tanpa array menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ hooks: null }));
    const api = createApiClient({ fetch });

    await expect(api.listHooks("/kerja")).rejects.toBeInstanceOf(ApiError);
  });
});

const PLUGIN: ClaudePluginItem = {
  id: "alpha@pasar",
  name: "alpha",
  marketplace: "pasar",
  description: "Plugin contoh",
  version: "1.0.0",
  author: "Penulis",
  path: "/home/u/.claude/plugins/alpha",
  skills: 3,
  commands: 2,
  agents: 1,
  hasHooks: true,
  enabled: false,
};

describe("plugin", () => {
  test("listPlugins membuka bungkus plugins", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ plugins: [PLUGIN] }));
    const api = createApiClient({ fetch });

    expect(await api.listPlugins()).toEqual([PLUGIN]);
    expect(calls[0]?.url).toBe("/api/claude/plugins");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("respons salah bentuk ditolak", async () => {
    const salah = fakeFetch(() => jsonResponse({ plugins: [{ id: "alpha" }] }));
    await expect(createApiClient({ fetch: salah.fetch }).listPlugins()).rejects.toBeInstanceOf(
      ApiError,
    );
    const bukanArray = fakeFetch(() => jsonResponse({ plugins: null }));
    await expect(
      createApiClient({ fetch: bukanArray.fetch }).listPlugins(),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("setPluginEnabled meng-encode id dan mengirim body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ id: "a b@pasar", enabled: true }));
    const api = createApiClient({ fetch });

    await api.setPluginEnabled("a b@pasar", true);
    expect(calls[0]?.url).toBe("/api/claude/plugins/a%20b%40pasar");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ enabled: true }));
  });

  test("respons setPluginEnabled salah bentuk ditolak", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ id: "alpha@pasar" }));
    await expect(
      createApiClient({ fetch }).setPluginEnabled("alpha@pasar", true),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
