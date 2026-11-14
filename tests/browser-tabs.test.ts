import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserError } from "../src/server/browser/browser-error";
import {
  BrowserManager,
  type BrowserProcess,
  type BrowserState,
} from "../src/server/browser/browser-manager";
import { KoneksiPalsu } from "./browser-fake-cdp";

/** Proses Chrome palsu: bisa dibunuh seketika. */
function prosesPalsu(): BrowserProcess {
  let selesai: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    selesai = resolve;
  });
  return {
    pid: 4242,
    exited,
    kill: (): void => {
      selesai(0);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-tab-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  manager: BrowserManager;
  koneksi: KoneksiPalsu;
}

function setup(options: { targetAwal?: string } = {}): Setup {
  const koneksi = new KoneksiPalsu();
  koneksi.addTarget(options.targetAwal ?? "T1");
  const manager = new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => prosesPalsu(),
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
  });
  return { manager, koneksi };
}

describe("siklus hidup tab", () => {
  test("tab utama dibuat dan jadi tab aktif", async () => {
    const { manager } = setup();
    await manager.ensure();
    const state = manager.state();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe("T1");
    expect(state.tabs[0]?.active).toBe(true);
    expect(state.activeId).toBe("T1");
    await manager.close();
  });

  test("tab baru dibuat, aktif, dan jumlah tab bertambah", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const state = await manager.newTab("https://kedua.test");
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("X1");
    expect(state.tabs[1]?.url).toBe("https://kedua.test/");
    expect(koneksi.calls("Target.createTarget")[0]?.params).toEqual({
      url: "https://kedua.test/",
    });
    await manager.close();
  });

  test("tab baru tanpa URL memakai about:blank", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const state = await manager.newTab();
    expect(state.tabs[1]?.url).toBe("about:blank");
    expect(koneksi.calls("Target.createTarget")[0]?.params).toEqual({ url: "about:blank" });
    await manager.close();
  });

  test("tab baru menolak skema terlarang", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(manager.newTab("javascript:alert(1)")).rejects.toBeInstanceOf(BrowserError);
    expect(manager.state().tabs).toHaveLength(1);
    await manager.close();
  });

  test("maksimal 8 tab; tab ke-9 ditolak dengan batas", async () => {
    const { manager } = setup();
    await manager.ensure();
    for (let i = 0; i < 7; i += 1) await manager.newTab();
    expect(manager.state().tabs).toHaveLength(8);
    let galat: unknown;
    try {
      await manager.newTab();
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("batas");
    expect(manager.state().tabs).toHaveLength(8);
    await manager.close();
  });

  test("tab terakhir yang ditutup diganti tab about:blank baru", async () => {
    const { manager } = setup();
    await manager.ensure();
    const state = await manager.closeTab("T1");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.url).toBe("about:blank");
    expect(state.activeId).toBe(state.tabs[0]?.id);
    await manager.close();
  });

  test("tab aktif ditutup mengaktifkan tetangga", async () => {
    const { manager } = setup();
    await manager.ensure();
    await manager.newTab("https://kedua.test");
    await manager.newTab("https://ketiga.test");
    expect(manager.state().activeId).toBe("X2");
    const state = await manager.closeTab("X2");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["T1", "X1"]);
    expect(state.activeId).toBe("X1");
    await manager.close();
  });

  test("tab yang ditutup dilepas dan tetangganya aktif", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.newTab("https://kedua.test");
    const sebelum = manager.state().activeId;
    const state = await manager.closeTab(sebelum ?? "");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe("T1");
    expect(state.activeId).toBe("T1");
    expect(koneksi.calls("Target.detachFromTarget")).toHaveLength(1);
    await manager.close();
  });

  test("menutup tab yang tak ada ditolak dengan tidak-ditemukan", async () => {
    const { manager } = setup();
    await manager.ensure();
    let galat: unknown;
    try {
      await manager.closeTab("TIDAK-ADA");
    } catch (caught) {
      galat = caught;
    }
    expect(galat).toBeInstanceOf(BrowserError);
    expect((galat as BrowserError).code).toBe("tidak-ditemukan");
    await manager.close();
  });

  test("aktivasi tab tak ada ditolak dengan tidak-ditemukan", async () => {
    const { manager } = setup();
    await manager.ensure();
    await expect(manager.activateTab("TIDAK-ADA")).rejects.toBeInstanceOf(BrowserError);
    await manager.close();
  });

  test("aktivasi memindahkan screencast ke tab baru", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const unsubscribe = manager.subscribe(() => undefined);
    await Bun.sleep(5);
    expect(koneksi.calls("Page.startScreencast")[0]?.sessionId).toBe("S-T1");
    await manager.newTab("https://kedua.test");
    await Bun.sleep(5);
    const stop = koneksi.calls("Page.stopScreencast");
    expect(stop.length).toBeGreaterThan(0);
    expect(stop[stop.length - 1]?.sessionId).toBe("S-T1");
    const mulai = koneksi.calls("Page.startScreencast");
    expect(mulai[mulai.length - 1]?.sessionId).toBe("S-X1");
    expect(koneksi.calls("Page.bringToFront").slice(-1)[0]?.sessionId).toBe("S-X1");
    const aktif = koneksi.calls("Target.activateTarget");
    expect(aktif[aktif.length - 1]?.params).toEqual({ targetId: "X1" });
    unsubscribe();
    await manager.close();
  });

  test("popup jadi tab baru yang aktif", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.addTarget("TPOPUP", "https://popup.test", "Popup");
    koneksi.emit("Target.targetCreated", {
      targetInfo: {
        targetId: "TPOPUP",
        type: "page",
        url: "https://popup.test",
        title: "Popup",
      },
    });
    await Bun.sleep(20);
    const state = manager.state();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["T1", "TPOPUP"]);
    expect(state.activeId).toBe("TPOPUP");
    expect(state.url).toBe("https://popup.test");
    expect(koneksi.calls("Target.attachToTarget").length).toBe(2);
    await manager.close();
  });

  test("target non-halaman diabaikan", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.emit("Target.targetCreated", {
      targetInfo: { targetId: "TSW", type: "service_worker", url: "https://sw.test" },
    });
    await Bun.sleep(10);
    expect(manager.state().tabs).toHaveLength(1);
    await manager.close();
  });

  test("target yang musnah dilepas dari daftar tab", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.newTab("https://kedua.test");
    koneksi.emit("Target.targetDestroyed", { targetId: "X1" });
    await Bun.sleep(20);
    const state = manager.state();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["T1"]);
    expect(state.activeId).toBe("T1");
    await manager.close();
  });
});

describe("state browser dan pembaruan lewat SSE", () => {
  test("state awal dikirim ke pendengar baru", async () => {
    const { manager } = setup();
    await manager.ensure();
    const states: BrowserState[] = [];
    manager.subscribeState((state) => states.push(state));
    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe("menyala");
    await manager.close();
  });

  test("navigasi memperbarui URL dan mengirim event state", async () => {
    const { manager } = setup();
    await manager.ensure();
    const states: BrowserState[] = [];
    manager.subscribeState((state) => states.push(state));
    await manager.navigate("https://baru.test");
    await Bun.sleep(120);
    expect(states.length).toBeGreaterThanOrEqual(2);
    const terakhir = states[states.length - 1];
    expect(terakhir?.url).toBe("https://baru.test/");
    await manager.close();
  });

  test("peristiwa navigasi dalam dokumen mengubah URL", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const states: BrowserState[] = [];
    manager.subscribeState((state) => states.push(state));
    koneksi.emit(
      "Page.frameNavigated",
      { frame: { id: "F1", url: "https://satu.test/" } },
      "S-T1",
    );
    await Bun.sleep(120);
    expect(states[states.length - 1]?.url).toBe("https://satu.test/");
    await manager.close();
  });

  test("frame anak tak mengubah URL tab", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.emit(
      "Page.frameNavigated",
      { frame: { id: "F2", url: "https://anak.test/", parentId: "F1" } },
      "S-T1",
    );
    await Bun.sleep(60);
    expect(manager.state().url).not.toBe("https://anak.test/");
    await manager.close();
  });

  test("state identik tak pernah dikirim dua kali", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    const states: BrowserState[] = [];
    manager.subscribeState((state) => states.push(state));
    await manager.navigate("https://baru.test");
    await Bun.sleep(120);
    const jumlah = states.length;
    // Peristiwa yang tak mengubah state tak boleh menambah kiriman.
    koneksi.emit("Page.frameStoppedLoading", {}, "S-T1");
    await Bun.sleep(120);
    expect(states.length).toBe(jumlah);
    await manager.close();
  });

  test("status memuat dan judul ikut terbaca", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.emit("Page.frameStartedLoading", {}, "S-T1");
    await Bun.sleep(60);
    expect(manager.state().loading).toBe(true);
    koneksi.emit("Page.frameStoppedLoading", {}, "S-T1");
    await Bun.sleep(60);
    expect(manager.state().loading).toBe(false);
    await manager.close();
  });

  test("judul tab diperbarui dari peristiwa target", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.emit("Target.targetInfoChanged", {
      targetInfo: { targetId: "T1", url: "https://judul.test/", title: "Judul Baru" },
    });
    await Bun.sleep(60);
    const state = manager.state();
    expect(state.title).toBe("Judul Baru");
    expect(state.tabs[0]?.title).toBe("Judul Baru");
    await manager.close();
  });
});

describe("riwayat navigasi", () => {
  test("mundur memakai entri sebelumnya", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.riwayat = {
      currentIndex: 1,
      entries: [
        { id: 10, url: "https://satu.test/" },
        { id: 11, url: "https://dua.test/" },
      ],
    };
    const state = await manager.back();
    expect(koneksi.calls("Page.navigateToHistoryEntry")[0]?.params).toEqual({ entryId: 10 });
    expect(state.url).toBe("https://satu.test/");
    expect(state.canGoBack).toBe(false);
    expect(state.canGoForward).toBe(true);
    await manager.close();
  });

  test("maju memakai entri berikutnya", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.riwayat = {
      currentIndex: 0,
      entries: [
        { id: 10, url: "https://satu.test/" },
        { id: 11, url: "https://dua.test/" },
      ],
    };
    const state = await manager.forward();
    expect(koneksi.calls("Page.navigateToHistoryEntry")[0]?.params).toEqual({ entryId: 11 });
    expect(state.url).toBe("https://dua.test/");
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
    await manager.close();
  });

  test("tak ada riwayat berarti tak berubah", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    koneksi.riwayat = { currentIndex: 0, entries: [{ id: 10, url: "https://satu.test/" }] };
    await manager.back();
    await manager.forward();
    expect(koneksi.calls("Page.navigateToHistoryEntry")).toHaveLength(0);
    await manager.close();
  });

  test("muat ulang dan henti memakai perintah CDP", async () => {
    const { manager, koneksi } = setup();
    await manager.ensure();
    await manager.reload();
    expect(koneksi.calls("Page.reload")).toHaveLength(1);
    await manager.stop();
    expect(koneksi.calls("Page.stopLoading")).toHaveLength(1);
    await manager.close();
  });
});
