import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner, type AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import type { DesignComment } from "../src/server/design/comments";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-comments-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-comments-api-config-"));
  providersFile = join(configDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", "home.html"), "<html><body></body></html>", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(extra: Record<string, string> = {}, audit?: AuditStore): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), ...extra },
    runner: createMockRunner(),
    ...(audit === undefined ? {} : { audit }),
  });
}

function req(server: App, method: string, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

function reqBody(server: App, method: string, path: string, body: unknown): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** DELETE tetap harus mengirim content-type JSON (guard menolak selain itu). */
function del(server: App, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
    }),
  );
}

async function createSession(server: App, cwd = dir): Promise<string> {
  const created = await reqBody(server, "POST", "/api/sessions", { prompt: "Halo", cwd });
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  const id = data.session.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(server, "GET", `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
}

interface ErrorBody {
  error: string;
}

const VALID = { slug: "home", selector: "#kartu", text: "Perbesar tombol ini" };

describe("alur komentar desain", () => {
  test("GET/POST/PATCH/DELETE penuh", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/comments`;

    const empty = await req(server, "GET", base);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ comments: [], mtime: 0 });

    const created = await reqBody(server, "POST", base, VALID);
    expect(created.status).toBe(201);
    const { comment } = (await created.json()) as { comment: DesignComment };
    expect(comment.id).toMatch(/^c_[0-9a-f]{10}$/);
    expect(comment.status).toBe("open");

    const listed = await req(server, "GET", base);
    const listedBody = (await listed.json()) as { comments: DesignComment[]; mtime: number };
    expect(listedBody.comments).toHaveLength(1);
    expect(listedBody.mtime).toBeGreaterThan(0);

    const patched = await reqBody(server, "PATCH", `${base}/${comment.id}`, {
      status: "done",
      text: "Sudah diperbaiki",
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { comment: DesignComment };
    expect(patchedBody.comment.status).toBe("done");
    expect(patchedBody.comment.text).toBe("Sudah diperbaiki");

    const removed = await del(server, `${base}/${comment.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(((await (await req(server, "GET", base)).json()) as { comments: unknown[] }).comments).toEqual(
      [],
    );
  });

  test("editEnabled=false: tulis 403, GET tetap 200", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/comments`;

    expect((await req(server, "GET", base)).status).toBe(200);
    for (const res of [
      await reqBody(server, "POST", base, VALID),
      await reqBody(server, "PATCH", `${base}/c_0123456789`, { status: "done" }),
      await del(server, `${base}/c_0123456789`),
    ]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error).toBe("Penyuntingan berkas dimatikan.");
    }
  });

  test("sesi tak ada 404 dan body bukan JSON 400", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/comments`;

    expect((await req(server, "GET", "/api/sessions/s_tidakada/design/comments")).status).toBe(404);
    expect((await reqBody(server, "POST", "/api/sessions/s_tidakada/design/comments", VALID)).status).toBe(
      404,
    );
    expect(
      (await reqBody(server, "PATCH", "/api/sessions/s_tidakada/design/comments/c_0123456789", {
        status: "done",
      })).status,
    ).toBe(404);
    expect(
      (await del(server, "/api/sessions/s_tidakada/design/comments/c_0123456789")).status,
    ).toBe(404);

    expect((await reqBody(server, "POST", base, "{rusak")).status).toBe(400);
    expect((await reqBody(server, "PATCH", `${base}/c_0123456789`, "{rusak")).status).toBe(400);
    expect((await reqBody(server, "PATCH", `${base}/c_0123456789`, {})).status).toBe(400);
    expect((await reqBody(server, "PATCH", `${base}/c_ffffffffff`, { status: "done" })).status).toBe(
      404,
    );
  });

  test("tulis saat sesi berstatus berjalan tetap berhasil", async () => {
    const hanging: AgentRunner = {
      async *run() {
        await new Promise<void>(() => {});
      },
    };
    const server = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      runner: hanging,
    });
    const created = await reqBody(server, "POST", "/api/sessions", { prompt: "Halo", cwd: dir });
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    const base = `/api/sessions/${id}/design/comments`;

    expect((await reqBody(server, "POST", base, VALID)).status).toBe(201);
    expect((await req(server, "GET", base)).status).toBe(200);
    await reqBody(server, "POST", `/api/sessions/${id}/interrupt`, {});
  });

  test("audit tercatat tanpa teks komentar", async () => {
    const audit = new SqliteAuditStore(":memory:");
    try {
      const server = makeApp({}, audit);
      const id = await createSession(server);
      const base = `/api/sessions/${id}/design/comments`;

      const { comment } = (await (await reqBody(server, "POST", base, VALID)).json()) as {
        comment: DesignComment;
      };
      await reqBody(server, "PATCH", `${base}/${comment.id}`, { status: "done" });
      await del(server, `${base}/${comment.id}`);

      const entries = audit.list({ kind: "berkas", limit: 50 }).filter(
        (entry) => entry.meta.aksi === "design-comment",
      );
      expect(new Set(entries.map((entry) => entry.summary))).toEqual(
        new Set([
          "Komentar desain ditambah",
          "Komentar desain dihapus",
          "Komentar desain diubah",
        ]),
      );
      for (const entry of entries) {
        expect(JSON.stringify(entry)).not.toContain(VALID.text);
        expect(JSON.stringify(entry)).not.toContain(VALID.selector);
      }
    } finally {
      audit.close();
    }
  });

  test("stamp berubah setelah komentar ditambah", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const first = (await (await req(server, "GET", `/api/sessions/${id}/design/stamp`)).json()) as {
      stamp: string;
    };
    await reqBody(server, "POST", `/api/sessions/${id}/design/comments`, VALID);
    const second = (await (await req(server, "GET", `/api/sessions/${id}/design/stamp`)).json()) as {
      stamp: string;
    };
    expect(second.stamp).not.toBe(first.stamp);
  });
});
