import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner, RunInput } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { FileSandboxStore } from "../src/server/sandbox/sandbox-config";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const HOME = "/rumah/uji";

let root: string;
let project: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-antrean-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = await realpath(project);
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(root, { recursive: true, force: true });
});

function waitAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      resolve();
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Runner palsu: giliran pertama ditahan sampai dibatalkan, giliran
 * berikutnya selesai biasa.
 */
function holdingRunner(): { runner: AgentRunner; inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  let call = 0;
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        const index = call++;
        yield { type: "session", sessionId: `sdk-${index}` };
        if (index === 0) {
          await waitAbort(input.signal);
          yield { type: "error", message: "dibatalkan" };
          yield { type: "result", ok: false, error: "dibatalkan" };
          return;
        }
        yield { type: "text", text: `balasan ${index}` };
        yield { type: "result", ok: true };
      },
    },
  };
}

/** Runner yang langsung selesai (sesi tak berjalan). */
function quickRunner(): { runner: AgentRunner; inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        yield { type: "session", sessionId: "sdk-0" };
        yield { type: "text", text: "halo" };
        yield { type: "result", ok: true };
      },
    },
  };
}

function manager(
  runner: AgentRunner,
  extra: Partial<SessionManagerOptions> = {},
): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async (selection) => ({
      profileId: selection.profileId ?? "lokal",
      apiKey: "kunci",
      model: "model-uji",
      baseUrl: "https://api.provider.test/v1",
    }),
    home: HOME,
    ...extra,
  });
}

/** Tunggu sampai sesi tak berjalan dan antrean kosong. */
async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (
      info !== undefined &&
      info.status !== "berjalan" &&
      (info.queuedMessages ?? []).length === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tak selesai");
}

async function eventsOf(mgr: SessionManager, id: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of mgr.events(id)) out.push(item.event);
  return out;
}

describe("antrean pesan", () => {
  test("pesan saat sesi berjalan masuk antrean dengan id dan teks", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const info = await mgr.create({ prompt: "mulai", cwd: project });

    const hasil = await mgr.send(info.id, "satu");
    expect(hasil.queued).toBe(true);

    const view = mgr.get(info.id);
    expect(view?.queued).toBe(1);
    expect(view?.queuedMessages).toHaveLength(1);
    expect(view?.queuedMessages?.[0]?.text).toBe("satu");
    expect(typeof view?.queuedMessages?.[0]?.id).toBe("string");
    expect(view?.queuedMessages?.[0]?.id.length).toBeGreaterThan(0);
  });

  test("removeQueued membuang satu pesan dan menolak id tak dikenal", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await mgr.send(info.id, "satu");
    await mgr.send(info.id, "dua");

    const pertama = mgr.get(info.id)?.queuedMessages?.[0];
    expect(pertama?.text).toBe("satu");
    mgr.removeQueued(info.id, pertama!.id);

    const view = mgr.get(info.id);
    expect(view?.queuedMessages?.map((item) => item.text)).toEqual(["dua"]);
    expect(view?.queued).toBe(1);

    let galat: unknown;
    try {
      mgr.removeQueued(info.id, "tidak-ada");
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
    expect(mgr.get(info.id)?.queuedMessages).toHaveLength(1);
  });

  test("sendQueuedNow membatalkan giliran lalu menjalankan pesan itu berikutnya", async () => {
    const { runner, inputs } = holdingRunner();
    const mgr = manager(runner);
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await mgr.send(info.id, "satu");
    await mgr.send(info.id, "dua");

    const kedua = mgr.get(info.id)?.queuedMessages?.[1];
    expect(kedua?.text).toBe("dua");
    mgr.sendQueuedNow(info.id, kedua!.id);

    await tungguSelesai(mgr, info.id);

    // Pesan yang dikirim sekarang jadi giliran berikutnya; "satu" tetap
    // antre dan jalan sesudahnya.
    expect(inputs.map((input) => input.prompt)).toEqual(["mulai", "dua", "satu"]);
    expect(mgr.get(info.id)?.queuedMessages).toBeUndefined();

    const events = await eventsOf(mgr, info.id);
    const batal = events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "result" &&
        (event as { error?: string }).error === "dibatalkan",
    );
    expect(batal).toBeDefined();
  });

  test("interrupt biasa tetap membersihkan antrean", async () => {
    const { runner, inputs } = holdingRunner();
    const mgr = manager(runner);
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await mgr.send(info.id, "satu");
    await mgr.send(info.id, "dua");

    expect(mgr.interrupt(info.id)).toBe(true);
    await tungguSelesai(mgr, info.id);

    expect(mgr.get(info.id)?.queued).toBe(0);
    expect(mgr.get(info.id)?.queuedMessages).toBeUndefined();
    expect(inputs).toHaveLength(1);
  });

  test("sendQueuedNow ditolak saat sesi tak berjalan", async () => {
    const { runner } = quickRunner();
    const mgr = manager(runner);
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, info.id);

    let galat: unknown;
    try {
      mgr.sendQueuedNow(info.id, "apa-saja");
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");
  });
});

describe("ganti sandbox saat sesi berjalan", () => {
  test("giliran berjalan dibatalkan lalu dilanjutkan dengan mode baru", async () => {
    const { runner, inputs } = holdingRunner();
    const mgr = manager(runner, {
      sandbox: { store: new FileSandboxStore(":memory:"), home: HOME },
    });
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.sandbox).toBeDefined();

    mgr.setSandbox(info.id, "mati");
    // Pesan lanjutan tak tampil di daftar antrean klien.
    expect(mgr.get(info.id)?.queuedMessages).toBeUndefined();

    await tungguSelesai(mgr, info.id);

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.prompt).toContain("Mode sandbox diganti pengguna menjadi mati");
    // Mode mati: tak ada opsi sandbox untuk giliran lanjutan.
    expect(inputs[1]?.sandbox).toBeUndefined();
  });

  test("dari mati ke standar: giliran lanjutan memakai sandbox baru", async () => {
    const { runner, inputs } = holdingRunner();
    const mgr = manager(runner, {
      sandbox: { store: new FileSandboxStore(":memory:"), home: HOME },
    });
    const info = await mgr.create({ prompt: "mulai", cwd: project, sandbox: "mati" });
    expect(inputs[0]?.sandbox).toBeUndefined();

    mgr.setSandbox(info.id, "standar");
    await tungguSelesai(mgr, info.id);

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.sandbox).toBeDefined();
  });

  test("mode yang sama tak memulai giliran baru", async () => {
    const { runner, inputs } = holdingRunner();
    const mgr = manager(runner, {
      sandbox: { store: new FileSandboxStore(":memory:"), home: HOME },
    });
    const info = await mgr.create({ prompt: "mulai", cwd: project });

    mgr.setSandbox(info.id, "standar");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs).toHaveLength(1);
    expect(mgr.get(info.id)?.status).toBe("berjalan");

    mgr.interrupt(info.id);
    await tungguSelesai(mgr, info.id);
  });

  test("ganti sandbox saat sesi tak berjalan tak memulai giliran baru", async () => {
    const { runner, inputs } = quickRunner();
    const mgr = manager(runner, {
      sandbox: { store: new FileSandboxStore(":memory:"), home: HOME },
    });
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, info.id);

    mgr.setSandbox(info.id, "mati");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs).toHaveLength(1);
    expect(mgr.get(info.id)?.sandbox).toBe("mati");
  });

  test("audit tercatat saat pindah ke mode mati", async () => {
    const audit = new SqliteAuditStore(":memory:");
    audits.push(audit);
    const { runner } = quickRunner();
    const mgr = manager(runner, {
      sandbox: { store: new FileSandboxStore(":memory:"), home: HOME },
      audit,
    });
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, info.id);

    mgr.setSandbox(info.id, "mati");
    const entries = audit.list({ session: info.id, kind: "pengaturan", limit: 50 });
    const entry = entries.find((item) => item.meta?.aksi === "sandbox-mati");
    expect(entry).toBeDefined();
  });
});

describe("rute antrean", () => {
  type App = ReturnType<typeof createApp>;

  function makeApp(mgr: SessionManager): App {
    return createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      sessions: mgr,
    });
  }

  function req(
    app: App,
    method: string,
    path: string,
  ): Promise<Response> {
    return app.handle(
      new Request(`http://127.0.0.1:3000${path}`, {
        method,
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      }),
    );
  }

  test("DELETE dan POST berjalan: 200, 404, dan 409", async () => {
    const { runner } = holdingRunner();
    const mgr = manager(runner);
    const app = makeApp(mgr);
    const info = await mgr.create({ prompt: "mulai", cwd: project });
    await mgr.send(info.id, "satu");
    await mgr.send(info.id, "dua");

    const antrean = mgr.get(info.id)?.queuedMessages ?? [];
    const idSatu = antrean[0]!.id;
    const idDua = antrean[1]!.id;

    // Id tak dikenal -> 404.
    const hapusKosong = await req(app, "DELETE", `/api/sessions/${info.id}/queue/tidak-ada`);
    expect(hapusKosong.status).toBe(404);
    const kirimKosong = await req(
      app,
      "POST",
      `/api/sessions/${info.id}/queue/tidak-ada/send-now`,
    );
    expect(kirimKosong.status).toBe(404);

    // Sesi tak ada -> 404.
    const sesiKosong = await req(app, "DELETE", "/api/sessions/tidak-ada/queue/tidak-ada");
    expect(sesiKosong.status).toBe(404);

    // Hapus satu pesan -> 200 dan antrean menyisakan satu.
    const hapus = await req(app, "DELETE", `/api/sessions/${info.id}/queue/${idSatu}`);
    expect(hapus.status).toBe(200);
    expect(await hapus.json()).toEqual({ ok: true });
    expect(mgr.get(info.id)?.queuedMessages?.map((item) => item.text)).toEqual(["dua"]);

    // Kirim sekarang -> 200.
    const kirim = await req(
      app,
      "POST",
      `/api/sessions/${info.id}/queue/${idDua}/send-now`,
    );
    expect(kirim.status).toBe(200);
    expect(await kirim.json()).toEqual({ ok: true });

    // Sesi tak berjalan -> 409.
    await tungguSelesai(mgr, info.id);
    const konflik = await req(
      app,
      "POST",
      `/api/sessions/${info.id}/queue/${idDua}/send-now`,
    );
    expect(konflik.status).toBe(409);
  });
});
