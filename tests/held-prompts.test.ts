import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner, RunInput } from "../src/server/agent";
import {
  defaultHeldPromptStore,
  HeldPromptService,
  HELD_RESTART_MESSAGE,
  isSettled,
  MemoryHeldPromptStore,
  SqliteHeldPromptStore,
  type HeldPrompt,
  type HeldPromptStore,
} from "../src/server/sessions/held-prompts";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
  type SessionInfo,
  type SessionStatus,
} from "../src/server/sessions/session-manager";

const HOME = "/rumah/uji";
const GRACE = 1500;

let root: string;
let project: string;
/** Jam palsu (epoch ms) supaya jeda selesai bisa diuji tanpa menunggu. */
let jam = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-tahan-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = await realpath(project);
  jam = Date.parse("2026-01-01T00:00:00.000Z");
});

afterEach(async () => {
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
 * berikutnya selesai biasa (dipakai untuk sesi hasil tahanan).
 */
function runnerPalsu(): { runner: AgentRunner; inputs: RunInput[] } {
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
    now: () => new Date(jam),
    ...extra,
  });
}

function layanan(
  mgr: SessionManager,
  store: HeldPromptStore = new MemoryHeldPromptStore(),
  extra: { graceMs?: number; sweepMs?: number } = {},
): HeldPromptService {
  return new HeldPromptService({
    manager: mgr,
    store,
    now: () => jam,
    graceMs: extra.graceMs ?? GRACE,
    // Sapuan manual: interval tak pernah menyala sendiri dalam tes.
    sweepMs: extra.sweepMs ?? 600_000,
  });
}

function infoSesi(status: SessionStatus, queued: number, updatedAt: number): SessionInfo {
  const stamp = new Date(updatedAt).toISOString();
  return {
    id: "s_uji",
    title: "t",
    prompt: "p",
    cwd: project,
    profileId: "lokal",
    permissionMode: "default",
    status,
    createdAt: stamp,
    updatedAt: stamp,
    eventCount: 0,
    pendingPermissions: 0,
    queued,
  };
}

/** Tunggu sampai sesi tak berjalan dan antrean kosong. */
async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (info !== undefined && info.status !== "berjalan" && info.queued === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tak selesai");
}

/** Selesai lalu jeda waktu lewat grace. */
async function selesaiLewatJeda(mgr: SessionManager, id: string): Promise<void> {
  mgr.interrupt(id);
  await tungguSelesai(mgr, id);
  jam += GRACE + 100;
}

describe("kapan sesi selesai", () => {
  test("sesi berjalan belum selesai", () => {
    expect(isSettled(infoSesi("berjalan", 0, jam), jam, GRACE)).toBe(false);
  });

  test("antrean pesan belum kosong berarti belum selesai", () => {
    expect(isSettled(infoSesi("selesai", 1, jam), jam, GRACE)).toBe(false);
  });

  test("jeda belum lewat berarti belum selesai", () => {
    expect(isSettled(infoSesi("selesai", 0, jam), jam + GRACE - 1, GRACE)).toBe(false);
  });

  test("selesai, antrean kosong, dan jeda lewat berarti selesai", () => {
    expect(isSettled(infoSesi("selesai", 0, jam), jam + GRACE, GRACE)).toBe(true);
  });
});

describe("menahan prompt", () => {
  test("hold menolak sesi tak ada", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);

    let galat: unknown;
    try {
      svc.hold({ prompt: "halo", cwd: project }, "tidak-ada");
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
  });

  test("hold menolak sesi yang tak berjalan", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    mgr.interrupt(sesi.id);
    await tungguSelesai(mgr, sesi.id);

    let galat: unknown;
    try {
      svc.hold({ prompt: "halo", cwd: project }, sesi.id);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");
  });

  test("hold menolak prompt kosong", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    let galat: unknown;
    try {
      svc.hold({ prompt: "   ", cwd: project }, sesi.id);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
  });

  test("hold menolak lebih dari 20 tahanan menunggu", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    for (let index = 0; index < 20; index += 1) {
      svc.hold({ prompt: `tahan ${index}`, cwd: project }, sesi.id);
    }
    expect(svc.list()).toHaveLength(20);

    let galat: unknown;
    try {
      svc.hold({ prompt: "tahan 21", cwd: project }, sesi.id);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
  });

  test("hold menyimpan input dan status menunggu", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);
    expect(held.status).toBe("menunggu");
    expect(held.id.startsWith("h_")).toBe(true);
    expect(held.id.length).toBe(10);
    expect(held.waitForSessionId).toBe(sesi.id);
    expect(held.input.prompt).toBe("tahan ini");
    expect(svc.get(held.id)?.status).toBe("menunggu");
  });

  test("prompt ber rahasia disamarkan sebelum disimpan", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const held = svc.hold(
      { prompt: "pakai token ghp_abcdefghijklmnop", cwd: project },
      sesi.id,
    );
    expect(held.input.prompt).not.toContain("ghp_abcdefghijklmnop");
    expect(held.input.prompt).toContain("disembunyikan");
  });
});

describe("mengirim prompt tertahan", () => {
  test("sweep tak membuat sesi selagi sesi yang ditunggu berjalan", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    await svc.sweep();
    expect(inputs).toHaveLength(1);
    expect(svc.list()[0]?.status).toBe("menunggu");
  });

  test("setelah selesai dan jeda lewat, sesi baru dibuat dengan input sama", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    await selesaiLewatJeda(mgr, sesi.id);
    await svc.sweep();

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.prompt).toBe("tahan ini");
    const view = svc.get(held.id);
    expect(view?.status).toBe("terkirim");
    expect(typeof view?.sessionId).toBe("string");
    // Sesi baru benar-benar ada di manajer.
    expect(mgr.get(view!.sessionId!)).toBeDefined();
  });

  test("dua sweep serentak hanya membuat satu sesi", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    await selesaiLewatJeda(mgr, sesi.id);
    await Promise.all([svc.sweep(), svc.sweep()]);

    expect(inputs).toHaveLength(2);
    expect(svc.list()[0]?.status).toBe("terkirim");
  });

  test("gagal membuat sesi memberi status gagal dan pesan galat", async () => {
    const { runner } = runnerPalsu();
    let panggilan = 0;
    const mgr = manager(runner, {
      resolveProvider: async () => {
        panggilan += 1;
        if (panggilan > 1) throw new Error("provider tak ada");
        return {
          profileId: "lokal",
          apiKey: "kunci",
          model: "model-uji",
          baseUrl: "https://api.provider.test/v1",
        };
      },
    });
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    await selesaiLewatJeda(mgr, sesi.id);
    await svc.sweep();

    const view = svc.get(held.id);
    expect(view?.status).toBe("gagal");
    expect(view?.error).toContain("provider tak ada");
  });

  test("cancel mengembalikan input dan sweep tak mengirimnya", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    const batal = svc.cancel(held.id);
    expect(batal.status).toBe("dibatalkan");
    expect(batal.input.prompt).toBe("tahan ini");
    expect(svc.list()).toHaveLength(0);

    await selesaiLewatJeda(mgr, sesi.id);
    await svc.sweep();
    expect(inputs).toHaveLength(1);
  });

  test("cancel ditolak untuk tahanan yang tak menunggu", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);
    svc.cancel(held.id);

    let galat: unknown;
    try {
      svc.cancel(held.id);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
  });

  test("sesi yang ditunggu dihapus tetap dikirim", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    mgr.interrupt(sesi.id);
    await tungguSelesai(mgr, sesi.id);
    mgr.delete(sesi.id);
    jam += GRACE + 100;

    await svc.sweep();
    expect(inputs).toHaveLength(2);
    expect(svc.get(held.id)?.status).toBe("terkirim");
  });

  test("dismiss menutup tahanan yang sudah selesai", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const store = new MemoryHeldPromptStore();
    store.save({
      id: "h_kirim",
      input: { prompt: "tahan ini", cwd: project },
      waitForSessionId: "s_1",
      createdAt: new Date(jam).toISOString(),
      status: "terkirim",
      sessionId: "s_2",
    });
    const svc = layanan(mgr, store);

    expect(svc.list()).toHaveLength(1);
    svc.dismiss("h_kirim");
    expect(svc.list()).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  test("dismiss ditolak untuk tahanan yang masih menunggu", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });
    const held = svc.hold({ prompt: "tahan ini", cwd: project }, sesi.id);

    let galat: unknown;
    try {
      svc.dismiss(held.id);
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");
  });

  test("start memulihkan tahanan yang tertinggal dari proses mati", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const store = new MemoryHeldPromptStore();
    store.save({
      id: "h_mati",
      input: { prompt: "tahan ini", cwd: project },
      waitForSessionId: "s_1",
      createdAt: new Date(jam).toISOString(),
      status: "terkirim",
    });
    const svc = layanan(mgr, store);

    svc.start();
    svc.stop();

    const view = svc.get("h_mati");
    expect(view?.status).toBe("gagal");
    expect(view?.error).toBe(HELD_RESTART_MESSAGE);
  });
});

describe("penyimpanan tahanan", () => {
  test("store SQLite menyimpan dan memuat ulang", async () => {
    const path = join(root, "held.db");
    const store = new SqliteHeldPromptStore(path);
    const item: HeldPrompt = {
      id: "h_satu",
      input: { prompt: "tahan ini", cwd: project },
      waitForSessionId: "s_1",
      createdAt: new Date(jam).toISOString(),
      status: "menunggu",
    };
    store.save(item);
    store.close();

    const lagi = new SqliteHeldPromptStore(path);
    const items = lagi.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("h_satu");
    expect(items[0]?.input.prompt).toBe("tahan ini");
    expect(items[0]?.status).toBe("menunggu");

    lagi.delete("h_satu");
    expect(lagi.list()).toHaveLength(0);
    lagi.close();

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("store bawaan memakai memori bila persistensi dimatikan", () => {
    const store = defaultHeldPromptStore({ JEJAK_PERSIST: "0" });
    expect(store).toBeInstanceOf(MemoryHeldPromptStore);
  });
});

describe("rute prompt tertahan", () => {
  type App = ReturnType<typeof createApp>;

  function makeApp(mgr: SessionManager, svc: HeldPromptService): App {
    return createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      sessions: mgr,
      heldPrompts: svc,
    });
  }

  function req(
    app: App,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.handle(
      new Request(`http://127.0.0.1:3000${path}`, {
        method,
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  test("POST membuat tahanan, GET daftar, DELETE membatalkan", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const dibuat = await req(app, "POST", "/api/held-prompts", {
      waitForSessionId: sesi.id,
      prompt: "tahan ini",
      cwd: project,
    });
    expect(dibuat.status).toBe(201);
    const body = (await dibuat.json()) as { held: HeldPrompt };
    expect(body.held.status).toBe("menunggu");
    expect(body.held.input.prompt).toBe("tahan ini");

    const daftar = await req(app, "GET", "/api/held-prompts");
    expect(daftar.status).toBe(200);
    const isi = (await daftar.json()) as { held: HeldPrompt[] };
    expect(isi.held).toHaveLength(1);
    expect(isi.held[0]?.id).toBe(body.held.id);

    const hapus = await req(app, "DELETE", `/api/held-prompts/${body.held.id}`);
    expect(hapus.status).toBe(200);
    const batal = (await hapus.json()) as { held: HeldPrompt };
    expect(batal.held.status).toBe("dibatalkan");
    expect(batal.held.input.prompt).toBe("tahan ini");
  });

  test("POST menolak body rusak, sesi tak ada, dan sesi tak berjalan", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const rusak = await req(app, "POST", "/api/held-prompts", { prompt: "x" });
    expect(rusak.status).toBe(400);

    const takAda = await req(app, "POST", "/api/held-prompts", {
      waitForSessionId: "s_tidak-ada",
      prompt: "tahan ini",
      cwd: project,
    });
    expect(takAda.status).toBe(404);

    mgr.interrupt(sesi.id);
    await tungguSelesai(mgr, sesi.id);
    const takBerjalan = await req(app, "POST", "/api/held-prompts", {
      waitForSessionId: sesi.id,
      prompt: "tahan ini",
      cwd: project,
    });
    expect(takBerjalan.status).toBe(409);
  });

  test("GET tak membocorkan confirmBypass", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const dibuat = await req(app, "POST", "/api/held-prompts", {
      waitForSessionId: sesi.id,
      prompt: "tahan ini",
      cwd: project,
      permissionMode: "bypassPermissions",
      confirmBypass: true,
    });
    expect(dibuat.status).toBe(201);
    const body = (await dibuat.json()) as { held: HeldPrompt };
    expect(body.held.input.confirmBypass).toBeUndefined();

    const daftar = await req(app, "GET", "/api/held-prompts");
    const isi = (await daftar.json()) as { held: HeldPrompt[] };
    expect(isi.held[0]?.input.confirmBypass).toBeUndefined();
    expect(JSON.stringify(isi)).not.toContain("confirmBypass");
  });

  test("bypass tanpa konfirmasi ditolak", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);
    const sesi = await mgr.create({ prompt: "mulai", cwd: project });

    const ditolak = await req(app, "POST", "/api/held-prompts", {
      waitForSessionId: sesi.id,
      prompt: "tahan ini",
      cwd: project,
      permissionMode: "bypassPermissions",
    });
    expect(ditolak.status).toBe(400);
  });

  test("DELETE menutup tahanan terkirim dan menolak id tak dikenal", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const store = new MemoryHeldPromptStore();
    store.save({
      id: "h_kirim",
      input: { prompt: "tahan ini", cwd: project },
      waitForSessionId: "s_1",
      createdAt: new Date(jam).toISOString(),
      status: "terkirim",
      sessionId: "s_2",
    });
    const svc = layanan(mgr, store);
    const app = makeApp(mgr, svc);

    const tutup = await req(app, "DELETE", "/api/held-prompts/h_kirim");
    expect(tutup.status).toBe(200);
    expect(await tutup.json()).toEqual({ ok: true });

    const takAda = await req(app, "DELETE", "/api/held-prompts/h_lain");
    expect(takAda.status).toBe(404);
  });
});
