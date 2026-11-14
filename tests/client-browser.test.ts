import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  BROWSER_DISABLED_MESSAGE,
  MAX_BROWSER_TABS,
  browserActivateTab,
  browserBack,
  browserClose,
  browserCloseTab,
  browserErrorText,
  browserForward,
  browserFrameUrl,
  browserNavigate,
  browserNewTab,
  browserReload,
  browserStatusText,
  browserStop,
  browserView,
  activeTab,
  dialogLabel,
  fitFrameSize,
  parseBrowserEvent,
  parseBrowserFrame,
  parseBrowserState,
  statusLabel,
  tabLabel,
  type BrowserStateInfo,
} from "../src/client/lib/browser";
import { BrowserTabStrip } from "../src/client/components/BrowserTabStrip";
import { BrowserToolbar } from "../src/client/components/BrowserToolbar";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function byLabel(node: ComponentChild, label: string): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["aria-label"] === label);
}

function byRole(node: ComponentChild, role: string): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode).role === role);
}

/* ---------- Bantuan: state dan fetch palsu ---------- */

function state(overrides: Partial<BrowserStateInfo> = {}): BrowserStateInfo {
  return {
    status: "menyala",
    url: "https://a.test",
    title: "",
    canGoBack: false,
    canGoForward: false,
    tabs: [],
    loading: false,
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

describe("parseBrowserEvent", () => {
  test("peristiwa state dan frame diterjemahkan", () => {
    const parsed = parseBrowserEvent(
      "state",
      JSON.stringify({ status: "menyala", url: "https://a.test", title: "A" }),
    );
    expect(parsed?.kind).toBe("state");
    if (parsed?.kind !== "state") throw new Error("peristiwa state");
    expect(parsed.state).toEqual({
      status: "menyala",
      url: "https://a.test",
      title: "A",
      canGoBack: false,
      canGoForward: false,
      tabs: [],
      loading: false,
      viewport: { width: 0, height: 0 },
      lastDialog: undefined,
    });

    const frame = parseBrowserEvent(
      "frame",
      JSON.stringify({ data: "aW1n", width: 1280, height: 800 }),
    );
    expect(frame).toEqual({ kind: "frame", frame: { data: "aW1n", width: 1280, height: 800 } });
  });

  test("peristiwa asing dan data rusak diabaikan", () => {
    expect(parseBrowserEvent("ping", "{}")).toBeUndefined();
    expect(parseBrowserEvent("state", "{bukan json")).toBeUndefined();
    expect(parseBrowserEvent("state", JSON.stringify({ status: "aneh" }))).toBeUndefined();
    expect(parseBrowserEvent("frame", JSON.stringify({ data: "" }))).toBeUndefined();
  });
});

describe("parseBrowserState dan parseBrowserFrame", () => {
  test("bentuk asing ditolak", () => {
    expect(parseBrowserState(undefined)).toBeUndefined();
    expect(parseBrowserState({ status: "menyala" })).toBeDefined();
    expect(parseBrowserState("bukan objek")).toBeUndefined();
    expect(parseBrowserFrame({ data: "x" })?.width).toBe(0);
    expect(parseBrowserFrame({})).toBeUndefined();
  });

  test("tab valid dibaca apa adanya", () => {
    const parsed = parseBrowserState({
      status: "menyala",
      url: "https://a.test",
      title: "A",
      canGoBack: true,
      canGoForward: false,
      loading: true,
      activeId: "T2",
      viewport: { width: 800, height: 600 },
      tabs: [
        { id: "T1", title: "Satu", url: "https://satu.test", active: false, loading: false },
        { id: "T2", title: "Dua", url: "https://dua.test", active: true, loading: true },
      ],
    });
    expect(parsed?.tabs).toEqual([
      { id: "T1", title: "Satu", url: "https://satu.test", active: false, loading: false },
      { id: "T2", title: "Dua", url: "https://dua.test", active: true, loading: true },
    ]);
    expect(parsed?.activeId).toBe("T2");
    expect(parsed?.loading).toBe(true);
    expect(parsed?.viewport).toEqual({ width: 800, height: 600 });
  });

  test("tab rusak dibuang dan jumlah dibatasi delapan", () => {
    const parsed = parseBrowserState({
      status: "menyala",
      tabs: [
        "bukan objek",
        { title: "Tanpa id" },
        { id: "", title: "Kosong" },
        { id: "T1", title: 5, url: null },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `X${index}`,
          title: `X${index}`,
          url: "https://x.test",
        })),
      ],
    });
    expect(parsed?.tabs).toHaveLength(MAX_BROWSER_TABS);
    expect(parsed?.tabs[0]).toEqual({
      id: "T1",
      title: "",
      url: "",
      active: false,
      loading: false,
    });
    expect(parsed?.tabs[1]?.id).toBe("X0");
  });

  test("viewport dan dialog rusak diabaikan", () => {
    const parsed = parseBrowserState({
      status: "menyala",
      viewport: { width: "lebar", height: -5 },
      lastDialog: { type: "alert", message: "Hai" },
    });
    expect(parsed?.viewport).toEqual({ width: 0, height: 0 });
    expect(parsed?.lastDialog).toEqual({ type: "alert", message: "Hai" });
    expect(parseBrowserState({ status: "menyala", lastDialog: "bukan objek" })?.lastDialog)
      .toBeUndefined();
  });
});

describe("activeTab dan tabLabel", () => {
  test("tab aktif diambil dari activeId lalu penanda active", () => {
    const stateInfo = state({
      activeId: "T2",
      tabs: [
        { id: "T1", title: "Satu", url: "", active: true, loading: false },
        { id: "T2", title: "Dua", url: "", active: false, loading: false },
      ],
    });
    expect(activeTab(stateInfo)?.id).toBe("T2");
    expect(activeTab(state({ activeId: "Hilang", tabs: stateInfo.tabs }))?.id).toBe("T1");
    expect(activeTab(state())).toBeUndefined();
    expect(activeTab(undefined)).toBeUndefined();
  });

  test("label memakai judul, host, atau Tab baru", () => {
    expect(tabLabel({ id: "T1", title: "Judul", url: "https://a.test", active: false, loading: false }))
      .toBe("Judul");
    expect(tabLabel({ id: "T1", title: "  ", url: "https://www.a.test/x", active: false, loading: false }))
      .toBe("a.test");
    expect(tabLabel({ id: "T1", title: "", url: "about:blank", active: false, loading: false }))
      .toBe("Tab baru");
    expect(tabLabel(undefined)).toBe("Tab baru");
  });

  test("label dipotong 24 karakter", () => {
    const panjang = tabLabel({
      id: "T1",
      title: "Judul yang sangat panjang sekali untuk tab",
      url: "",
      active: false,
      loading: false,
    });
    expect(panjang.length).toBe(24);
    expect(panjang.endsWith("…")).toBe(true);
  });
});

describe("statusLabel dan dialogLabel", () => {
  test("status menyebut memuat dan judul", () => {
    expect(statusLabel(undefined)).toBe("");
    expect(statusLabel(state({ status: "mati" }))).toBe("Browser mati");
    expect(statusLabel(state({ loading: true }))).toBe("Memuat…");
    expect(statusLabel(state({ title: "Judul" }))).toBe("Judul");
  });

  test("dialog diringkas jadi satu baris", () => {
    expect(dialogLabel(undefined)).toBe("");
    expect(dialogLabel({ type: "alert", message: "Hai" })).toBe(
      "Halaman menampilkan dialog: Hai (alert)",
    );
  });
});

describe("browserFrameUrl", () => {
  test("menambahkan prefiks data JPEG", () => {
    expect(browserFrameUrl("aW1n")).toBe("data:image/jpeg;base64,aW1n");
  });
});

describe("fitFrameSize", () => {
  test("lebar mengikuti panel dan rasio tetap", () => {
    const size = fitFrameSize({ width: 1280, height: 800 }, { width: 300, height: 0 });
    expect(size.width).toBe(300);
    expect(size.height).toBe(188);
  });

  test("tinggi dibatasi panel dengan rasio tetap", () => {
    const size = fitFrameSize({ width: 1280, height: 800 }, { width: 800, height: 200 });
    expect(size.height).toBe(200);
    expect(size.width).toBe(320);
  });

  test("ukuran tak dikenal memakai rasio bawaan", () => {
    const size = fitFrameSize({ width: 0, height: 0 }, { width: 200, height: 0 });
    expect(size.width).toBe(200);
    expect(size.height).toBe(125);
  });
});

describe("browserErrorText", () => {
  test("503 memakai pesan baku", () => {
    expect(browserErrorText(503, "apa saja")).toBe(BROWSER_DISABLED_MESSAGE);
  });

  test("pesan server dipakai apa adanya", () => {
    expect(browserErrorText(404, "Chrome atau Chromium tidak ditemukan.")).toBe(
      "Chrome atau Chromium tidak ditemukan.",
    );
  });

  test("pesan kosong memakai bawaan", () => {
    expect(browserErrorText(404, "")).toBe("Chrome atau Chromium tidak ditemukan.");
    expect(browserErrorText(409, undefined)).toBe("Browser sudah mati.");
    expect(browserErrorText(429, undefined)).toContain("8 tab");
    expect(browserErrorText(undefined, undefined)).toBe("Permintaan gagal.");
  });
});

describe("browserView", () => {
  test("status 503 berarti browser mati", () => {
    const view = browserView({ status: 503, adaFrame: false });
    expect(view.kind).toBe("mati");
    expect(view.pesan).toBe(BROWSER_DISABLED_MESSAGE);
  });

  test("pesan galat ditampilkan", () => {
    const view = browserView({
      status: 404,
      message: "Chrome atau Chromium tidak ditemukan.",
      adaFrame: false,
    });
    expect(view.kind).toBe("galat");
    expect(view.pesan).toBe("Chrome atau Chromium tidak ditemukan.");
  });

  test("menunggu frame sebelum frame datang", () => {
    const view = browserView({ adaFrame: false });
    expect(view.kind).toBe("menunggu");
    expect(view.pesan).toBe("Menunggu frame pertama…");
  });

  test("siap setelah frame datang", () => {
    const view = browserView({ adaFrame: true });
    expect(view.kind).toBe("siap");
  });
});

describe("browserStatusText", () => {
  test("judul, url, atau status mati", () => {
    expect(browserStatusText(state({ title: "Judul" }))).toBe("Judul");
    expect(browserStatusText(state({ title: "" }))).toBe("https://a.test");
    expect(browserStatusText(state({ status: "mati", url: "", title: "" }))).toBe("Browser mati");
    expect(browserStatusText(undefined)).toBe("");
  });
});

describe("BrowserToolbar", () => {
  test("kembali dan maju mengikuti canGoBack/canGoForward", () => {
    const node = BrowserToolbar({ state: state({ canGoBack: false, canGoForward: true }) });
    expect(propsOf(byLabel(node, "Kembali")[0]).disabled).toBe(true);
    expect(propsOf(byLabel(node, "Maju")[0]).disabled).toBe(false);
    const node2 = BrowserToolbar({ state: state({ canGoBack: true, canGoForward: false }) });
    expect(propsOf(byLabel(node2, "Kembali")[0]).disabled).toBe(false);
    expect(propsOf(byLabel(node2, "Maju")[0]).disabled).toBe(true);
  });

  test("tombol muat ulang berganti menjadi berhenti memuat", () => {
    const node = BrowserToolbar({ state: state({ loading: false }) });
    expect(byLabel(node, "Muat ulang")).toHaveLength(1);
    expect(byLabel(node, "Berhenti memuat")).toHaveLength(0);
    const memuat = BrowserToolbar({ state: state({ loading: true }) });
    expect(byLabel(memuat, "Berhenti memuat")).toHaveLength(1);
    expect(byLabel(memuat, "Muat ulang")).toHaveLength(0);
  });

  test("kolom URL mengikuti state terbaru", () => {
    const node = BrowserToolbar({ state: state({ url: "https://baru.test" }) });
    const input = findNodes(node, (vnode) => vnode.type === "input")[0];
    expect(propsOf(input).value).toBe("https://baru.test");
    expect(propsOf(input)["aria-label"]).toBe("Alamat");
  });

  test("ketikan pengguna tidak ditimpa saat disunting", () => {
    const node = BrowserToolbar({
      state: state({ url: "https://baru.test" }),
      editing: true,
      urlText: "https://saya.test",
    });
    const input = findNodes(node, (vnode) => vnode.type === "input")[0];
    expect(propsOf(input).value).toBe("https://saya.test");
  });

  test("Enter memanggil navigasi dan tiap kontrol punya aria-label", () => {
    let dipanggil = 0;
    const node = BrowserToolbar({
      state: state(),
      onUrlSubmit: () => {
        dipanggil += 1;
      },
    });
    const input = findNodes(node, (vnode) => vnode.type === "input")[0];
    (propsOf(input).onKeyDown as (event: unknown) => void)({
      key: "Enter",
      preventDefault: () => {},
    });
    expect(dipanggil).toBe(1);
    for (const label of ["Kembali", "Maju", "Muat ulang", "Alamat", "Tutup browser"]) {
      expect(byLabel(node, label).length).toBeGreaterThan(0);
    }
  });
});

describe("BrowserTabStrip", () => {
  const tabs = [
    { id: "T1", title: "Satu", url: "https://satu.test", active: false, loading: false },
    { id: "T2", title: "Dua", url: "https://dua.test", active: true, loading: true },
  ];

  test("satu tombol tab per tab dan penanda aktif", () => {
    const node = BrowserTabStrip({ tabs, activeId: "T2" });
    expect(propsOf(findNodes(node, (vnode) => vnode.type === "div")[0]).role).toBe("tablist");
    const tabNodes = byRole(node, "tab");
    expect(tabNodes).toHaveLength(2);
    expect(propsOf(tabNodes[0])["aria-selected"]).toBe(false);
    expect(propsOf(tabNodes[1])["aria-selected"]).toBe(true);
    expect(textOf(tabNodes[1] ?? undefined)).toContain("Dua");
  });

  test("klik tab mengaktifkan tab itu", () => {
    const aktif: string[] = [];
    const node = BrowserTabStrip({
      tabs,
      onActivate: (id) => aktif.push(id),
    });
    const tabNodes = byRole(node, "tab");
    (propsOf(tabNodes[0]).onClick as (event: unknown) => void)({});
    expect(aktif).toEqual(["T1"]);
  });

  test("tombol tutup menutup tab yang dipilih", () => {
    const ditutup: string[] = [];
    const node = BrowserTabStrip({
      tabs,
      onClose: (id) => ditutup.push(id),
    });
    const tutup = byLabel(node, "Tutup tab Dua")[0];
    (propsOf(tutup).onClick as (event: unknown) => void)({});
    expect(ditutup).toEqual(["T2"]);
  });

  test("tombol tab baru nonaktif saat sudah delapan tab", () => {
    const penuh = Array.from({ length: MAX_BROWSER_TABS }, (_, index) => ({
      id: `T${index}`,
      title: `T${index}`,
      url: "https://a.test",
      active: index === 0,
      loading: false,
    }));
    const node = BrowserTabStrip({ tabs: penuh, onNew: () => {} });
    expect(propsOf(byLabel(node, "Tab baru")[0]).disabled).toBe(true);
    const node2 = BrowserTabStrip({ tabs: penuh.slice(0, 7), onNew: () => {} });
    expect(propsOf(byLabel(node2, "Tab baru")[0]).disabled).toBe(false);
  });

  test("indikator memuat muncul pada tab yang memuat", () => {
    const node = BrowserTabStrip({ tabs });
    expect(textOf(node)).toContain("Dua");
    const memuat = findNodes(node, (vnode) => propsOf(vnode).class === "jk-browser-tab-load");
    expect(memuat).toHaveLength(1);
  });
});

describe("helper aksi browser", () => {
  test("navigate mengirim URL ke rute yang benar", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(state()));
    const hasil = await browserNavigate("https://a.test", fetch);
    expect(hasil.ok).toBe(true);
    expect(hasil.state?.url).toBe("https://a.test");
    expect(calls[0]?.url).toBe("/api/browser/navigate");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(calls[0]?.init.body).toBe(JSON.stringify({ url: "https://a.test" }));
  });

  test("riwayat, muat ulang, dan henti tanpa body tapi berkepala JSON", async () => {
    for (const [aksi, rute] of [
      [browserBack, "/api/browser/back"],
      [browserForward, "/api/browser/forward"],
      [browserReload, "/api/browser/reload"],
      [browserStop, "/api/browser/stop"],
    ] as const) {
      const { fetch, calls } = fakeFetch(() => jsonResponse(state()));
      const hasil = await aksi(fetch);
      expect(hasil.ok).toBe(true);
      expect(calls[0]?.url).toBe(rute);
      expect(calls[0]?.init.method).toBe("POST");
      expect(calls[0]?.init.body).toBeUndefined();
      expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
    }
  });

  test("tab baru, aktivasi, dan penutupan memakai id tab", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(state()));
    await browserNewTab(undefined, fetch);
    await browserActivateTab("T1", fetch);
    await browserCloseTab("T1", fetch);
    expect(calls[0]?.url).toBe("/api/browser/tabs");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[1]?.url).toBe("/api/browser/tabs/T1/activate");
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[2]?.url).toBe("/api/browser/tabs/T1");
    expect(calls[2]?.init.method).toBe("DELETE");
  });

  test("menutup browser memakai DELETE pada akar rute", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const hasil = await browserClose(fetch);
    expect(hasil.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/browser");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("galat batas 429 dikembalikan sebagai pesan Indonesia", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Batas 8 tab browser terlampaui. Tutup salah satu tab dulu." }, 429),
    );
    const hasil = await browserNewTab(undefined, fetch);
    expect(hasil.ok).toBe(false);
    expect(hasil.status).toBe(429);
    expect(hasil.error).toBe("Batas 8 tab browser terlampaui. Tutup salah satu tab dulu.");
  });

  test("galat tanpa JSON memakai pesan bawaan", async () => {
    const { fetch } = fakeFetch(() => new Response("bukan json", { status: 500 }));
    const hasil = await browserBack(fetch);
    expect(hasil.ok).toBe(false);
    expect(hasil.error).toBe("Permintaan gagal.");
  });
});
