import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import {
  BrowserError,
  BrowserManager,
  type BrowserProcess,
  type BrowserState,
  type PageSnapshot,
} from "../src/server/browser/browser-manager";
import {
  BROWSER_AGENT_LABELS,
  BROWSER_DISABLED_MESSAGE,
  BROWSER_READ_TOOL_NAMES,
  BROWSER_RESULT_MAX_CHARS,
  BROWSER_TOOL_NAMES,
  BrowserTools,
  WEB_CONTENT_FOOTER,
  WEB_CONTENT_HEADER,
} from "../src/server/browser/browser-tools";
import { KoneksiPalsu } from "./browser-fake-cdp";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Proses Chrome palsu: tak pernah keluar sendiri. */
function prosesPalsu(): BrowserProcess {
  return {
    pid: 4242,
    exited: new Promise<number>(() => undefined),
    kill: (): void => undefined,
  };
}

/** Manajer browser sungguhan dengan koneksi CDP palsu. */
function buatManager(koneksi: KoneksiPalsu): BrowserManager {
  return new BrowserManager({
    env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
    platform: "linux",
    exists: (path) => path === "/fake/chrome",
    spawn: () => prosesPalsu(),
    connect: async () => koneksi,
    readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
  });
}

/** State browser kosong untuk manajer palsu. */
function stateKosong(): BrowserState {
  return {
    status: "menyala",
    tabs: [],
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    viewport: { width: 1280, height: 800 },
  };
}

/** Manajer palsu: galat dan snapshot dikendalikan manual. */
class ManajerPalsu {
  galat: unknown = undefined;
  snapshotPalsu: PageSnapshot = { url: "", title: "", text: "", elements: [] };
  tabPalsu = [{ id: "T1", title: "Judul", url: "https://contoh.test/", active: true, loading: false }];
  /** Label aktivitas agent yang dicatat (urutan pemanggilan). */
  readonly catatanAgent: string[] = [];

  noteAgent(action: string): void {
    this.catatanAgent.push(action);
  }

  async tabs(): Promise<typeof this.tabPalsu> {
    return this.tabPalsu;
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.snapshotPalsu;
  }

  async screenshotForAgent(): Promise<{
    data: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
    url: string;
    title: string;
  }> {
    if (this.galat !== undefined) throw this.galat;
    return {
      data: "YmFzZTY0",
      mimeType: "image/jpeg",
      width: 1280,
      height: 800,
      url: "https://contoh.test/",
      title: "Judul",
    };
  }

  async navigate(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async newTab(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async activateTab(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async closeTab(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async back(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async clickRef(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async typeRef(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async pressKey(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  async scroll(): Promise<BrowserState> {
    if (this.galat !== undefined) throw this.galat;
    return stateKosong();
  }

  state(): BrowserState {
    return stateKosong();
  }
}

function sebagaiManager(palsu: ManajerPalsu): BrowserManager {
  return palsu as unknown as BrowserManager;
}

describe("definisi tool browser", () => {
  test("nama tool persis dan skema ketat", () => {
    const tools = new BrowserTools({ resolve: () => undefined });
    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      "browser_tabs",
      "browser_snapshot",
      "browser_screenshot",
      "browser_navigate",
      "browser_new_tab",
      "browser_switch_tab",
      "browser_close_tab",
      "browser_back",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
    ]);
    for (const definisi of tools.definitions) {
      expect(definisi.description.length).toBeGreaterThan(10);
      expect(definisi.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    const cari = (nama: string) =>
      tools.definitions.find((tool) => tool.name === nama)?.inputSchema as Record<string, unknown>;
    expect(cari("browser_navigate").required).toEqual(["url"]);
    expect(cari("browser_click").required).toEqual(["ref"]);
    expect(cari("browser_type").required).toEqual(["ref", "text"]);
    expect(cari("browser_press").required).toEqual(["key"]);
    expect(cari("browser_scroll").required).toEqual(["direction"]);
    expect(cari("browser_switch_tab").required).toEqual(["id"]);
    expect(cari("browser_close_tab").required).toEqual(["id"]);
    expect(cari("browser_new_tab").required).toBeUndefined();
    expect(cari("browser_back").required).toBeUndefined();
    const arah = (cari("browser_scroll").properties as Record<string, Record<string, unknown>>)
      .direction;
    expect(arah?.enum).toEqual(["up", "down"]);
  });

  test("screenshot adalah tool baca-saja", () => {
    expect(BROWSER_READ_TOOL_NAMES).toContain("browser_screenshot");
    expect(BROWSER_TOOL_NAMES).toContain("browser_screenshot");
    expect(BROWSER_AGENT_LABELS.browser_screenshot).toBe("mengambil screenshot");
  });
});

describe("BrowserTools", () => {
  test("fitur browser mati menolak semua panggilan", async () => {
    const tools = new BrowserTools({ resolve: () => undefined });
    expect(tools.aktif()).toBe(false);
    for (const nama of ["browser_tabs", "browser_snapshot", "browser_screenshot", "browser_click"]) {
      const hasil = await tools.call(nama, {});
      expect(hasil.isError).toBe(true);
      expect(hasil.text).toBe(BROWSER_DISABLED_MESSAGE);
    }
  });

  test("isi halaman dibungkus penanda data tidak tepercaya", async () => {
    const koneksi = new KoneksiPalsu();
    koneksi.snapshot = {
      url: "https://contoh.test/halaman",
      title: "Judul Halaman",
      text: "Isi teks halaman lokal",
      elements: [{ ref: 1, tag: "button", name: "Kirim", x: 10, y: 20 }],
    };
    const manager = buatManager(koneksi);
    const tools = new BrowserTools({ resolve: () => manager });

    const hasil = await tools.call("browser_snapshot", {});
    expect(hasil.isError).toBe(false);
    expect(hasil.text.startsWith(WEB_CONTENT_HEADER)).toBe(true);
    expect(hasil.text.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
    expect(hasil.text).toContain("Isi teks halaman lokal");
    expect(hasil.text).toContain("[1] button");
    expect(hasil.text).toContain("https://contoh.test/halaman");

    const tab = await tools.call("browser_tabs", {});
    expect(tab.text.startsWith(WEB_CONTENT_HEADER)).toBe(true);
    expect(tab.text.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
  });

  test("hasil dipotong pada batas karakter", async () => {
    const palsu = new ManajerPalsu();
    palsu.snapshotPalsu = {
      url: "https://contoh.test/",
      title: "Panjang",
      text: "x".repeat(90_000),
      elements: [],
    };
    const tools = new BrowserTools({ resolve: () => sebagaiManager(palsu) });

    const hasil = await tools.call("browser_snapshot", {});
    expect(hasil.isError).toBe(false);
    expect(hasil.text.length).toBeLessThanOrEqual(BROWSER_RESULT_MAX_CHARS);
    expect(hasil.text).toContain("[Isi dipotong.]");
    expect(hasil.text.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
  });

  test("tool aksi mengembalikan ringkasan, bukan snapshot penuh", async () => {
    const koneksi = new KoneksiPalsu();
    koneksi.snapshot = {
      url: "https://contoh.test/",
      title: "Judul",
      text: "Teks halaman yang panjang sekali",
      elements: [{ ref: 1, tag: "button", name: "Kirim", x: 10, y: 20 }],
    };
    koneksi.aksi = { x: 10, y: 20 };
    const manager = buatManager(koneksi);
    const tools = new BrowserTools({ resolve: () => manager });

    await tools.call("browser_snapshot", {});
    const hasil = await tools.call("browser_click", { ref: 1 });
    expect(hasil.isError).toBe(false);
    expect(hasil.text).toContain("Klik dilakukan.");
    expect(hasil.text).toContain("URL:");
    expect(hasil.text).toContain("Judul:");
    expect(hasil.text).toContain("Elemen:");
    expect(hasil.text).not.toContain("Teks halaman yang panjang sekali");
  });

  test("audit mencatat nama tool dan URL, tak pernah teks atau nilai elemen", async () => {
    const store = new SqliteAuditStore(":memory:");
    try {
      const koneksi = new KoneksiPalsu();
      koneksi.snapshot = {
        url: "https://contoh.test/",
        title: "Judul",
        text: "halo",
        elements: [{ ref: 1, tag: "input", name: "Kotak", value: "nilai-elemen", x: 1, y: 2 }],
      };
      koneksi.aksi = { x: 10, y: 20 };
      const manager = buatManager(koneksi);
      const tools = new BrowserTools({ resolve: () => manager, audit: store });

      await tools.call("browser_snapshot", {});
      await tools.call("browser_type", { ref: 1, text: "halo-dunia-123" });
      await tools.call("browser_navigate", { url: "http://127.0.0.1:8080/halaman" });

      const entri = store.list();
      const semua = JSON.stringify(entri);
      expect(semua).not.toContain("halo-dunia-123");
      expect(semua).not.toContain("nilai-elemen");
      expect(entri.some((item) => item.meta.tool === "browser_type")).toBe(true);
      const nav = entri.find((item) => item.meta.tool === "browser_navigate");
      expect(String(nav?.meta.url ?? "")).toContain("127.0.0.1:8080");
    } finally {
      store.close();
    }
  });

  test("argumen divalidasi: ref, tombol, URL, dan field tak dikenal", async () => {
    const koneksi = new KoneksiPalsu();
    const manager = buatManager(koneksi);
    const tools = new BrowserTools({ resolve: () => manager });

    const ref = await tools.call("browser_click", { ref: 1.5 });
    expect(ref.isError).toBe(true);
    expect(ref.text).toContain("bilangan bulat");

    const refNol = await tools.call("browser_click", { ref: 0 });
    expect(refNol.isError).toBe(true);

    const tombol = await tools.call("browser_press", { key: "Meta+X" });
    expect(tombol.isError).toBe(true);
    expect(tombol.text).toContain("tidak diizinkan");

    const url = await tools.call("browser_navigate", { url: "file:///etc/passwd" });
    expect(url.isError).toBe(true);
    expect(url.text).toContain("tidak diizinkan");

    const takDikenal = await tools.call("browser_click", { ref: 1, warna: "merah" });
    expect(takDikenal.isError).toBe(true);
    expect(takDikenal.text).toContain("tidak dikenal");

    const arah = await tools.call("browser_scroll", { direction: "samping" });
    expect(arah.isError).toBe(true);
  });

  test("BrowserError diterjemahkan, galat tak dikenal jadi pesan umum", async () => {
    const palsu = new ManajerPalsu();
    palsu.galat = new BrowserError("Tab tidak ditemukan.", "tidak-ditemukan");
    const tools = new BrowserTools({ resolve: () => sebagaiManager(palsu) });

    const hasil = await tools.call("browser_click", { ref: 1 });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toBe("Tab tidak ditemukan.");

    palsu.galat = new Error("rahasia stack internal");
    const umum = await tools.call("browser_click", { ref: 1 });
    expect(umum.isError).toBe(true);
    expect(umum.text).toBe("Aksi browser gagal dijalankan.");
    expect(umum.text).not.toContain("stack");
  });

  test("screenshot mengembalikan blok gambar dan teks ringkas", async () => {
    const koneksi = new KoneksiPalsu();
    const manager = buatManager(koneksi);
    const tools = new BrowserTools({ resolve: () => manager });

    const hasil = await tools.call("browser_screenshot", {});
    expect(hasil.isError).toBe(false);
    expect(hasil.image?.data).toBe("YmVuaWgtMTE=");
    expect(hasil.image?.mimeType).toBe("image/jpeg");
    expect(hasil.text.startsWith(WEB_CONTENT_HEADER)).toBe(true);
    expect(hasil.text.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
    expect(hasil.text).toContain("URL:");
    expect(hasil.text).toContain("Judul:");
    expect(hasil.text).toContain("1280x800");
    expect(hasil.text).toContain("[Screenshot 1280x800, 1 KB]");
    // Teks tak pernah memuat data gambar.
    expect(hasil.text).not.toContain("YmVuaWgtMTE=");
  });

  test("screenshot menolak argumen tak dikenal dan mencatat galat", async () => {
    const palsu = new ManajerPalsu();
    const tools = new BrowserTools({ resolve: () => sebagaiManager(palsu) });

    const argumen = await tools.call("browser_screenshot", { fullPage: true });
    expect(argumen.isError).toBe(true);
    expect(argumen.text).toContain("tidak dikenal");

    palsu.galat = new BrowserError("Screenshot terlalu besar.", "batas");
    const gagal = await tools.call("browser_screenshot", {});
    expect(gagal.isError).toBe(true);
    expect(gagal.text).toBe("Screenshot terlalu besar.");
    expect(gagal.image).toBeUndefined();
  });

  test("navigate memakai manajer sehingga skema berbahaya ditolak", async () => {
    const koneksi = new KoneksiPalsu();
    const manager = buatManager(koneksi);
    const tools = new BrowserTools({ resolve: () => manager });

    const hasil = await tools.call("browser_navigate", { url: "javascript:alert(1)" });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toContain("tidak diizinkan");
    expect(koneksi.calls("Page.navigate")).toHaveLength(0);
  });
});

describe("aktivitas agent di tool browser", () => {
  test("setiap tool mencatat label tetap sebelum bertindak", async () => {
    const palsu = new ManajerPalsu();
    const tools = new BrowserTools({ resolve: () => sebagaiManager(palsu) });

    await tools.call("browser_tabs", {});
    await tools.call("browser_snapshot", {});
    await tools.call("browser_screenshot", {});
    await tools.call("browser_navigate", { url: "https://rahasia.test/token" });
    await tools.call("browser_new_tab", {});
    await tools.call("browser_switch_tab", { id: "T1" });
    await tools.call("browser_close_tab", { id: "T1" });
    await tools.call("browser_back", {});
    await tools.call("browser_click", { ref: 3 });
    await tools.call("browser_type", { ref: 3, text: "kata-sandi-rahasia" });
    await tools.call("browser_press", { key: "Enter" });
    await tools.call("browser_scroll", { direction: "down" });

    expect(palsu.catatanAgent).toEqual([
      "membaca halaman",
      "membaca halaman",
      "mengambil screenshot",
      "membuka alamat",
      "membuka tab baru",
      "berpindah tab",
      "menutup tab",
      "kembali",
      "mengeklik elemen",
      "mengetik",
      "menekan tombol",
      "menggulir",
    ]);
  });

  test("label tak pernah memuat URL, isi halaman, atau teks yang diketik", async () => {
    const palsu = new ManajerPalsu();
    const tools = new BrowserTools({ resolve: () => sebagaiManager(palsu) });
    await tools.call("browser_navigate", { url: "https://rahasia.test/token" });
    await tools.call("browser_type", { ref: 1, text: "kata-sandi-rahasia" });
    const gabungan = palsu.catatanAgent.join(" ");
    expect(gabungan).not.toContain("rahasia");
    expect(gabungan).not.toContain("http");
    expect(gabungan).not.toContain("kata-sandi");
    for (const label of palsu.catatanAgent) {
      expect(label.length).toBeLessThanOrEqual(60);
    }
  });
});
