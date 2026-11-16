import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentRunner, RunInput } from "../src/server/agent";
import {
  defaultScheduledTaskStore,
  MemoryScheduledTaskStore,
  ScheduledTaskService,
  SqliteScheduledTaskStore,
  type ScheduledTask,
  type ScheduledTaskStore,
} from "../src/server/sessions/scheduled-tasks";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const HOME = "/rumah/uji";
const PASSWORD = "sandi-uji-123";

let root: string;
let project: string;
/** Jam palsu (epoch ms) supaya jadwal bisa diuji tanpa menunggu. */
let jam = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-jadwal-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = await realpath(project);
  jam = Date.parse("2026-01-01T00:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runner palsu: satu giliran singkat per sesi. */
function runnerPalsu(): { runner: AgentRunner; inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        yield { type: "session", sessionId: `sdk-${inputs.length}` };
        yield { type: "text", text: "balasan" };
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
  store: ScheduledTaskStore = new MemoryScheduledTaskStore(),
  extra: { sweepMs?: number; maxTasks?: number } = {},
): ScheduledTaskService {
  return new ScheduledTaskService({
    manager: mgr,
    store,
    now: () => jam,
    // Sapuan manual: interval tak pernah menyala sendiri dalam tes.
    sweepMs: extra.sweepMs ?? 600_000,
    maxTasks: extra.maxTasks ?? 50,
  });
}

/** Tunggu sampai runner dipanggil sejumlah kali. */
async function tungguJalan(inputs: RunInput[], jumlah: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (inputs.length >= jumlah) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("tugas tak jalan");
}

/** Tangkap galat dari pemanggilan yang diperkirakan gagal. */
async function tangkap(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("membuat tugas terjadwal", () => {
  test("nama, jadwal, dan waktu jalan berikutnya tersimpan", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const task = await svc.create({
      name: "Tugas harian",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan tugas", cwd: project },
    });

    expect(task.id.startsWith("t_")).toBe(true);
    expect(task.id.length).toBe(10);
    expect(task.name).toBe("Tugas harian");
    expect(task.enabled).toBe(true);
    expect(task.runCount).toBe(0);
    expect(task.nextRunAt).toBe(new Date(jam + 30 * 60_000).toISOString());
    expect(svc.list()).toHaveLength(1);
    expect(svc.get(task.id)?.id).toBe(task.id);
  });

  test("nama kosong ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "   ",
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: project },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
  });

  test("nama terlalu panjang ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "x".repeat(81),
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: project },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
  });

  test("prompt kosong ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "Tugas",
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "  ", cwd: project },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
  });

  test("mode tanpa izin ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "Tugas",
        spec: { kind: "every", minutes: 30 },
        input: {
          prompt: "jalankan",
          cwd: project,
          permissionMode: "bypassPermissions",
          confirmBypass: true,
        },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).message).toBe(
      "Mode tanpa izin tidak boleh untuk tugas terjadwal.",
    );
  });

  test("konfirmasi bypass ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "Tugas",
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: project, confirmBypass: true },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
  });

  test("cwd yang salah ditolak seperti saat membuat sesi", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "Tugas",
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: join(root, "tidak-ada") },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
  });

  test("jadwal tak valid ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(
      svc.create({
        name: "Tugas",
        spec: { kind: "every", minutes: 2 },
        input: { prompt: "jalankan", cwd: project },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
  });

  test("jumlah tugas dibatasi", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner), new MemoryScheduledTaskStore(), {
      maxTasks: 2,
    });

    for (let index = 0; index < 2; index += 1) {
      await svc.create({
        name: `Tugas ${index}`,
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: project },
      });
    }
    const galat = await tangkap(
      svc.create({
        name: "Tugas ketiga",
        spec: { kind: "every", minutes: 30 },
        input: { prompt: "jalankan", cwd: project },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect(svc.list()).toHaveLength(2);
  });

  test("prompt ber rahasia disamarkan sebelum disimpan", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const task = await svc.create({
      name: "Tugas",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "pakai token ghp_abcdefghijklmnop", cwd: project },
    });
    expect(task.input.prompt).not.toContain("ghp_abcdefghijklmnop");
    expect(task.input.prompt).toContain("disembunyikan");
  });
});

describe("mengubah dan menghapus tugas", () => {
  test("nama dan jadwal bisa diubah", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Awal",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    const diubah = await svc.update(task.id, {
      name: "Baru",
      spec: { kind: "every", minutes: 60 },
    });
    expect(diubah.name).toBe("Baru");
    expect(diubah.nextRunAt).toBe(new Date(jam + 60 * 60_000).toISOString());
  });

  test("menonaktifkan tugas menghapus jadwalnya", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Awal",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    const mati = await svc.update(task.id, { enabled: false });
    expect(mati.enabled).toBe(false);
    expect(mati.nextRunAt).toBeUndefined();

    const hidup = await svc.update(task.id, { enabled: true });
    expect(hidup.enabled).toBe(true);
    expect(hidup.nextRunAt).toBe(new Date(jam + 30 * 60_000).toISOString());
  });

  test("prompt dan cwd bisa diubah", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Awal",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    const diubah = await svc.update(task.id, { input: { prompt: "prompt baru" } });
    expect(diubah.input.prompt).toBe("prompt baru");
    expect(diubah.input.cwd).toBe(project);
  });

  test("ubah id tak ada ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(svc.update("t_tidak-ada", { name: "x" }));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
  });

  test("hapus tugas menghapus dari daftar", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Awal",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    svc.delete(task.id);
    expect(svc.list()).toHaveLength(0);
    expect(svc.get(task.id)).toBeUndefined();

    const galat = await tangkap(Promise.resolve().then(() => svc.delete(task.id)));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
  });
});

describe("menjalankan tugas terjadwal", () => {
  test("sweep menjalankan tugas jatuh tempo dengan input yang sama", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan tugas", cwd: project },
    });

    jam += 6 * 60_000;
    await svc.sweep();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.prompt).toBe("jalankan tugas");
    expect(inputs[0]?.cwd).toBe(project);

    const view = svc.get(task.id);
    expect(view?.lastStatus).toBe("ok");
    expect(view?.runCount).toBe(1);
    expect(typeof view?.lastSessionId).toBe("string");
    // Sesi benar-benar ada di manajer dan judulnya nama tugas.
    const sesi = mgr.get(view!.lastSessionId!);
    expect(sesi?.title).toBe("Tugas uji");
  });

  test("jadwal berulang dimajukan setelah jalan", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });

    jam += 6 * 60_000;
    await svc.sweep();

    expect(svc.get(task.id)?.nextRunAt).toBe(new Date(jam + 5 * 60_000).toISOString());
  });

  test("tugas sekali jalan mati sesudah jalan", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Sekali",
      spec: { kind: "once", at: new Date(jam + 60_000).toISOString() },
      input: { prompt: "jalankan", cwd: project },
    });

    jam += 2 * 60_000;
    await svc.sweep();

    expect(inputs).toHaveLength(1);
    const view = svc.get(task.id);
    expect(view?.enabled).toBe(false);
    expect(view?.nextRunAt).toBeUndefined();
    expect(view?.runCount).toBe(1);
  });

  test("dua sweep serentak hanya membuat satu sesi", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });

    jam += 6 * 60_000;
    await Promise.all([svc.sweep(), svc.sweep()]);

    expect(inputs).toHaveLength(1);
  });

  test("tugas nonaktif tak dijalankan", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });
    await svc.update(task.id, { enabled: false });

    jam += 60 * 60_000;
    await svc.sweep();

    expect(inputs).toHaveLength(0);
  });

  test("gagal membuat sesi dicatat dan jadwal tetap maju", async () => {
    const { runner } = runnerPalsu();
    let panggilan = 0;
    const mgr = manager(runner, {
      resolveProvider: async () => {
        panggilan += 1;
        throw new Error("provider tak ada");
      },
    });
    const svc = layanan(mgr);
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });

    jam += 6 * 60_000;
    await svc.sweep();

    const view = svc.get(task.id);
    expect(view?.lastStatus).toBe("gagal");
    expect(view?.lastError).toContain("provider tak ada");
    expect(view?.runCount).toBe(0);
    expect(view?.nextRunAt).toBe(new Date(jam + 5 * 60_000).toISOString());
    expect(panggilan).toBe(1);
  });

  test("tugas yang terlewat lebih dari satu jam tak dijalankan", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });

    // Server mati dua jam: jadwal terlewat jauh.
    jam += 2 * 60 * 60_000;
    svc.start();
    await svc.sweep();
    svc.stop();

    expect(inputs).toHaveLength(0);
    expect(svc.get(task.id)?.nextRunAt).toBe(new Date(jam + 5 * 60_000).toISOString());
  });

  test("tugas yang terlewat tak lama dijalankan sekali", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 5 },
      input: { prompt: "jalankan", cwd: project },
    });

    // Terlewat lima menit saja: masih dalam jendela tangkapan.
    jam += 10 * 60_000;
    svc.start();
    await svc.sweep();
    await tungguJalan(inputs, 1);
    svc.stop();

    expect(inputs).toHaveLength(1);
  });

  test("runNow menjalankan tanpa menggeser jadwal", async () => {
    const { runner, inputs } = runnerPalsu();
    const svc = layanan(manager(runner));
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    const hasil = await svc.runNow(task.id);

    expect(inputs).toHaveLength(1);
    expect(hasil.lastStatus).toBe("ok");
    expect(hasil.runCount).toBe(1);
    expect(hasil.nextRunAt).toBe(new Date(jam + 30 * 60_000).toISOString());
  });

  test("runNow ditolak saat tugas sedang berjalan", async () => {
    const { runner } = runnerPalsu();
    let lepas!: () => void;
    const gerbang = new Promise<void>((resolve) => {
      lepas = resolve;
    });
    let pertama = true;
    const mgr = manager(runner, {
      resolveProvider: async (selection) => {
        if (pertama) {
          pertama = false;
          await gerbang;
        }
        return {
          profileId: "lokal",
          apiKey: "kunci",
          model: "model-uji",
          baseUrl: "https://api.provider.test/v1",
        };
      },
    });
    const svc = layanan(mgr);
    const task = await svc.create({
      name: "Tugas uji",
      spec: { kind: "every", minutes: 30 },
      input: { prompt: "jalankan", cwd: project },
    });

    const berjalan = svc.runNow(task.id);
    const galat = await tangkap(svc.runNow(task.id));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("konflik");
    expect((galat as SessionError).message).toBe("Tugas sedang berjalan.");

    lepas();
    await berjalan;
  });

  test("runNow id tak ada ditolak", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));

    const galat = await tangkap(svc.runNow("t_tidak-ada"));
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-ditemukan");
  });
});

describe("penyimpanan tugas terjadwal", () => {
  test("store SQLite menyimpan dan memuat ulang", async () => {
    const path = join(root, "schedules.db");
    const store = new SqliteScheduledTaskStore(path);
    const task: ScheduledTask = {
      id: "t_satu",
      name: "Tugas",
      input: { prompt: "jalankan", cwd: project },
      spec: { kind: "every", minutes: 30 },
      enabled: true,
      runCount: 0,
      createdAt: new Date(jam).toISOString(),
      updatedAt: new Date(jam).toISOString(),
    };
    store.save(task);
    store.close();

    const lagi = new SqliteScheduledTaskStore(path);
    const tasks = lagi.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("t_satu");
    expect(tasks[0]?.input.prompt).toBe("jalankan");
    expect(tasks[0]?.spec).toEqual({ kind: "every", minutes: 30 });

    lagi.delete("t_satu");
    expect(lagi.list()).toHaveLength(0);
    lagi.close();

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("store bawaan memakai memori bila persistensi dimatikan", () => {
    const store = defaultScheduledTaskStore({ JEJAK_PERSIST: "0" });
    expect(store).toBeInstanceOf(MemoryScheduledTaskStore);
  });
});

describe("rute tugas terjadwal", () => {
  type App = ReturnType<typeof createApp>;

  function makeApp(
    mgr: SessionManager,
    svc: ScheduledTaskService,
    auth = false,
  ): App {
    return createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      sessions: mgr,
      scheduledTasks: svc,
      ...(auth ? { auth: { password: PASSWORD, port: 3000 } } : {}),
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

  test("POST membuat tugas, GET daftar, PATCH mengubah, DELETE menghapus", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);

    const dibuat = await req(app, "POST", "/api/schedules", {
      name: "Tugas uji",
      spec: { kind: "every", minutes: 30 },
      prompt: "jalankan",
      cwd: project,
    });
    expect(dibuat.status).toBe(201);
    const body = (await dibuat.json()) as { task: ScheduledTask };
    expect(body.task.id.startsWith("t_")).toBe(true);
    expect(body.task.name).toBe("Tugas uji");

    const daftar = await req(app, "GET", "/api/schedules");
    expect(daftar.status).toBe(200);
    const isi = (await daftar.json()) as { tasks: ScheduledTask[] };
    expect(isi.tasks).toHaveLength(1);
    expect(isi.tasks[0]?.id).toBe(body.task.id);

    const diubah = await req(app, "PATCH", `/api/schedules/${body.task.id}`, {
      name: "Tugas baru",
    });
    expect(diubah.status).toBe(200);
    const isiUbah = (await diubah.json()) as { task: ScheduledTask };
    expect(isiUbah.task.name).toBe("Tugas baru");

    const hapus = await req(app, "DELETE", `/api/schedules/${body.task.id}`);
    expect(hapus.status).toBe(200);
    expect(await hapus.json()).toEqual({ ok: true });
  });

  test("POST /:id/run menjalankan tugas sekarang", async () => {
    const { runner, inputs } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);

    const dibuat = await req(app, "POST", "/api/schedules", {
      name: "Tugas uji",
      spec: { kind: "every", minutes: 30 },
      prompt: "jalankan",
      cwd: project,
    });
    const body = (await dibuat.json()) as { task: ScheduledTask };

    const jalan = await req(app, "POST", `/api/schedules/${body.task.id}/run`);
    expect(jalan.status).toBe(200);
    const isi = (await jalan.json()) as { task: ScheduledTask };
    expect(isi.task.lastStatus).toBe("ok");
    expect(inputs).toHaveLength(1);
  });

  test("POST menolak body rusak, prompt kosong, dan mode tanpa izin", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);

    const rusak = await req(app, "POST", "/api/schedules", { name: "x" });
    expect(rusak.status).toBe(400);

    const kosong = await req(app, "POST", "/api/schedules", {
      name: "Tugas",
      spec: { kind: "every", minutes: 30 },
      prompt: "  ",
      cwd: project,
    });
    expect(kosong.status).toBe(400);

    const bypass = await req(app, "POST", "/api/schedules", {
      name: "Tugas",
      spec: { kind: "every", minutes: 30 },
      prompt: "jalankan",
      cwd: project,
      permissionMode: "bypassPermissions",
      confirmBypass: true,
    });
    expect(bypass.status).toBe(400);
  });

  test("id tak dikenal menjawab 404", async () => {
    const { runner } = runnerPalsu();
    const mgr = manager(runner);
    const svc = layanan(mgr);
    const app = makeApp(mgr, svc);

    const ubah = await req(app, "PATCH", "/api/schedules/t_tidak-ada", {
      name: "x",
    });
    expect(ubah.status).toBe(404);

    const hapus = await req(app, "DELETE", "/api/schedules/t_tidak-ada");
    expect(hapus.status).toBe(404);

    const jalan = await req(app, "POST", "/api/schedules/t_tidak-ada/run");
    expect(jalan.status).toBe(404);
  });

  test("rute mengikuti aturan autentikasi yang sama", async () => {
    const { runner } = runnerPalsu();
    const svc = layanan(manager(runner));
    const app = makeApp(manager(runner), svc, true);

    const daftar = await req(app, "GET", "/api/schedules");
    expect(daftar.status).toBe(401);
  });
});
