import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import { FileClaudeConfigStore } from "../src/server/claude-config/config-store";

let root: string;
let home: string;
let project: string;
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-claude-rute-")));
  home = join(root, "rumah");
  project = join(root, "proyek");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(project, ".claude", "skills", "pdf"), { recursive: true });
  await writeFile(
    join(project, ".claude", "skills", "pdf", "SKILL.md"),
    "---\ndescription: Baca PDF\n---\n",
    "utf8",
  );
});

afterEach(async () => {
  for (const store of audits) store.close();
  audits = [];
  await rm(root, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function setup(options: { store?: FileClaudeConfigStore | false; audit?: AuditStore } = {}): App {
  const store = options.store === false ? undefined : options.store ?? new FileClaudeConfigStore(":memory:");
  return createApp({
    env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
    ...(store === undefined ? {} : { claudeConfig: store }),
    home,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}

function req(
  app: App,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function entries(store: AuditStore): AuditEntry[] {
  return store.list({ kind: "pengaturan", limit: 200 });
}

describe("rute pengaturan Claude", () => {
  test("GET/PUT config", async () => {
    const app = setup();
    expect(await json(await req(app, "GET", "/api/claude/config"))).toEqual({
      userSettings: false,
      hooksEnabled: true,
    });
    const put = await req(app, "PUT", "/api/claude/config", { userSettings: true });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ userSettings: true, hooksEnabled: true });
  });

  test("config: validasi 400", async () => {
    const app = setup();
    for (const body of [
      {},
      { userSettings: "ya" },
      { lain: true },
      "bukan json",
      "[1]",
      { hooksEnabled: 1 },
    ]) {
      const res = await req(app, "PUT", "/api/claude/config", body);
      expect(res.status).toBe(400);
      expect(typeof (await json(res)).error).toBe("string");
    }
  });

  test("instruksi proyek dan pengguna", async () => {
    const app = setup();
    const proyek = await req(app, "GET", `/api/claude/instructions?scope=project&cwd=${project}`);
    expect(await json(proyek)).toEqual({
      path: join(project, "CLAUDE.md"),
      exists: false,
      content: "",
    });

    const put = await req(app, "PUT", `/api/claude/instructions?scope=project&cwd=${project}`, {
      content: "# Aturan\n",
    });
    expect(put.status).toBe(200);
    expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe("# Aturan\n");

    const user = await req(app, "PUT", "/api/claude/instructions?scope=user", { content: "# Saya\n" });
    expect(user.status).toBe(200);
    expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("# Saya\n");
  });

  test("instruksi: 400 untuk cwd/scope/body tak valid", async () => {
    const app = setup();
    for (const path of [
      "/api/claude/instructions",
      "/api/claude/instructions?scope=lain",
      "/api/claude/instructions?scope=project",
      "/api/claude/instructions?scope=project&cwd=relatif",
      `/api/claude/instructions?scope=project&cwd=${join(root, "tidak-ada")}`,
    ]) {
      const res = await req(app, "GET", path);
      expect(res.status).toBe(400);
    }
    const badBody = await req(
      app,
      "PUT",
      `/api/claude/instructions?scope=project&cwd=${project}`,
      { content: 1 },
    );
    expect(badBody.status).toBe(400);
    const unknown = await req(
      app,
      "PUT",
      `/api/claude/instructions?scope=project&cwd=${project}`,
      { content: "x", lain: 1 },
    );
    expect(unknown.status).toBe(400);
  });

  test("skills: daftar, baca, buat, ubah, dan saklar aktif", async () => {
    const app = setup();
    const list = await json(
      await req(app, "GET", `/api/claude/skills?cwd=${project}`),
    );
    expect(list.skills).toEqual([
      {
        scope: "project",
        name: "pdf",
        description: "Baca PDF",
        path: join(project, ".claude", "skills", "pdf", "SKILL.md"),
        enabled: true,
      },
    ]);

    const read = await req(app, "GET", `/api/claude/skills/project/pdf?cwd=${project}`);
    expect(await json(read)).toMatchObject({ name: "pdf", enabled: true });

    const created = await req(app, "PUT", `/api/claude/skills/project/baru?cwd=${project}`, {
      content: "---\ndescription: Baru\n---\n",
    });
    expect(created.status).toBe(200);
    expect(await json(created)).toMatchObject({ name: "baru", description: "Baru" });

    const updated = await req(app, "PUT", `/api/claude/skills/project/baru?cwd=${project}`, {
      content: "---\ndescription: Diubah\n---\n",
    });
    expect(await json(updated)).toMatchObject({ description: "Diubah" });

    const off = await req(
      app,
      "PUT",
      `/api/claude/skills/project/pdf/enabled?cwd=${project}`,
      { enabled: false },
    );
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ enabled: false });

    const after = await json(await req(app, "GET", `/api/claude/skills?cwd=${project}`));
    const skills = after.skills as Array<{ name: string; enabled: boolean }>;
    expect(skills.find((skill) => skill.name === "pdf")?.enabled).toBe(false);
  });

  test("skills: 400 dan 404", async () => {
    const app = setup();
    for (const path of [
      "/api/claude/skills",
      `/api/claude/skills?cwd=relatif`,
      `/api/claude/skills?cwd=${join(root, "tidak-ada")}`,
    ]) {
      expect((await req(app, "GET", path)).status).toBe(400);
    }
    expect(
      (await req(app, "GET", `/api/claude/skills/lain/pdf?cwd=${project}`)).status,
    ).toBe(400);
    expect(
      (await req(app, "GET", `/api/claude/skills/project/tidak-ada?cwd=${project}`)).status,
    ).toBe(404);
    expect(
      (await req(app, "PUT", `/api/claude/skills/project/PDF?cwd=${project}`, { content: "x" }))
        .status,
    ).toBe(400);
    expect(
      (await req(app, "PUT", `/api/claude/skills/project/pdf/enabled?cwd=${project}`, {
        enabled: "ya",
      })).status,
    ).toBe(400);
  });

  test("hooks: daftar baca-saja dan validasi cwd", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo pengguna" }] }] },
      }),
      "utf8",
    );
    const app = setup();
    const off = await json(await req(app, "GET", `/api/claude/hooks?cwd=${project}`));
    expect(off.hooks).toEqual([
      { source: "pengguna", event: "Stop", command: "echo pengguna", active: false },
    ]);
    expect((await req(app, "GET", "/api/claude/hooks")).status).toBe(400);
  });

  test("503 tanpa store di semua rute", async () => {
    const app = setup({ store: false });
    const cases: Array<[string, string]> = [
      ["GET", "/api/claude/config"],
      ["PUT", "/api/claude/config"],
      ["GET", `/api/claude/instructions?scope=project&cwd=${project}`],
      ["PUT", `/api/claude/instructions?scope=project&cwd=${project}`],
      ["GET", `/api/claude/skills?cwd=${project}`],
      ["GET", `/api/claude/skills/project/pdf?cwd=${project}`],
      ["PUT", `/api/claude/skills/project/pdf?cwd=${project}`],
      ["PUT", `/api/claude/skills/project/pdf/enabled?cwd=${project}`],
      ["GET", `/api/claude/hooks?cwd=${project}`],
    ];
    for (const [method, path] of cases) {
      const res = await req(app, method, path, method === "PUT" ? { content: "x" } : undefined);
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "Pengaturan Claude dimatikan." });
    }
  });

  test("audit tanpa isi dan tanpa jalur penuh", async () => {
    const audit = auditStore();
    const store = new FileClaudeConfigStore(":memory:");
    const app = setup({ store, audit });

    await req(app, "PUT", "/api/claude/config", { userSettings: true });
    await req(app, "PUT", "/api/claude/config", { hooksEnabled: false });
    await req(app, "PUT", `/api/claude/instructions?scope=project&cwd=${project}`, {
      content: "RAHASIA-ISI-CLAUDE-MD",
    });
    await req(app, "PUT", `/api/claude/skills/project/baru?cwd=${project}`, {
      content: "---\ndescription: Baru\n---\n",
    });
    await req(app, "PUT", `/api/claude/skills/project/baru?cwd=${project}`, {
      content: "---\ndescription: Ubah\n---\n",
    });
    await req(app, "PUT", `/api/claude/skills/project/baru/enabled?cwd=${project}`, {
      enabled: false,
    });

    const all = entries(audit);
    const summaries = all.map((entry) => entry.summary);
    expect(summaries).toContain("Pengaturan sumber pengguna diubah");
    expect(summaries).toContain("Hooks dinonaktifkan");
    expect(summaries).toContain("CLAUDE.md diubah (proyek)");
    expect(summaries).toContain("Skill dibuat");
    expect(summaries).toContain("Skill diubah");
    expect(summaries).toContain("Skill dinonaktifkan");

    for (const entry of all) {
      const text = `${entry.summary}${JSON.stringify(entry.meta)}`;
      expect(text).not.toContain("RAHASIA-ISI-CLAUDE-MD");
      expect(text).not.toContain("deskripsi");
      expect(text).not.toContain(project);
    }
    const created = all.find((entry) => entry.summary === "Skill dibuat");
    expect(created?.meta).toMatchObject({ aksi: "buat-skill", scope: "project", nama: "baru" });
    expect(typeof created?.meta.ukuran).toBe("number");
  });

  test("audit tidak dicatat bila nilai tidak berubah", async () => {
    const audit = auditStore();
    const app = setup({ audit });
    await req(app, "PUT", "/api/claude/config", { userSettings: false });
    expect(entries(audit)).toEqual([]);
  });
});
