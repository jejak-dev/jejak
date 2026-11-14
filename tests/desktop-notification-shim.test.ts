import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SHIM_PATH = join(
  import.meta.dir,
  "..",
  "src-tauri",
  "shim",
  "notification.js",
);
const SHIM_SOURCE = readFileSync(SHIM_PATH, "utf8");

/** Bentuk kelas Notification hasil shim. */
interface FakeNotification {
  title: string;
  body: string;
  tag: string;
  silent: boolean;
  onclick: (() => void) | null;
  close(): void;
}

/** Konstruktor Notification hasil shim. */
interface FakeNotificationConstructor {
  new (
    title: string,
    options?: { body?: string; tag?: string; silent?: boolean },
  ): FakeNotification;
  permission: string;
  requestPermission(): Promise<string>;
}

/** Satu panggilan plugin yang tercatat. */
interface Panggilan {
  cmd: string;
  args: unknown;
}

/** Tunggu antrean microtask selesai. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Muat shim di konteks vm palsu.
 *
 * Tanpa `panggil`, bridge Tauri tak ada sehingga shim tak boleh mengubah
 * `Notification`.
 */
function muatShim(
  panggil?: (cmd: string, args?: unknown) => Promise<unknown>,
): Record<string, unknown> {
  const jendela: Record<string, unknown> = {};
  if (panggil !== undefined) {
    jendela.__TAURI_INTERNALS__ = { invoke: panggil };
  }
  vm.runInNewContext(SHIM_SOURCE, { window: jendela });
  return jendela;
}

/** Ambil kelas Notification dari jendela palsu. */
function kelas(jendela: Record<string, unknown>): FakeNotificationConstructor {
  return jendela.Notification as unknown as FakeNotificationConstructor;
}

describe("shim notifikasi desktop", () => {
  test("tanpa bridge Tauri, Notification tak diganti", () => {
    const jendela = muatShim();
    expect(jendela.Notification).toBeUndefined();
  });

  test("permission awal default lalu granted setelah status diketahui", async () => {
    const jendela = muatShim(async () => true);
    const Notifikasi = kelas(jendela);
    expect(Notifikasi.permission).toBe("default");
    await tick();
    expect(Notifikasi.permission).toBe("granted");
  });

  test("status izin null berarti belum diminta", async () => {
    const jendela = muatShim(async () => null);
    await tick();
    expect(kelas(jendela).permission).toBe("default");
  });

  test("requestPermission memanggil perintah yang benar", async () => {
    const panggilan: Panggilan[] = [];
    const jendela = muatShim(async (cmd, args) => {
      panggilan.push({ cmd, args });
      if (cmd === "plugin:notification|is_permission_granted") return true;
      if (cmd === "plugin:notification|request_permission") return "granted";
      return null;
    });
    const Notifikasi = kelas(jendela);
    const hasil = await Notifikasi.requestPermission();
    expect(hasil).toBe("granted");
    expect(Notifikasi.permission).toBe("granted");
    const perintah = panggilan.find(
      (item) => item.cmd === "plugin:notification|request_permission",
    );
    expect(perintah).toBeDefined();
  });

  test("prompt dari plugin berarti default", async () => {
    const jendela = muatShim(async (cmd) => {
      if (cmd === "plugin:notification|request_permission") return "prompt";
      return true;
    });
    const Notifikasi = kelas(jendela);
    expect(await Notifikasi.requestPermission()).toBe("default");
  });

  test("konstruktor mengirim judul dan isi ke plugin", () => {
    const panggilan: Panggilan[] = [];
    const jendela = muatShim(async (cmd, args) => {
      panggilan.push({ cmd, args });
      return true;
    });
    const Notifikasi = kelas(jendela);
    const notifikasi = new Notifikasi("Selesai", { body: "Uji" });
    expect(notifikasi.title).toBe("Selesai");
    expect(notifikasi.body).toBe("Uji");
    expect(notifikasi.onclick).toBeNull();
    expect(() => notifikasi.close()).not.toThrow();
    const perintah = panggilan.find(
      (item) => item.cmd === "plugin:notification|notify",
    );
    expect(perintah?.args).toEqual({
      options: { title: "Selesai", body: "Uji" },
    });
  });

  test("invoke yang ditolak tak melempar ke halaman", async () => {
    const jendela = muatShim(async () => {
      throw new Error("ditolak");
    });
    // Tunggu dulu penolakan status izin: promise dari realm tes ditangani
    // shim di realm vm, jadi harus sempat dialirkan sebelum promise lain
    // dibuat.
    await tick();
    const Notifikasi = kelas(jendela);
    expect(() => new Notifikasi("Judul", { body: "Isi" })).not.toThrow();
    expect(await Notifikasi.requestPermission()).toBe("denied");
    await tick();
    expect(Notifikasi.permission).toBe("denied");
  });
});
