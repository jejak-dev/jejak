import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { Composer } from "../src/client/components/Composer";
import { Sidebar } from "../src/client/components/Sidebar";
import { useHeldPrompts } from "../src/client/hooks";
import {
  createApiClient,
  type ApiClient,
  type HeldPrompt,
  type SessionCreateInput,
} from "../src/client/lib/api";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import {
  asElement,
  FakeNode,
  find,
  findByAttr,
  fire,
  flushEffects,
  installDom,
  mount,
} from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  // Komposer memakai ResizeObserver; di DOM tiruan cukup stub kosong.
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Data bantu ---------- */

const SESI: SessionInfo = {
  id: "s1",
  title: "Perbaiki login",
  prompt: "Halo",
  cwd: "/tmp/proyek",
  profileId: "lokal",
  permissionMode: "default",
  status: "berjalan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
  pendingPermissions: 0,
  queued: 0,
};

const SESI_LAIN: SessionInfo = { ...SESI, id: "s2", title: "Sesi lama" };

const HELD: HeldPrompt = {
  id: "h1",
  input: { prompt: "Kerjakan tugas" },
  waitForSessionId: "s2",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "menunggu",
};

interface Panggilan {
  nama: string;
  argumen: unknown[];
}

/** Klien API tiruan: hanya метод yang dipakai komposer. */
function apiPalsu(daftar: Panggilan[]): ApiClient {
  const base = {
    nativePickerAvailable: async (): Promise<boolean> => false,
    getSandbox: async (): Promise<never> => {
      throw new Error("sandbox tak tersedia");
    },
    createSession: async (input: SessionCreateInput): Promise<SessionInfo> => {
      daftar.push({ nama: "createSession", argumen: [input] });
      return SESI;
    },
    holdPrompt: async (
      input: SessionCreateInput,
      waitForSessionId: string,
    ): Promise<HeldPrompt> => {
      daftar.push({ nama: "holdPrompt", argumen: [input, waitForSessionId] });
      return HELD;
    },
  };
  return base as unknown as ApiClient;
}

/** Isi kolom teks lalu picu peristiwa input. */
function isi(root: FakeNode, selector: (node: FakeNode) => boolean, teks: string): void {
  const elemen = find(root, selector);
  expect(elemen).toBeDefined();
  (elemen as unknown as { value: string }).value = teks;
  fire(elemen!, "input");
}

/**
 * Nilai kolom: Preact menyetel `value` sebagai atribut bila elemen tak punya
 * properti itu (seperti di DOM tiruan).
 */
function nilai(elemen: FakeNode | undefined): string {
  if (elemen === undefined) return "";
  const sebagaiProperti = (elemen as unknown as { value?: string }).value;
  if (typeof sebagaiProperti === "string") return sebagaiProperti;
  return elemen.getAttribute("value") ?? "";
}

/** Pilih opsi pada `Select` dengan memesan pemicunya lalu menekan opsinya. */
async function pilihOpsi(root: FakeNode, ariaLabel: string, label: string): Promise<void> {
  const pemicu = findByAttr(root, "aria-label", ariaLabel);
  expect(pemicu).toBeDefined();
  fire(pemicu!, "click");
  await flushEffects();
  const opsi = find(
    root,
    (node) =>
      node.getAttribute("role") === "option" && (node.textContent ?? "").includes(label),
  );
  expect(opsi).toBeDefined();
  fire(opsi!, "click");
  await flushEffects();
}

/* ---------- Klien API ---------- */

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("prompt tertahan di klien API", () => {
  test("listHeld memanggil GET /api/held-prompts dan mengurai daftar", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ held: [HELD] }));
    const api = createApiClient({ fetch });

    const list = await api.listHeld();

    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("h1");
    expect(list[0]?.input.prompt).toBe("Kerjakan tugas");
    expect(calls[0]?.url).toBe("/api/held-prompts");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("holdPrompt mengirim waitForSessionId di body POST", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ held: HELD }, 201));
    const api = createApiClient({ fetch });

    const hasil = await api.holdPrompt({ prompt: "Kerjakan" }, "s2");

    expect(hasil.id).toBe("h1");
    expect(calls[0]?.url).toBe("/api/held-prompts");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["prompt"]).toBe("Kerjakan");
    expect(body["waitForSessionId"]).toBe("s2");
  });

  test("cancelHeld menghapus tahanan dan mengembalikan isinya", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ held: { ...HELD, status: "dibatalkan" } }),
    );
    const api = createApiClient({ fetch });

    const hasil = await api.cancelHeld("h1");

    expect(hasil.status).toBe("dibatalkan");
    expect(hasil.input.prompt).toBe("Kerjakan tugas");
    expect(calls[0]?.url).toBe("/api/held-prompts/h1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("dismissHeld menutup kartu tahanan", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.dismissHeld("h1");

    expect(calls[0]?.url).toBe("/api/held-prompts/h1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("respons tak valid jadi ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ held: "bukan objek" }));
    const api = createApiClient({ fetch });

    const galat = await api.listHeld().catch((caught) => caught);

    expect(galat).toBeInstanceOf(Error);
  });
});

/* ---------- Komposer ---------- */

describe("Composer: tahan prompt", () => {
  test("chip Tunggu sesi hanya tampil bila ada sesi berjalan", () => {
    const tanpa = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp", onCreated: () => {} }),
    );
    expect(findByAttr(tanpa, "aria-label", "Tunggu sesi")).toBeUndefined();

    const dengan = mount(
      h(Composer, {
        api: apiPalsu([]),
        defaultCwd: "/tmp",
        onCreated: () => {},
        runningSessions: [{ id: "s2", title: "Sesi lama" }],
      }),
    );
    expect(findByAttr(dengan, "aria-label", "Tunggu sesi")).toBeDefined();
  });

  test("memilih sesi lalu submit menahan prompt, bukan membuat sesi", async () => {
    const panggilan: Panggilan[] = [];
    const dibuat: string[] = [];
    const ditahan: number[] = [];
    const root = mount(
      h(Composer, {
        api: apiPalsu(panggilan),
        defaultCwd: "/tmp",
        onCreated: (session) => dibuat.push(session.id),
        onHeld: () => ditahan.push(1),
        runningSessions: [{ id: "s2", title: "Sesi lama" }],
      }),
    );

    isi(root, (node) => node.localName === "textarea", "Kerjakan tugas");
    await flushEffects();
    await pilihOpsi(root, "Tunggu sesi", "Sesi lama");

    const form = find(root, (node) => node.className === "jk-composer");
    expect(form).toBeDefined();
    fire(form!, "submit");
    await flushEffects();

    const tahan = panggilan.find((p) => p.nama === "holdPrompt");
    expect(tahan).toBeDefined();
    expect(tahan?.argumen[1]).toBe("s2");
    expect(panggilan.some((p) => p.nama === "createSession")).toBe(false);
    expect(ditahan).toHaveLength(1);
    expect(dibuat).toEqual([]);
  });

  test("tanpa sesi yang dipilih prompt langsung dibuat", async () => {
    const panggilan: Panggilan[] = [];
    const dibuat: string[] = [];
    const ditahan: number[] = [];
    const root = mount(
      h(Composer, {
        api: apiPalsu(panggilan),
        defaultCwd: "/tmp",
        onCreated: (session) => dibuat.push(session.id),
        onHeld: () => ditahan.push(1),
        runningSessions: [{ id: "s2", title: "Sesi lama" }],
      }),
    );

    isi(root, (node) => node.localName === "textarea", "Kerjakan tugas");
    await flushEffects();

    const form = find(root, (node) => node.className === "jk-composer");
    fire(form!, "submit");
    await flushEffects();

    expect(panggilan.some((p) => p.nama === "createSession")).toBe(true);
    expect(panggilan.some((p) => p.nama === "holdPrompt")).toBe(false);
    expect(dibuat).toEqual([SESI.id]);
    expect(ditahan).toEqual([]);
  });

  test("restoreDraft mengisi prompt dan folder kerja", async () => {
    const root = mount(
      h(Composer, {
        api: apiPalsu([]),
        defaultCwd: "/tmp",
        onCreated: () => {},
        restoreDraft: { id: "h1", input: { prompt: "Teks draf", cwd: "/tmp/lain" } },
      }),
    );
    await flushEffects();

    const area = find(root, (node) => node.localName === "textarea");
    expect(nilai(area)).toBe("Teks draf");
    const folder = findByAttr(root, "id", "jk-cwd");
    expect(nilai(folder)).toBe("/tmp/lain");
  });
});

/* ---------- Sidebar ---------- */

function sidebar(props: Record<string, unknown>): FakeNode {
  return mount(
    h(Sidebar, {
      sessions: [SESI, SESI_LAIN],
      onSelect: () => {},
      onNew: () => {},
      onClose: () => {},
      onRename: async () => {},
      onArchive: async () => {},
      onDelete: async () => {},
      notifyPrefs: { enabled: false, sound: false },
      onNotifyPrefsChange: () => {},
      ...props,
    }),
  );
}

describe("Sidebar: daftar tahanan", () => {
  test("tahanan menunggu menampilkan judul sesi dan tombol Batal", () => {
    const dibatalkan: string[] = [];
    const root = sidebar({
      held: [HELD],
      onCancelHeld: (id: string) => dibatalkan.push(id),
      onDismissHeld: () => {},
    });

    expect(root.textContent).toContain("Tertahan");
    expect(root.textContent).toContain("Menunggu Sesi lama");
    expect(root.textContent).toContain("Kerjakan tugas");

    const batal = find(root, (node) => node.localName === "button" && node.textContent === "Batal");
    expect(batal).toBeDefined();
    fire(batal!, "click");
    expect(dibatalkan).toEqual(["h1"]);
  });

  test("sesi yang ditunggu tak ada menampilkan pesan umum", () => {
    const root = sidebar({
      held: [{ ...HELD, waitForSessionId: "s9" }],
      onCancelHeld: () => {},
      onDismissHeld: () => {},
    });

    expect(root.textContent).toContain("Menunggu sesi lain");
  });

  test("tahanan terkirim menampilkan tautan sesi dan tombol tutup", () => {
    const ditutup: string[] = [];
    const dibuka: string[] = [];
    const root = sidebar({
      held: [{ ...HELD, status: "terkirim", sessionId: "s3" }],
      onCancelHeld: () => {},
      onDismissHeld: (id: string) => ditutup.push(id),
      onSelect: (id: string) => dibuka.push(id),
    });

    expect(root.textContent).toContain("Sesi dibuat");

    const tautan = find(
      root,
      (node) => node.localName === "button" && node.textContent === "Sesi dibuat",
    );
    expect(tautan).toBeDefined();
    fire(tautan!, "click");
    expect(dibuka).toEqual(["s3"]);

    const tutup = find(root, (node) => node.localName === "button" && node.textContent === "Tutup");
    expect(tutup).toBeDefined();
    fire(tutup!, "click");
    expect(ditutup).toEqual(["h1"]);
  });

  test("tahanan gagal menampilkan pesan galat dan tombol tutup", () => {
    const ditutup: string[] = [];
    const root = sidebar({
      held: [{ ...HELD, status: "gagal", error: "Sesi ditolak server" }],
      onCancelHeld: () => {},
      onDismissHeld: (id: string) => ditutup.push(id),
    });

    expect(root.textContent).toContain("Sesi ditolak server");

    const tutup = find(root, (node) => node.localName === "button" && node.textContent === "Tutup");
    expect(tutup).toBeDefined();
    fire(tutup!, "click");
    expect(ditutup).toEqual(["h1"]);
  });

  test("bagian tahanan tak tampil saat daftar kosong", () => {
    const root = sidebar({ held: [], onCancelHeld: () => {}, onDismissHeld: () => {} });
    expect(root.textContent).not.toContain("Tertahan");
  });
});

/* ---------- Hook ---------- */

describe("useHeldPrompts", () => {
  test("memanggil onDispatched saat tahanan berubah menjadi terkirim", async () => {
    let daftar: HeldPrompt[] = [HELD];
    const api = { listHeld: async () => daftar } as unknown as ApiClient;
    const dipanggil: string[] = [];
    let refresh: (() => Promise<void>) | undefined;

    function Probe() {
      const state = useHeldPrompts(api, () => dipanggil.push("dispatched"));
      refresh = state.refresh;
      return h(
        "div",
        null,
        state.held.map((item) => h("span", { key: item.id }, item.status)),
      );
    }

    const root = asElement(new FakeNode("div"));
    render(h(Probe, null), root as unknown as HTMLElement);
    await flushEffects();
    expect(root.textContent).toContain("menunggu");

    daftar = [{ ...HELD, status: "terkirim" }];
    await refresh?.();
    await flushEffects();

    expect(dipanggil).toEqual(["dispatched"]);
    expect(root.textContent).toContain("terkirim");

    render(null, root as unknown as HTMLElement);
  });

  test("galat jaringan ditelan", async () => {
    const api = {
      listHeld: async () => {
        throw new Error("jaringan mati");
      },
    } as unknown as ApiClient;
    let refresh: (() => Promise<void>) | undefined;

    function Probe() {
      const state = useHeldPrompts(api);
      refresh = state.refresh;
      return h("div", null, String(state.held.length));
    }

    const root = asElement(new FakeNode("div"));
    render(h(Probe, null), root as unknown as HTMLElement);
    await flushEffects();
    await refresh?.();

    expect(root.textContent).toContain("0");

    render(null, root as unknown as HTMLElement);
  });
});
