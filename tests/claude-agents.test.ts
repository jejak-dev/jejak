import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { FileClaudeConfigStore } from "../src/server/claude-config/config-store";
import {
  AgentError,
  frontmatterValue,
  listAgents,
  parseTools,
  readAgent,
  writeAgent,
} from "../src/server/claude-config/agents";

let root: string;
let home: string;
let project: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-agents-")));
  home = join(root, "rumah");
  project = join(root, "proyek");
  await mkdir(join(project, ".claude", "agents"), { recursive: true });
  await mkdir(join(home, ".claude", "agents"), { recursive: true });
});

afterEach(async () => {
  for (const store of audits.splice(0)) store.close();
  await rm(root, { recursive: true, force: true });
});

const SAMPLE = '---\nname: peninjau\ndescription: "Meninjau diff"\ntools: Read, Grep\nmodel: sonnet\n---\nKamu peninjau kode.\n';

describe("frontmatter", () => {
  test("nilai, tanda kutip, dan daftar tool", () => {
    expect(frontmatterValue(SAMPLE, "description")).toBe("Meninjau diff");
    expect(frontmatterValue(SAMPLE, "model")).toBe("sonnet");
    expect(frontmatterValue("tanpa frontmatter", "model")).toBe("");
    expect(parseTools(SAMPLE)).toEqual(["Read", "Grep"]);
    expect(parseTools("---\ntools: [Read, 'Bash']\n---\n")).toEqual(["Read", "Bash"]);
    expect(parseTools("---\nname: x\n---\n")).toEqual([]);
    const folded = "---\nname: x\ndescription: >\n  Baris satu\n  baris dua\ntools: Read\n---\nisi";
    expect(frontmatterValue(folded, "description")).toBe("Baris satu baris dua");
    expect(frontmatterValue(folded, "tools")).toBe("Read");
  });
});

describe("modul subagent", () => {
  test("tulis, baca, daftar (proyek dan pengguna)", () => {
    const written = writeAgent("project", "peninjau", SAMPLE, project, home);
    expect(written.tools).toEqual(["Read", "Grep"]);
    writeAgent("user", "umum", "---\ndescription: Umum\n---\n", undefined, home);
    const list = listAgents(project, home);
    expect(list.map((a) => `${a.scope}:${a.name}`)).toEqual(["project:peninjau", "user:umum"]);
    expect(readAgent("project", "peninjau", project, home).content).toBe(SAMPLE);
    expect(list[0]?.model).toBe("sonnet");
  });

  test("nama tidak valid, cwd hilang, dan berkas terlalu besar ditolak", () => {
    expect(() => writeAgent("project", "../x", "a", project, home)).toThrow(AgentError);
    expect(() => writeAgent("project", "Besar", "a", project, home)).toThrow(AgentError);
    expect(() => writeAgent("project", "ok", "a", undefined, home)).toThrow(AgentError);
    expect(() =>
      writeAgent("project", "ok", "x".repeat(64 * 1024 + 1), project, home),
    ).toThrow(AgentError);
    expect(() => readAgent("project", "tidak-ada", project, home)).toThrow(AgentError);
  });

  test("symlink yang keluar dari folder agents tidak didaftarkan dan tidak bisa dibaca", async () => {
    const luar = join(root, "luar.md");
    await writeFile(luar, "---\ndescription: bocor\n---\n");
    await symlink(luar, join(project, ".claude", "agents", "bocor.md"));
    expect(listAgents(project, home).some((a) => a.name === "bocor")).toBe(false);
    expect(() => readAgent("project", "bocor", project, home)).toThrow(AgentError);
    expect(() => writeAgent("project", "bocor", "baru", project, home)).toThrow(AgentError);
    expect(await readFile(luar, "utf8")).toContain("bocor");
  });
});

describe("rute subagent", () => {
  function app(options: { store?: boolean; audit?: AuditStore } = {}) {
    return createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      ...(options.store === false ? {} : { claudeConfig: new FileClaudeConfigStore(":memory:") }),
      home,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    });
  }
  function req(a: ReturnType<typeof app>, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return a.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  }

  test("buat, daftar, baca, ubah dengan audit", async () => {
    const audit = new SqliteAuditStore(":memory:");
    audits.push(audit);
    const a = app({ audit });
    const q = `?cwd=${encodeURIComponent(project)}`;
    const put = await req(a, "PUT", `/api/claude/agents/project/peninjau${q}`, { content: SAMPLE });
    expect(put.status).toBe(200);
    const list = (await (await req(a, "GET", `/api/claude/agents${q}`)).json()) as {
      agents: Array<{ name: string; description: string }>;
    };
    expect(list.agents.map((x) => x.name)).toEqual(["peninjau"]);
    expect(list.agents[0]?.description).toBe("Meninjau diff");
    const get = await req(a, "GET", `/api/claude/agents/project/peninjau${q}`);
    expect(((await get.json()) as { content: string }).content).toBe(SAMPLE);
    await req(a, "PUT", `/api/claude/agents/project/peninjau${q}`, { content: SAMPLE + "x" });
    const summaries = audit.list({ kind: "pengaturan", limit: 10 }).map((e) => e.summary);
    expect(summaries).toContain("Subagent dibuat");
    expect(summaries).toContain("Subagent diubah");
  });

  test("galat: tidak ada 404, nama buruk 400, field tak dikenal 400, mati 503", async () => {
    const a = app();
    const q = `?cwd=${encodeURIComponent(project)}`;
    expect((await req(a, "GET", `/api/claude/agents/project/nihil${q}`)).status).toBe(404);
    expect((await req(a, "PUT", `/api/claude/agents/project/BURUK${q}`, { content: "a" })).status).toBe(400);
    expect((await req(a, "PUT", `/api/claude/agents/project/ok${q}`, { content: "a", x: 1 })).status).toBe(400);
    expect((await req(a, "GET", "/api/claude/agents")).status).toBe(400);
    const off = app({ store: false });
    expect((await req(off, "GET", `/api/claude/agents${q}`)).status).toBe(503);
  });
});
