import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import type { GoalView } from "../src/server/goals/goal";
import {
  DESKTOP_COMMANDS,
  createUpdaterClient,
  desktopBridge,
  desktopErrorMessage,
  downloadPercent,
  lastCheckText,
  parseUpdaterSettings,
  parseUpdaterStatus,
  restartWarning,
  updaterStatusLine,
  type DesktopBridge,
  type UpdaterStatus,
} from "../src/client/lib/desktop";

function sesi(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Sesi satu",
    prompt: "",
    cwd: "/tmp/jejak",
    profileId: "p1",
    permissionMode: "default",
    status: "berjalan",
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    eventCount: 0,
    pendingPermissions: 0,
    queued: 0,
    ...overrides,
  };
}

function tujuanAktif(): GoalView {
  return {
    id: "g1",
    objective: "Selesaikan pekerjaan",
    status: "active",
    maxTurns: 10,
    autoTurns: 1,
    idleTurns: 0,
    startedAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
}

/** Jembatan tiruan: peta perintah ke balasan atau penolakan. */
function jembatan(
  table: Record<string, unknown | (() => unknown)>,
): DesktopBridge & { calls: { cmd: string; args: unknown }[] } {
  const calls: { cmd: string; args: unknown }[] = [];
  return {
    calls,
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ cmd, args });
      const entry = table[cmd];
      if (entry === undefined) throw new Error(`perintah tak dikenal: ${cmd}`);
      if (typeof entry === "function") {
        return (entry as () => unknown)() as T;
      }
      return entry as T;
    },
  };
}

describe("desktopBridge", () => {
  test("tidak ada di peramban biasa", () => {
    const scope = globalThis as { __TAURI_INTERNALS__?: unknown };
    delete scope.__TAURI_INTERNALS__;
    expect(desktopBridge()).toBeUndefined();
  });

  test("ada bila invoke tersedia", async () => {
    const scope = globalThis as { __TAURI_INTERNALS__?: unknown };
    scope.__TAURI_INTERNALS__ = { invoke: async () => "ok" };
    try {
      const bridge = desktopBridge();
      expect(bridge).toBeDefined();
      expect(await bridge!.invoke<string>("desktop_info")).toBe("ok");
    } finally {
      delete scope.__TAURI_INTERNALS__;
    }
  });

  test("tanpa fungsi invoke tidak ada jembatan", () => {
    const scope = globalThis as { __TAURI_INTERNALS__?: unknown };
    scope.__TAURI_INTERNALS__ = { invoke: "bukan fungsi" };
    try {
      expect(desktopBridge()).toBeUndefined();
    } finally {
      delete scope.__TAURI_INTERNALS__;
    }
  });
});

describe("parseUpdaterStatus", () => {
  test("bentuk asing menjadi idle", () => {
    expect(parseUpdaterStatus(undefined)).toEqual({ state: "idle" });
    expect(parseUpdaterStatus("teks")).toEqual({ state: "idle" });
    expect(parseUpdaterStatus({ state: "entah" })).toEqual({ state: "idle" });
    expect(parseUpdaterStatus({})).toEqual({ state: "idle" });
  });

  test("bentuk dikenal mempertahankan isinya", () => {
    const status = parseUpdaterStatus({
      state: "available",
      version: "0.0.2",
      notes: "Perbaikan",
      date: "2026-11-14",
    });
    expect(status).toEqual({
      state: "available",
      version: "0.0.2",
      notes: "Perbaikan",
      date: "2026-11-14",
    });
  });

  test("angka negatif dan NaN dibuang", () => {
    const status = parseUpdaterStatus({
      state: "downloading",
      downloaded: -5,
      total: Number.NaN,
      lastCheck: -1,
    });
    expect(status).toEqual({ state: "downloading" });
    expect(status.downloaded).toBeUndefined();
    expect(status.total).toBeUndefined();
    expect(status.lastCheck).toBeUndefined();
  });

  test("nilai yang bukan angka dibuang", () => {
    const status = parseUpdaterStatus({ state: "downloading", downloaded: "42", total: true });
    expect(status.downloaded).toBeUndefined();
    expect(status.total).toBeUndefined();
  });
});

describe("updaterStatusLine", () => {
  test("idle berarti sudah terbaru", () => {
    expect(updaterStatusLine({ state: "idle" })).toBe("Terbaru");
  });

  test("menyebut versi yang tersedia", () => {
    expect(updaterStatusLine({ state: "available", version: "0.0.2" })).toBe(
      "Pembaruan 0.0.2 tersedia",
    );
  });

  test("menyebut persen unduhan", () => {
    const status: UpdaterStatus = { state: "downloading", downloaded: 42, total: 100 };
    expect(updaterStatusLine(status)).toBe("Mengunduh 42%");
  });

  test("unduhan tanpa total hanya menyebut mengunduh", () => {
    expect(updaterStatusLine({ state: "downloading", downloaded: 42 })).toBe("Mengunduh…");
  });

  test("memasang dan siap dimulai ulang", () => {
    expect(updaterStatusLine({ state: "installing" })).toBe("Memasang…");
    expect(updaterStatusLine({ state: "ready" })).toBe("Siap dimulai ulang");
  });

  test("galat disebut apa adanya", () => {
    expect(updaterStatusLine({ state: "error", error: "jaringan putus" })).toBe(
      "Gagal: jaringan putus",
    );
  });
});

describe("downloadPercent", () => {
  test("menghitung persen", () => {
    expect(downloadPercent({ state: "downloading", downloaded: 25, total: 100 })).toBe(25);
    expect(downloadPercent({ state: "downloading", downloaded: 1, total: 3 })).toBe(33);
  });

  test("dibatasi 0 sampai 100", () => {
    expect(downloadPercent({ state: "downloading", downloaded: 500, total: 100 })).toBe(100);
    expect(downloadPercent({ state: "downloading", downloaded: 0, total: 100 })).toBe(0);
  });

  test("total tak diketahui tidak ada persen", () => {
    expect(downloadPercent({ state: "downloading", downloaded: 42 })).toBeUndefined();
    expect(downloadPercent({ state: "downloading", downloaded: 42, total: 0 })).toBeUndefined();
  });
});

describe("lastCheckText", () => {
  const now = 1_800_000_000;

  test("belum pernah bila tak ada pemeriksaan", () => {
    expect(lastCheckText(undefined, now)).toBe("belum pernah");
    expect(lastCheckText(0, now)).toBe("belum pernah");
  });

  test("baru saja di bawah satu menit", () => {
    expect(lastCheckText(now - 10, now)).toBe("baru saja");
  });

  test("menyebut jumlah menit", () => {
    expect(lastCheckText(now - 300, now)).toBe("5 menit lalu");
  });

  test("menyebut jumlah jam", () => {
    expect(lastCheckText(now - 7200, now)).toBe("2 jam lalu");
  });

  test("lebih dari sehari memakai tanggal", () => {
    const lalu = now - 3 * 86400;
    const teks = lastCheckText(lalu, now);
    const tanggal = new Date(lalu * 1000);
    expect(teks).toContain(String(tanggal.getFullYear()));
    expect(teks).not.toContain("lalu");
  });
});

describe("restartWarning", () => {
  test("tanpa sesi berjalan tak ada peringatan", () => {
    expect(restartWarning([])).toBeUndefined();
    expect(restartWarning([sesi({ status: "selesai" })])).toBeUndefined();
    expect(
      restartWarning([sesi({ status: "selesai", goal: { ...tujuanAktif(), status: "paused" } })]),
    ).toBeUndefined();
  });

  test("menyebut jumlah sesi berjalan", () => {
    const peringatan = restartWarning([sesi({ status: "berjalan" })]);
    expect(peringatan).toBeDefined();
    expect(peringatan).toContain("1 sesi sedang berjalan");
  });

  test("menyebut jumlah tujuan aktif", () => {
    const peringatan = restartWarning([
      sesi({ status: "selesai", goal: tujuanAktif() }),
    ]);
    expect(peringatan).toBeDefined();
    expect(peringatan).toContain("1 tujuan aktif");
  });

  test("sesi berjalan dan tujuan aktif dihitung terpisah", () => {
    const peringatan = restartWarning([
      sesi({ id: "s1", status: "berjalan" }),
      sesi({ id: "s2", status: "berjalan" }),
      sesi({ id: "s3", status: "selesai", goal: tujuanAktif() }),
    ]);
    expect(peringatan).toContain("2 sesi sedang berjalan");
    expect(peringatan).toContain("1 tujuan aktif");
  });
});

describe("createUpdaterClient", () => {
  test("memetakan perintah sesuai kontrak", async () => {
    const bridge = jembatan({
      [DESKTOP_COMMANDS.info]: { version: "1.2.3", platform: "macos" },
      [DESKTOP_COMMANDS.getSettings]: { autoCheck: true, channel: "stable" },
      [DESKTOP_COMMANDS.setSettings]: { autoCheck: false, channel: "beta" },
      [DESKTOP_COMMANDS.check]: { state: "available", version: "1.2.4" },
      [DESKTOP_COMMANDS.status]: { state: "idle" },
      [DESKTOP_COMMANDS.install]: null,
      [DESKTOP_COMMANDS.restart]: null,
    });
    const client = createUpdaterClient(bridge);

    expect(await client.info()).toEqual({ version: "1.2.3", platform: "macos" });
    expect(await client.getSettings()).toEqual({ autoCheck: true, channel: "stable" });
    expect(await client.setSettings({ autoCheck: false, channel: "beta" })).toEqual({
      autoCheck: false,
      channel: "beta",
    });
    expect(await client.check()).toEqual({ state: "available", version: "1.2.4" });
    expect(await client.status()).toEqual({ state: "idle" });
    expect(await client.install()).toBeUndefined();
    expect(await client.restart()).toBeUndefined();

    const setCall = bridge.calls.find((call) => call.cmd === DESKTOP_COMMANDS.setSettings);
    expect(setCall?.args).toEqual({ autoCheck: false, channel: "beta" });
  });

  test("penolakan perintah jadi Error dengan pesan string", async () => {
    const bridge = jembatan({
      [DESKTOP_COMMANDS.check]: () => {
        throw "jaringan tidak ada";
      },
    });
    const client = createUpdaterClient(bridge);
    await expect(client.check()).rejects.toThrow("jaringan tidak ada");
  });

  test("bentuk hasil asing ditolak", async () => {
    const bridge = jembatan({
      [DESKTOP_COMMANDS.info]: { versi: "1.0" },
      [DESKTOP_COMMANDS.getSettings]: { autoCheck: "ya", channel: "stabil" },
    });
    const client = createUpdaterClient(bridge);
    await expect(client.info()).rejects.toThrow();
    await expect(client.getSettings()).rejects.toThrow();
  });

  test("status asing dibaca sebagai idle", async () => {
    const bridge = jembatan({
      [DESKTOP_COMMANDS.status]: { state: "entah", version: "9" },
    });
    const client = createUpdaterClient(bridge);
    expect(await client.status()).toEqual({ state: "idle" });
  });
});

describe("parseUpdaterSettings", () => {
  test("hanya bentuk lengkap yang diterima", () => {
    expect(parseUpdaterSettings({ autoCheck: true, channel: "beta" })).toEqual({
      autoCheck: true,
      channel: "beta",
    });
    expect(parseUpdaterSettings({ autoCheck: true })).toBeUndefined();
    expect(parseUpdaterSettings({ autoCheck: true, channel: "dev" })).toBeUndefined();
  });
});

describe("desktopErrorMessage", () => {
  test("pesan galat diteruskan", () => {
    expect(desktopErrorMessage(new Error("rusak"))).toBe("rusak");
    expect(desktopErrorMessage("string")).toBe("string");
  });

  test("galat tanpa pesan memakai kalimat bawaan", () => {
    expect(desktopErrorMessage(new Error(""))).toContain("kesalahan");
  });
});
