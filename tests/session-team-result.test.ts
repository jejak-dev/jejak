import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunInput } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { SqliteUsageLedger } from "../src/server/budget/usage-ledger";
import { WorktreeService } from "../src/server/git/worktree-service";
import {
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const HOME = "/rumah/uji";

let root: string;
let project: string;
const audits: AuditStore[] = [];
const ledgers: SqliteUsageLedger[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-hasil-tim-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  project = await realpath(project);
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  for (const ledger of ledgers.splice(0)) ledger.close();
  await rm(root, { recursive: true, force: true });
});

function waitAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Gerbang untuk melepas giliran yang ditahan tanpa membatalkannya. */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Runner dengan perilaku per prompt: prompt yang memuat `holdMarker` ditahan
 * sampai dibatalkan atau gerbang dilepas; sisanya langsung selesai.
 * `onSteer` menghitung pemakaian jalur steering.
 */
function runnerFor(options: {
  holdMarker?: string;
  gate?: { promise: Promise<void> };
  answer?: (prompt: string) => string;
  onSteer?: () => void;
}): { runner: AgentRunner; inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        input.registerSteer?.(() => {
          options.onSteer?.();
          return true;
        });
        yield { type: "session", sessionId: `sdk-${inputs.length}` };
        if (options.holdMarker !== undefined && input.prompt.includes(options.holdMarker)) {
          const hasil = await Promise.race([
            waitAbort(input.signal).then(() => "batal" as const),
            options.gate === undefined
              ? new Promise<never>(() => {})
              : options.gate.promise.then(() => "lepas" as const),
          ]);
          if (hasil === "batal") {
            yield { type: "error", message: "dibatalkan" };
            yield { type: "result", ok: false, error: "dibatalkan" };
            return;
          }
        }
        const teks = options.answer?.(input.prompt) ?? "selesai";
        yield { type: "text", text: teks };
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
    team: { notifyWindowMs: 5 },
    ...extra,
  });
}

async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (info !== undefined && info.status !== "berjalan") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sesi tak selesai");
}

async function tunggu(predicate: () => boolean, pesan = "kondisi tak tercapai"): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(pesan);
}

/** Tunggu sampai hasil anak tersimpan di record anak. */
/** Giliran milik induk saja (prompt anak selalu diawali "tugas"). */
function hanyaInduk(inputs: RunInput[]): RunInput[] {
  return inputs.filter((input) => !input.prompt.startsWith("tugas"));
}

async function tungguHasil(mgr: SessionManager, childId: string): Promise<void> {
  await tunggu(() => mgr.get(childId)?.team?.result !== undefined, "hasil anak tak tersimpan");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal: ${err}`);
  return out;
}

async function initRepo(): Promise<void> {
  await git(project, ["init", "-q", "-b", "main"]);
  await git(project, ["config", "user.name", "t"]);
  await git(project, ["config", "user.email", "t@t"]);
  await writeFile(join(project, "awal.txt"), "awal\n");
  await git(project, ["add", "-A"]);
  await git(project, ["commit", "-q", "-m", "awal"]);
}

function worktreeService(): WorktreeService {
  return new WorktreeService({ root: join(root, "worktrees") });
}

describe("finalizeChild: team.result", () => {
  test("hasil tersimpan dengan status, ringkasan tersamar, dan finishedAt", async () => {
    const { runner } = runnerFor({
      answer: () => "pakai sk-abcdefgh1234 untuk selesai",
    });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguHasil(mgr, anak.id);

    const hasil = mgr.get(anak.id)?.team?.result;
    expect(hasil?.status).toBe("selesai");
    expect(hasil?.summary).toContain("selesai");
    expect(hasil?.summary).not.toContain("sk-abcdefgh1234");
    expect(hasil?.finishedAt).toBeString();
    // Tanpa harga model dan tanpa ledger: biaya dan berkas kosong.
    expect(hasil?.costUsd).toBeUndefined();
    expect(hasil?.changedFiles).toBeUndefined();
    await tungguSelesai(mgr, induk.id);
  });

  test("biaya terisi bila harga model dan ledger ada", async () => {
    const ledger = new SqliteUsageLedger(":memory:");
    ledgers.push(ledger);
    const { runner } = runnerFor({});
    const mgr = manager(runner, {
      resolveProvider: async (selection) => ({
        profileId: selection.profileId ?? "lokal",
        apiKey: "kunci",
        model: "model-uji",
        price: { input: 1, output: 2 },
      }),
      budget: { ledger, store: { get: () => ({ warnAt: 0.8 }), set: () => undefined } },
    });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguSelesai(mgr, anak.id);
    ledger.record({
      ts: new Date().toISOString(),
      sessionId: anak.id,
      profileId: "lokal",
      costUsd: 0.5,
    });
    await tungguHasil(mgr, anak.id);

    expect(mgr.get(anak.id)?.team?.result?.costUsd).toBe(0.5);
    await tungguSelesai(mgr, induk.id);
  });

  test("perubahan berkas di worktree anak tercatat belum dikomit", async () => {
    await initRepo();
    // Runner menulis berkas hanya di cwd anak (worktree), bukan folder induk.
    const writer: AgentRunner = {
      async *run(input) {
        yield { type: "session", sessionId: "sdk-x" };
        if (input.cwd !== project) await writeFile(join(input.cwd, "baru.txt"), "isi\n");
        yield { type: "text", text: "selesai" };
        yield { type: "result", ok: true };
      },
    };
    const mgr = manager(writer, { worktrees: worktreeService() });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas", worktree: true });
    await tungguHasil(mgr, anak.id);

    const hasil = mgr.get(anak.id)?.team?.result;
    expect(hasil?.changedFiles).toBe(1);
    expect(hasil?.changedPaths).toEqual(["baru.txt"]);
    expect(hasil?.uncommitted).toBe(true);
    expect(hasil?.branch).toBe(mgr.get(anak.id)?.worktree?.branch);
    await tungguSelesai(mgr, induk.id);
  });

  test("cwd non-git: tanpa field berkas, tanpa galat", async () => {
    const { runner } = runnerFor({});
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguHasil(mgr, anak.id);

    const hasil = mgr.get(anak.id)?.team?.result;
    expect(hasil).toBeDefined();
    expect(hasil?.changedFiles).toBeUndefined();
    expect(hasil?.changedPaths).toBeUndefined();
    expect(hasil?.uncommitted).toBeUndefined();
    await tungguSelesai(mgr, induk.id);
  });

  test("audit team-selesai tercatat pada induk", async () => {
    const audit = new SqliteAuditStore(":memory:");
    audits.push(audit);
    const { runner } = runnerFor({});
    const mgr = manager(runner, { audit });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas" });
    await tungguHasil(mgr, anak.id);
    await tunggu(() =>
      audit
        .list({ session: induk.id, kind: "pengaturan", limit: 50 })
        .some((entry) => entry.meta?.aksi === "team-selesai" && entry.meta?.anak === anak.id),
    );
    await tungguSelesai(mgr, induk.id);
  });
});

describe("pemberitahuan ke induk", () => {
  test("induk berjalan: catatan masuk antrean hidden, bukan steering", async () => {
    let steered = 0;
    const gate = makeGate();
    const { runner, inputs } = runnerFor({
      holdMarker: "MULAI-INDUK",
      gate,
      onSteer: () => {
        steered += 1;
      },
    });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "MULAI-INDUK", cwd: project });
    await tunggu(() => inputs.length === 1);

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);
    await tunggu(() => (mgr.get(induk.id)?.queued ?? 0) > 0, "antrean induk tetap kosong");

    // Entri hidden tak tampil di daftar antrean klien dan tak lewat steering.
    expect(mgr.get(induk.id)?.queuedMessages).toBeUndefined();
    expect(steered).toBe(0);

    // Giliran induk selesai: entri hidden jadi giliran baru berlabel sistem.
    gate.release();
    await tunggu(() => hanyaInduk(inputs).length === 2, "giliran lanjutan tak dimulai");
    expect(hanyaInduk(inputs)[1]?.prompt).toContain("Laporan anak");
    expect(hanyaInduk(inputs)[1]?.prompt).toContain(anak.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("induk menganggur: pemberitahuan memulai giliran baru otomatis", async () => {
    const { runner, inputs } = runnerFor({});
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    expect(inputs).toHaveLength(1);

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tunggu(() => hanyaInduk(inputs).length >= 2, "giliran induk baru tak dimulai");
    const indukInput = hanyaInduk(inputs)[1]!;
    expect(indukInput.prompt).toContain("Laporan anak");
    expect(indukInput.prompt).toContain(anak.id);
    await tungguHasil(mgr, anak.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("dua anak berdekatan digabung; anak ketiga sesudahnya jadi pesan kedua", async () => {
    const { runner, inputs } = runnerFor({});
    const mgr = manager(runner, { team: { notifyWindowMs: 50 } });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);

    const satu = await mgr.spawnChild(induk.id, { prompt: "tugas satu" });
    const dua = await mgr.spawnChild(induk.id, { prompt: "tugas dua" });
    await tungguHasil(mgr, satu.id);
    await tungguHasil(mgr, dua.id);
    await tunggu(() => hanyaInduk(inputs).length >= 2, "pesan gabungan tak terkirim");
    const pesanPertama = hanyaInduk(inputs)[1]!.prompt;
    expect(pesanPertama).toContain(satu.id);
    expect(pesanPertama).toContain(dua.id);

    await tungguSelesai(mgr, induk.id);
    const tiga = await mgr.spawnChild(induk.id, { prompt: "tugas tiga" });
    await tungguHasil(mgr, tiga.id);
    await tunggu(() => hanyaInduk(inputs).length >= 3, "pesan kedua tak terkirim");
    expect(hanyaInduk(inputs)[2]!.prompt).toContain(tiga.id);
    expect(hanyaInduk(inputs)[2]!.prompt).not.toContain(satu.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("induk dibatalkan: tidak ada giliran baru, hasil anak tetap tersimpan", async () => {
    const { runner, inputs } = runnerFor({ holdMarker: "MULAI-INDUK" });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "MULAI-INDUK", cwd: project });
    await tunggu(() => inputs.length === 1);

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hanyaInduk(inputs)).toHaveLength(1);
    expect(mgr.get(anak.id)?.team?.result).toBeDefined();
  });

  test("induk dihapus: tidak ada galat dan anak dilepas", async () => {
    const { runner } = runnerFor({ holdMarker: "MULAI-INDUK" });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "MULAI-INDUK", cwd: project });
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
    mgr.delete(induk.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mgr.get(anak.id)?.team).toBeUndefined();
  });

  test("antrean induk penuh: catatan dibuang tanpa melempar", async () => {
    const { runner, inputs } = runnerFor({ holdMarker: "MULAI-INDUK" });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "MULAI-INDUK", cwd: project });
    await tunggu(() => inputs.length === 1);

    for (let index = 0; index < 5; index += 1) await mgr.send(induk.id, `pesan ${index}`);

    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Antrean tetap penuh (catatan dibuang), tak ada galat.
    expect(mgr.get(induk.id)?.queued).toBe(5);
    expect(mgr.get(anak.id)?.team?.result).toBeDefined();

    mgr.interrupt(induk.id);
    await tungguSelesai(mgr, induk.id);
  });

  test("kapasitas penuh saat induk menganggur: diulang lalu dibuang tanpa melempar", async () => {
    const { runner } = runnerFor({ holdMarker: "TAHAN" });
    const mgr = manager(runner, { maxConcurrent: 4, team: { notifyWindowMs: 100 } });
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);

    // Tiga sesi penahan + satu anak yang cepat selesai.
    const penahan = [
      await mgr.create({ prompt: "TAHAN", cwd: project }),
      await mgr.create({ prompt: "TAHAN", cwd: project }),
      await mgr.create({ prompt: "TAHAN", cwd: project }),
    ];
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);

    // Isi kapasitas sebelum jendela pemberitahuan habis.
    penahan.push(await mgr.create({ prompt: "TAHAN", cwd: project }));
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Tak ada giliran baru pada induk; hasil tetap tersimpan.
    expect(mgr.get(induk.id)?.status).toBe("selesai");
    expect(mgr.get(anak.id)?.team?.result).toBeDefined();

    for (const item of penahan) mgr.interrupt(item.id);
  });
});

describe("giliran lanjutan anak", () => {
  test("hasil tidak prematur di tengah; hasil baru menimpa saat berhenti lagi", async () => {
    const { runner } = runnerFor({ answer: (prompt) => `jawaban: ${prompt.slice(0, 20)}` });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas awal" });
    await tungguHasil(mgr, anak.id);
    const pertama = mgr.get(anak.id)?.team?.result?.summary;
    expect(pertama).toContain("tugas awal");

    // Giliran lanjutan: hasil lama tetap sampai giliran berikutnya berhenti.
    await mgr.send(anak.id, "tugas lanjutan");
    expect(mgr.get(anak.id)?.team?.result?.summary).toBe(pertama);
    await tungguSelesai(mgr, anak.id);
    await tunggu(
      () => mgr.get(anak.id)?.team?.result?.summary !== pertama,
      "hasil lanjutan tak menimpa",
    );
    expect(mgr.get(anak.id)?.team?.result?.summary).toContain("tugas lanjutan");
    await tungguSelesai(mgr, induk.id);
  });

  test("childReport menampilkan berjalan selama sesi jalan", async () => {
    const { runner } = runnerFor({ holdMarker: "TAHAN-ANAK" });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "mulai", cwd: project });
    await tungguSelesai(mgr, induk.id);
    const anak = await mgr.spawnChild(induk.id, { prompt: "TAHAN-ANAK" });
    await tunggu(() => mgr.get(anak.id)?.status === "berjalan");
    expect(mgr.childReport(induk.id, anak.id)).toEqual({ status: "berjalan" });

    mgr.interrupt(anak.id);
    await tungguSelesai(mgr, anak.id);
    await tungguSelesai(mgr, induk.id);
  });
});

describe("regresi bug antrean hidden", () => {
  test("entri hidden tampil sebagai notice dan teksnya jadi prompt runner", async () => {
    const gate = makeGate();
    const { runner, inputs } = runnerFor({ holdMarker: "MULAI-INDUK", gate });
    const mgr = manager(runner);
    const induk = await mgr.create({ prompt: "MULAI-INDUK", cwd: project });
    await tunggu(() => inputs.length === 1);

    // Anak selesai -> catatan masuk antrean hidden induk.
    const anak = await mgr.spawnChild(induk.id, { prompt: "tugas anak" });
    await tungguHasil(mgr, anak.id);
    await tunggu(() => (mgr.get(induk.id)?.queued ?? 0) > 0, "antrean induk tetap kosong");

    // Giliran induk selesai: pesan hidden jadi giliran berikutnya.
    gate.release();
    await tunggu(() => hanyaInduk(inputs).length === 2, "giliran lanjutan tak dimulai");
    expect(hanyaInduk(inputs)[1]?.prompt).toContain("Laporan anak");

    // Event giliran lanjutan berlabel `notice`, bukan `user_message`.
    const kumpulan: Array<{ type: string; text?: string }> = [];
    for await (const item of mgr.events(induk.id)) kumpulan.push(item.event);
    expect(
      kumpulan.some((event) => event.type === "notice" && event.text?.includes("Laporan anak")),
    ).toBe(true);
    expect(
      kumpulan.some(
        (event) => event.type === "user_message" && event.text?.includes("Laporan anak"),
      ),
    ).toBe(false);
    await tungguSelesai(mgr, induk.id);
  });
});
