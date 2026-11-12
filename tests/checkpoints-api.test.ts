import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { CheckpointService } from "../src/server/checkpoints/checkpoint-service";
import { resolveProvider as resolveRegistryProvider } from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";
import { SessionManager } from "../src/server/sessions/session-manager";

let root: string;
let work: string;
let providersFile: string;
let checkpointsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-checkpoint-api-"));
  work = await mkdtemp(join(tmpdir(), "jejak-checkpoint-api-work-"));
  checkpointsDir = await mkdtemp(join(tmpdir(), "jejak-checkpoint-api-cp-"));
  providersFile = join(root, "providers.json");
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
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await rm(checkpointsDir, { recursive: true, force: true });
});

function runner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

/** Giliran pertama selesai; giliran berikutnya menunggu sampai dihentikan. */
function hangAfterFirst(): AgentRunner {
  let calls = 0;
  return {
    async *run(input) {
      calls += 1;
      if (calls > 1) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "error", message: "dibatalkan" };
        yield { type: "result", ok: false, error: "dibatalkan" };
        return;
      }
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  manager: SessionManager;
  service?: CheckpointService;
}

function makeApp(
  options: {
    checkpoint?: boolean;
    agent?: AgentRunner;
    service?: CheckpointService;
    turnCheckpoints?: boolean;
  } = {},
): Harness {
  const service =
    options.service ??
    (options.checkpoint === false
      ? undefined
      : new CheckpointService({ root: checkpointsDir }));
  const manager = new SessionManager({
    runner: options.agent ?? runner(),
    resolveProvider: async (selection) =>
      resolveRegistryProvider(await loadRegistry(providersFile, { MOCK: "true" }), selection),
    ...(options.turnCheckpoints === true && service !== undefined ? { checkpoints: service } : {}),
  });
  const appOptions: CreateAppOptions = {
    providersPath: providersFile,
    env: { MOCK: "true" },
    sessions: manager,
    checkpointDir: options.checkpoint === false ? undefined : checkpointsDir,
  };
  if (service !== undefined) appOptions.checkpoints = service;
  return { app: createApp(appOptions), manager, service };
}

function req(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const all: Record<string, string> = { host: "127.0.0.1:3000", ...headers };
  const init: RequestInit = { method, headers: all };
  if (body !== undefined) {
    all["content-type"] = all["content-type"] ?? "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return harness.app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function session(harness: Harness): Promise<string> {
  const created = await harness.app.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd: work }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  await harness.manager.done(data.session.id);
  return data.session.id;
}

async function point(harness: Harness, id: string): Promise<string> {
  const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints`, { label: "tes" });
  expect(response.status).toBe(201);
  const data = (await response.json()) as { item: { id: string } };
  return data.item.id;
}

test("GET daftar mengembalikan enabled dan items terbaru dulu", async () => {
  const harness = makeApp();
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "a\n");
  const first = await point(harness, id);
  await writeFile(join(work, "a.txt"), "b\n");
  const second = await point(harness, id);

  const response = await req(harness, "GET", `/api/sessions/${id}/checkpoints`);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    enabled: boolean;
    items: Array<{ id: string; kind: string; label: string; files: number }>;
  };
  expect(data.enabled).toBe(true);
  expect(data.items.map((item) => item.id)).toEqual([second, first]);
  expect(data.items[0]?.kind).toBe("manual");
  expect(data.items[0]?.label).toBe("tes");
  expect(data.items[0]?.files).toBe(1);
});

test("sesi tidak ada -> 404 di semua rute", async () => {
  const harness = makeApp();
  const cid = "a".repeat(40);
  for (const [method, path] of [
    ["GET", "/api/sessions/s_deadbeef/checkpoints"],
    ["POST", "/api/sessions/s_deadbeef/checkpoints"],
    ["GET", `/api/sessions/s_deadbeef/checkpoints/${cid}/preview`],
    ["POST", `/api/sessions/s_deadbeef/checkpoints/${cid}/rewind`],
  ] as const) {
    const response = await req(harness, method, path, method === "POST" ? { confirm: true } : undefined);
    expect(response.status).toBe(404);
  }
});

test("checkpoint dimatikan -> 503 dan createApp tanpa opsi tidak menyentuh disk", async () => {
  const harness = makeApp({ checkpoint: false });
  const id = await session(harness);
  const cid = "a".repeat(40);

  for (const [method, path] of [
    ["GET", `/api/sessions/${id}/checkpoints`],
    ["POST", `/api/sessions/${id}/checkpoints`],
    ["GET", `/api/sessions/${id}/checkpoints/${cid}/preview`],
    ["POST", `/api/sessions/${id}/checkpoints/${cid}/rewind`],
  ] as const) {
    const response = await req(harness, method, path, method === "POST" ? { confirm: true } : undefined);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("Checkpoint dimatikan.");
  }
  expect(existsSync(join(checkpointsDir, id))).toBe(false);
});

test("POST titik manual saat sesi berjalan -> 409", async () => {
  const harness = makeApp({ agent: hangAfterFirst() });
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "a\n");
  await harness.manager.send(id, "lanjut");
  expect(harness.manager.get(id)?.status).toBe("berjalan");

  const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints`, {});
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toContain("Sesi sedang berjalan");
  expect(existsSync(join(checkpointsDir, id, "index.json"))).toBe(false);
  harness.manager.interrupt(id);
  await harness.manager.done(id);
});

test("label tidak valid -> 400", async () => {
  const harness = makeApp();
  const id = await session(harness);
  for (const label of ["x".repeat(81), 42, "baris\nbaru"]) {
    const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints`, { label });
    expect(response.status).toBe(400);
  }
});

test("preview menampilkan efek tanpa mengubah berkas", async () => {
  const harness = makeApp();
  const id = await session(harness);
  await writeFile(join(work, "ubah.txt"), "awal\n");
  const cid = await point(harness, id);
  await writeFile(join(work, "ubah.txt"), "baru\n");
  await writeFile(join(work, "baru.txt"), "baru\n");

  const response = await req(harness, "GET", `/api/sessions/${id}/checkpoints/${cid}/preview`);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    changes: Array<{ path: string; action: string }>;
    truncated: boolean;
  };
  expect(data.truncated).toBe(false);
  expect(data.changes).toContainEqual({ path: "ubah.txt", action: "restore" });
  expect(data.changes).toContainEqual({ path: "baru.txt", action: "remove" });
  expect(await readFile(join(work, "ubah.txt"), "utf8")).toBe("baru\n");
  expect(existsSync(join(work, "baru.txt"))).toBe(true);
});

test("cid bukan 40 heks -> 400, tidak ada di index -> 404", async () => {
  const harness = makeApp();
  const id = await session(harness);

  for (const cid of ["abc", "zz".repeat(20), "a".repeat(41)]) {
    const response = await req(harness, "GET", `/api/sessions/${id}/checkpoints/${cid}/preview`);
    expect(response.status).toBe(400);
  }
  // Traversal di URL ternormalisasi oleh router (tidak pernah sampai ke layanan).
  const traversal = await req(
    harness,
    "GET",
    `/api/sessions/${id}/checkpoints/../../etc/passwd/preview`,
  );
  expect(traversal.status).toBe(404);
  const missing = await req(harness, "GET", `/api/sessions/${id}/checkpoints/${"0".repeat(40)}/preview`);
  expect(missing.status).toBe(404);
  const rewindMissing = await req(
    harness,
    "POST",
    `/api/sessions/${id}/checkpoints/${"0".repeat(40)}/rewind`,
    { confirm: true },
  );
  expect(rewindMissing.status).toBe(404);
});

test("rewind butuh confirm true -> 400, lalu berhasil dan mengembalikan safetyId", async () => {
  const harness = makeApp();
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "awal\n");
  const cid = await point(harness, id);
  await writeFile(join(work, "a.txt"), "baru\n");

  for (const body of [undefined, {}, { confirm: false }, { confirm: "true" }]) {
    const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints/${cid}/rewind`, body ?? {});
    expect(response.status).toBe(400);
  }
  expect(await readFile(join(work, "a.txt"), "utf8")).toBe("baru\n");

  const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints/${cid}/rewind`, { confirm: true });
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    ok: boolean;
    safetyId: string;
    restored: number;
    recreated: number;
    removed: number;
  };
  expect(data.ok).toBe(true);
  expect(data.safetyId).toHaveLength(40);
  expect(data.restored).toBe(1);
  expect(data.recreated).toBe(0);
  expect(data.removed).toBe(0);
  expect(await readFile(join(work, "a.txt"), "utf8")).toBe("awal\n");
});

test("rewind saat sesi berjalan -> 409 tanpa menulis", async () => {
  const harness = makeApp({ agent: hangAfterFirst() });
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "awal\n");
  const cid = await point(harness, id);
  await writeFile(join(work, "a.txt"), "baru\n");
  await harness.manager.send(id, "lanjut");
  expect(harness.manager.get(id)?.status).toBe("berjalan");

  const response = await req(
    harness,
    "POST",
    `/api/sessions/${id}/checkpoints/${cid}/rewind`,
    { confirm: true },
  );
  expect(response.status).toBe(409);
  expect(await readFile(join(work, "a.txt"), "utf8")).toBe("baru\n");
  harness.manager.interrupt(id);
  await harness.manager.done(id);
});

test("guard Origin/Host/415 tetap berlaku pada rute checkpoint", async () => {
  const harness = makeApp();
  const id = await session(harness);

  const badHost = await req(harness, "GET", `/api/sessions/${id}/checkpoints`, undefined, {
    host: "evil.example",
  });
  expect(badHost.status).toBe(403);

  const badOrigin = await req(harness, "GET", `/api/sessions/${id}/checkpoints`, undefined, {
    origin: "https://evil.example",
  });
  expect(badOrigin.status).toBe(403);

  const created = await harness.app.handle(
    new Request(`http://127.0.0.1:3000/api/sessions/${id}/checkpoints`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "text/plain" },
      body: "{}",
    }),
  );
  expect(created.status).toBe(415);
});

test("body JSON rusak -> 400 tanpa efek samping", async () => {
  const harness = makeApp();
  const id = await session(harness);
  const response = await req(harness, "POST", `/api/sessions/${id}/checkpoints`, "{ bukan json");
  expect(response.status).toBe(400);
});

test("pesan galat tidak memuat path absolut", async () => {
  const harness = makeApp();
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "a\n");
  await point(harness, id);
  const response = await req(
    harness,
    "POST",
    `/api/sessions/${id}/checkpoints/${"b".repeat(40)}/rewind`,
    { confirm: true },
  );
  expect(response.status).toBe(404);
  const text = await response.text();
  expect(text.includes(work)).toBe(false);
  expect(text.includes(checkpointsDir)).toBe(false);
});

test("dua giliran lewat SessionManager menghasilkan titik turn 1 dan 2 di GET", async () => {
  const harness = makeApp({ turnCheckpoints: true });
  const id = await session(harness);
  await writeFile(join(work, "a.txt"), "giliran satu\n");

  await harness.manager.send(id, "giliran dua");
  await harness.manager.done(id);
  expect(harness.manager.get(id)?.status).toBe("selesai");

  const response = await req(harness, "GET", `/api/sessions/${id}/checkpoints`);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    enabled: boolean;
    items: Array<{ kind: string; turn?: number; id: string }>;
  };
  expect(data.enabled).toBe(true);
  const turns = data.items.filter((item) => item.kind === "turn");
  expect(turns.map((item) => item.turn)).toEqual([2, 1]);
  expect(turns).toHaveLength(2);
  expect(turns.every((item) => /^[0-9a-f]{40}$/.test(item.id))).toBe(true);
});
