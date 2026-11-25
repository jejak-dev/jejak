import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentDef } from "../src/server/acp/agent-defs";
import { createAcpRunner, type AcpRunner } from "../src/server/acp/acp-runner";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import {
  SessionError,
  SessionManager,
  type HarnessRunner,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";
import { SqliteSessionStore } from "../src/server/sessions/session-store";

const FIXTURE = join(process.cwd(), "tests/fixtures/fake-acp-server.ts");
const HARNESS = "palsu";

const DEF: AcpAgentDef = {
  id: HARNESS,
  label: "Palsu",
  command: ["bun", FIXTURE],
  installHint: "pasang dulu",
  loginHint: "login dulu",
};

let dir: string;
const runners: AcpRunner[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-harness-"));
});

afterEach(async () => {
  for (const runner of runners.splice(0, runners.length)) runner.dispose();
  await rm(dir, { recursive: true, force: true });
});

function runnerHarness(mode: string): AcpRunner {
  const runner = createAcpRunner(DEF, { env: { FAKE_ACP_MODE: mode } });
  runners.push(runner);
  return runner;
}

/** Runner utama (sesi Claude biasa) yang langsung selesai. */
function runnerUtama(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-utama" };
      yield { type: "text", text: "utama" };
      yield { type: "result", ok: true };
    },
  };
}

function manager(
  runner: AgentRunner,
  extra: Partial<SessionManagerOptions> = {},
): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async (selection: ProviderSelection): Promise<ResolvedProvider> => ({
      profileId: selection.profileId ?? "lokal",
      apiKey: "kunci-uji",
      model: "model-uji",
    }),
    harnessRunners: { [HARNESS]: runnerHarness("multi") },
    ...extra,
  });
}

async function tungguSelesai(mgr: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const info = mgr.get(id);
    if (info !== undefined && info.status !== "berjalan") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("sesi tak selesai");
}

async function galatDari(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Id `permission_request` pertama; menunggu sampai muncul di buffer event. */
async function izinPertama(mgr: SessionManager, id: string): Promise<string> {
  const kontrol = new AbortController();
  try {
    for await (const item of mgr.events(id, { signal: kontrol.signal })) {
      if (item.event.type === "permission_request") {
        kontrol.abort();
        return item.event.id;
      }
    }
  } finally {
    kontrol.abort();
  }
  throw new Error("permission_request tidak muncul");
}

async function kumpulkan(mgr: SessionManager, id: string): Promise<AgentEvent[]> {
  const hasil: AgentEvent[] = [];
  for await (const item of mgr.events(id)) hasil.push(item.event);
  return hasil;
}

async function indukSelesai(mgr: SessionManager): Promise<string> {
  const induk = await mgr.create({ prompt: "mulai", cwd: dir });
  await tungguSelesai(mgr, induk.id);
  return induk.id;
}

describe("Sesi ber-harness", () => {
  test("harness tak terdaftar ditolak dan sesi tidak dibuat", async () => {
    const mgr = manager(runnerUtama());
    const induk = await indukSelesai(mgr);

    const galat = await galatDari(
      mgr.spawnChild(induk, { prompt: "tugas", worktree: false, harness: "tidak-ada" }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
    expect(mgr.childrenOf(induk)).toEqual([]);
    expect(mgr.list()).toHaveLength(1);
  });

  test("harness + selection ditolak; jalur harness sah tidak memanggil resolveProvider", async () => {
    const panggilan: ProviderSelection[] = [];
    const mgr = manager(runnerUtama(), {
      resolveProvider: async (selection) => {
        panggilan.push(selection);
        return { profileId: selection.profileId ?? "lokal", apiKey: "k", model: "m" };
      },
    });
    const induk = await indukSelesai(mgr);
    const sebelum = panggilan.length;

    const galat = await galatDari(
      mgr.spawnChild(induk, {
        prompt: "tugas",
        worktree: false,
        harness: HARNESS,
        selection: { model: "m" },
      }),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).code).toBe("tidak-valid");
    expect(mgr.childrenOf(induk)).toEqual([]);

    const anak = await mgr.spawnChild(induk, {
      prompt: "tugas",
      worktree: false,
      harness: HARNESS,
    });
    expect(panggilan.length).toBe(sebelum);
    await tungguSelesai(mgr, anak.id);
  });

  test("mode rich: kartu izin disetujui, event lengkap, agent menerima allow_once", async () => {
    const mgr = manager(runnerUtama(), {
      harnessRunners: { [HARNESS]: runnerHarness("rich") },
    });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "kerjakan",
      worktree: false,
      harness: HARNESS,
    });

    const requestId = await izinPertama(mgr, anak.id);
    await mgr.resolvePermission(anak.id, requestId, "allow");
    await mgr.done(anak.id);

    const info = mgr.get(anak.id);
    expect(info?.status).toBe("selesai");
    const events = await kumpulkan(mgr, anak.id);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expect(events.some((event) => event.type === "permission_request")).toBe(true);
    const teks = events
      .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(teks).toContain("dipilih:ya-sekali");
    expect(events.some((event) => event.type === "result" && event.ok)).toBe(true);
  });

  test("sesi ber-harness diawali peringatan bahwa sandbox dan pelindung rahasia tak berlaku", async () => {
    const mgr = manager(runnerUtama(), {
      harnessRunners: { [HARNESS]: runnerHarness("multi") },
    });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, { prompt: "kerjakan", worktree: false, harness: HARNESS });
    await mgr.done(anak.id);
    const events = await kumpulkan(mgr, anak.id);
    const peringatan = events.find((event) => event.type === "notice" && event.level === "warn");
    expect(peringatan).toBeDefined();
    expect(peringatan?.type === "notice" ? peringatan.text : "").toContain("sandbox");
    // Sesi Claude biasa tidak mendapat peringatan itu.
    const biasa = await kumpulkan(mgr, induk);
    expect(biasa.some((event) => event.type === "notice" && event.text.includes("Agent eksternal"))).toBe(false);
  });

  test("mode rich: izin ditolak -> agent menerima reject_once", async () => {
    const mgr = manager(runnerUtama(), {
      harnessRunners: { [HARNESS]: runnerHarness("rich") },
    });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "kerjakan",
      worktree: false,
      harness: HARNESS,
    });

    const requestId = await izinPertama(mgr, anak.id);
    await mgr.resolvePermission(anak.id, requestId, "deny");
    await mgr.done(anak.id);

    const events = await kumpulkan(mgr, anak.id);
    const teks = events
      .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(teks).toContain("dipilih:tidak");
  });

  test("mode multi: pesan kedua memakai proses agent yang sama", async () => {
    const mgr = manager(runnerUtama(), {
      harnessRunners: { [HARNESS]: runnerHarness("multi") },
    });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "satu",
      worktree: false,
      harness: HARNESS,
    });
    await tungguSelesai(mgr, anak.id);

    const teksDari = (events: AgentEvent[]): string =>
      events
        .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
        .map((event) => event.text)
        .join("");
    const pidDari = (teks: string): string => /giliran-\d+:(\d+)/.exec(teks)?.[1] ?? "";
    const pertama = pidDari(teksDari(await kumpulkan(mgr, anak.id)));
    expect(pertama).not.toBe("");

    expect(await mgr.send(anak.id, "dua")).toEqual({ queued: false });
    await tungguSelesai(mgr, anak.id);
    const teksKedua = teksDari(await kumpulkan(mgr, anak.id));
    expect(teksKedua).toContain("giliran-2");
    expect(pidDari(teksKedua)).toBe(pertama);
  });

  test("mode bypassPermissions pada create ber-harness ditolak", async () => {
    const mgr = manager(runnerUtama());
    const galat = await galatDari(
      mgr.create(
        {
          prompt: "bypass",
          cwd: dir,
          permissionMode: "bypassPermissions",
          confirmBypass: true,
        },
        { harness: HARNESS },
      ),
    );
    expect(galat).toBeInstanceOf(SessionError);
    expect((galat as SessionError).message).toBe("Agent eksternal tidak mendukung mode bypass.");
    expect(mgr.list()).toEqual([]);
  });

  test("setProvider, aside, rewind, dan mode Goal ditolak", async () => {
    const mgr = manager(runnerUtama());
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "tugas",
      worktree: false,
      harness: HARNESS,
    });
    await tungguSelesai(mgr, anak.id);

    for (const janji of [
      mgr.setProvider(anak.id, { profileId: "lain", model: "m" }),
      mgr.askAside(anak.id, "tanya"),
      mgr.rewindConversation(anak.id, 1),
    ]) {
      const galat = await galatDari(janji);
      expect(galat).toBeInstanceOf(SessionError);
      expect((galat as SessionError).message).toBe(
        "Fitur ini tidak tersedia untuk sesi agent eksternal.",
      );
      expect((galat as SessionError).code).toBe("tidak-valid");
    }

    expect(() => mgr.startGoal(anak.id, { objective: "tujuan" })).toThrow(
      "Fitur ini tidak tersedia untuk sesi agent eksternal.",
    );
  });

  test("hapus sesi ber-harness memanggil release runner", async () => {
    const dirilis: string[] = [];
    const runner: HarnessRunner = {
      async *run() {
        yield { type: "session", sessionId: "acp-hapus" };
        yield { type: "result", ok: true };
      },
      release: (id) => {
        dirilis.push(id);
      },
    };
    const mgr = manager(runnerUtama(), { harnessRunners: { uji: runner } });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "tugas",
      worktree: false,
      harness: "uji",
    });
    await tungguSelesai(mgr, anak.id);

    mgr.delete(anak.id);
    expect(dirilis).toEqual(["acp-hapus"]);
  });

  test("info menyimpan harness; pemulihan dari store tidak memanggil resolveProvider", async () => {
    const path = join(dir, "sesi.db");
    const store = new SqliteSessionStore(path);
    const mgr = manager(runnerUtama(), { store });
    const induk = await indukSelesai(mgr);
    const anak = await mgr.spawnChild(induk, {
      prompt: "tugas",
      worktree: false,
      harness: HARNESS,
    });
    await tungguSelesai(mgr, anak.id);
    expect(mgr.get(anak.id)?.harness).toBe(HARNESS);
    expect(mgr.get(anak.id)?.profileId).toBe(HARNESS);
    expect(mgr.get(anak.id)?.model).toBeUndefined();
    store.close();

    const panggilan: ProviderSelection[] = [];
    const kedua = new SqliteSessionStore(path);
    const pulih = new SessionManager({
      runner: runnerUtama(),
      harnessRunners: { [HARNESS]: runnerHarness("multi") },
      store: kedua,
      resolveProvider: async (selection) => {
        panggilan.push(selection);
        return { profileId: selection.profileId ?? "lokal", apiKey: "k", model: "m" };
      },
    });
    expect(pulih.get(anak.id)?.harness).toBe(HARNESS);
    expect(panggilan).toEqual([]);

    expect(await pulih.send(anak.id, "lanjut")).toEqual({ queued: false });
    await tungguSelesai(pulih, anak.id);
    expect(panggilan).toEqual([]);
    kedua.close();
  });
});
