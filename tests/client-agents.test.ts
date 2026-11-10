import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, type ClaudeAgentItem } from "../src/client/lib/api";
import { agentSummary, agentTemplate } from "../src/client/lib/instruksi";

const AGENT: ClaudeAgentItem = {
  scope: "project",
  name: "peninjau",
  description: "Meninjau diff",
  tools: ["Read", "Grep"],
  model: "sonnet",
  path: "/kerja/.claude/agents/peninjau.md",
};

function fakeFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fungsi murni subagent", () => {
  test("agentTemplate memuat nama dan frontmatter", () => {
    const text = agentTemplate("peninjau");
    expect(text.startsWith("---\nname: peninjau\n")).toBe(true);
    expect(text).toContain("tools: Read, Grep, Glob");
  });

  test("agentSummary: model dan tool, semua tool, tidak valid", () => {
    expect(agentSummary(AGENT)).toBe("sonnet · Read, Grep");
    expect(agentSummary({ ...AGENT, model: "", tools: [] })).toBe("semua tool");
    expect(agentSummary({ ...AGENT, invalid: "terlalu besar" })).toBe("tidak valid: terlalu besar");
  });
});

describe("ApiClient subagent", () => {
  test("listAgents membuka bungkus agents dan meng-encode cwd", async () => {
    const { fetch, calls } = fakeFetch(() => json({ agents: [AGENT] }));
    expect(await createApiClient({ fetch }).listAgents("/kerja satu")).toEqual([AGENT]);
    expect(calls[0]?.url).toBe("/api/claude/agents?cwd=%2Fkerja%20satu");
  });

  test("getAgent dan putAgent memakai jalur scope/nama", async () => {
    const { fetch, calls } = fakeFetch(() => json({ ...AGENT, content: "isi" }));
    const api = createApiClient({ fetch });
    expect((await api.getAgent("project", "nama satu", "/kerja")).content).toBe("isi");
    expect(calls[0]?.url).toBe("/api/claude/agents/project/nama%20satu?cwd=%2Fkerja");
    await api.putAgent("user", "umum", "baru");
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.url).toBe("/api/claude/agents/user/umum");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ content: "baru" });
  });

  test("respons salah bentuk atau galat server menjadi ApiError", async () => {
    const bad = fakeFetch(() => json({ x: 1 }));
    await expect(createApiClient({ fetch: bad.fetch }).listAgents("/k")).rejects.toBeInstanceOf(ApiError);
    const err = fakeFetch(() => json({ error: "Pengaturan Claude dimatikan." }, 503));
    await expect(createApiClient({ fetch: err.fetch }).listAgents("/k")).rejects.toBeInstanceOf(ApiError);
  });
});
