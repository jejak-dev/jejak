import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { PluginBrowser } from "../src/client/components/PluginBrowser";
import type {
  ApiClient,
  MarketplacePluginItem,
  MarketplaceSearchInput,
} from "../src/client/lib/api";
import { find, fire, flushEffects, installDom, mount, type FakeNode } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Data bantu ---------- */

function plugin(overrides: Partial<MarketplacePluginItem> = {}): MarketplacePluginItem {
  return {
    id: "alpha@pasar",
    name: "alpha",
    displayName: "Alpa",
    marketplace: "pasar",
    description: "Plugin contoh untuk menguji penelusuran",
    author: "Penulis",
    category: "Alat",
    homepage: "https://contoh.example",
    version: "1.0.0",
    tags: ["demo"],
    sourceKind: "marketplace",
    installed: false,
    ...overrides,
  };
}

interface Opsi {
  /** Plugin yang tersedia di katalog. */
  items?: MarketplacePluginItem[];
  /** Hasil pencarian yang dikembalikan server. */
  hasil?: { ok: boolean; message: string };
  /** Hasil penambahan marketplace; bawaan sukses. */
  tambah?: { ok: boolean; message: string };
}

interface Panggilan {
  cari: MarketplaceSearchInput[];
  pasang: string[];
  copot: string[];
  tambah: string[];
}

function apiPalsu(opsi: Opsi = {}): { api: ApiClient; panggilan: Panggilan } {
  const panggilan: Panggilan = { cari: [], pasang: [], copot: [], tambah: [] };
  const katalog = opsi.items ?? [plugin()];
  const base = {
    listMarketplaces: async () => [
      {
        name: "pasar",
        description: "Marketplace contoh",
        pluginCount: katalog.length,
        lastUpdated: "2026-01-01",
      },
    ],
    searchMarketplace: async (params?: MarketplaceSearchInput) => {
      panggilan.cari.push(params ?? {});
      const query = (params?.query ?? "").toLowerCase();
      const cocok =
        query === ""
          ? katalog
          : katalog.filter(
              (item) =>
                item.name.includes(query) || item.displayName.toLowerCase().includes(query),
            );
      return {
        items: cocok,
        total: cocok.length,
        categories: ["Alat"],
      };
    },
    installPlugin: async (id: string) => {
      panggilan.pasang.push(id);
      return opsi.hasil ?? { ok: true, message: "Plugin terpasang." };
    },
    uninstallPlugin: async (id: string) => {
      panggilan.copot.push(id);
      return { ok: true, message: "Plugin dicopot." };
    },
    addMarketplace: async (sumber: string) => {
      panggilan.tambah.push(sumber);
      return opsi.tambah ?? { ok: true, message: "Marketplace ditambahkan." };
    },
  };
  return { api: base as unknown as ApiClient, panggilan };
}

/** Tombol pertama yang teksnya sama persis. */
function tombol(root: FakeNode, teks: string): FakeNode | undefined {
  return find(
    root,
    (node) => node.localName === "button" && node.textContent?.trim() === teks,
  );
}

/** Isi kolom pencarian lalu picu peristiwa input. */
async function cari(root: FakeNode, teks: string): Promise<void> {
  const input = find(
    root,
    (node) => node.localName === "input" && node.getAttribute("type") === "search",
  );
  expect(input).toBeDefined();
  (input as unknown as { value: string }).value = teks;
  fire(input!, "input");
  await flushEffects();
}

/** Tunggu jeda pencarian (debounce) lalu flush efek. */
async function tungguDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  await flushEffects();
}

/* ---------- Tampilan ---------- */

describe("penjelajahan marketplace", () => {
  test("render awal menampilkan plugin dari katalog", async () => {
    const { api } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    expect(node.textContent).toContain("Alpa");
    expect(node.textContent).toContain("1.0.0");
    expect(node.textContent).toContain("pasar");
    expect(node.textContent).toContain("Alat");
    expect(node.textContent).toContain("Plugin contoh untuk menguji penelusuran");
    expect(node.textContent).toContain("Penulis");
  });

  test("tautan beranda membuka tab baru dengan aman", async () => {
    const { api } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    const tautan = find(
      node,
      (candidate) => candidate.localName === "a" && candidate.getAttribute("href") !== null,
    );
    expect(tautan?.getAttribute("href")).toBe("https://contoh.example");
    expect(tautan?.getAttribute("target")).toBe("_blank");
    expect(tautan?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("hasil pencarian tampil setelah jeda ketikan", async () => {
    const { api, panggilan } = apiPalsu({
      items: [plugin(), plugin({ id: "beta@pasar", name: "beta", displayName: "Bela" })],
    });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    await cari(node, "beta");
    await tungguDebounce();

    const terakhir = panggilan.cari[panggilan.cari.length - 1];
    expect(terakhir?.query).toBe("beta");
    expect(node.textContent).toContain("Bela");
    expect(node.textContent).not.toContain("Alpa");
  });

  test("kartu bertipe command menampilkan peringatan menonjol", async () => {
    const { api } = apiPalsu({
      items: [plugin({ sourceKind: "command" })],
    });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    expect(node.textContent).toContain(
      "Plugin ini memasang lewat perintah yang dideklarasikan marketplace; periksa sumbernya sebelum memasang.",
    );
  });

  test("katalog kosong menampilkan pesan tak ada plugin yang cocok", async () => {
    const { api } = apiPalsu({ items: [] });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    expect(node.textContent).toContain("Tak ada plugin yang cocok.");
  });

  test("tiap plugin menjadi baris dengan avatar ikon, nama, deskripsi, dan meta", async () => {
    const { api } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    const baris = find(node, (item) => item.getAttribute("class") === "jk-plugin-row");
    expect(baris?.localName).toBe("li");

    const avatar = find(
      baris!,
      (item) => item.getAttribute("class") === "jk-plugin-avatar",
    );
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(find(avatar!, (item) => item.localName === "svg")).toBeDefined();

    expect(baris?.textContent).toContain("Alpa");
    expect(baris?.textContent).toContain("Plugin contoh untuk menguji penelusuran");
    expect(baris?.textContent).toContain("Oleh Penulis");
  });

  test("chip kategori menandai pilihan dan memicu pencarian kategori", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    const grup = find(node, (item) => item.getAttribute("role") === "group");
    expect(grup?.getAttribute("aria-label")).toBe("Kategori");

    const semua = find(
      grup!,
      (item) => item.localName === "button" && item.textContent?.trim() === "Semua",
    );
    const alat = find(
      grup!,
      (item) => item.localName === "button" && item.textContent?.trim() === "Alat",
    );
    expect(semua?.getAttribute("aria-pressed")).toBe("true");
    expect(alat?.getAttribute("aria-pressed")).toBe("false");

    fire(alat!, "click");
    await flushEffects();

    expect(alat?.getAttribute("aria-pressed")).toBe("true");
    expect(semua?.getAttribute("aria-pressed")).toBe("false");
    const terakhir = panggilan.cari[panggilan.cari.length - 1];
    expect(terakhir?.category).toBe("Alat");
  });
});

/* ---------- Pemasangan ---------- */

describe("pemasangan plugin dari marketplace", () => {
  test("konfirmasi muncul sebelum memasang dan API tak dipanggil lebih dulu", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    fire(tombol(node, "Pasang")!, "click");
    await flushEffects();

    expect(panggilan.pasang).toEqual([]);
    expect(node.textContent).toContain("Pasang Alpa (pasar)");
    expect(node.textContent).toContain("Plugin tidak dinyalakan otomatis setelah dipasang.");
    expect(tombol(node, "Ya, pasang")).toBeDefined();
  });

  test("menekan 'Ya, pasang' memasang plugin dan menampilkan pesan sukses", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    fire(tombol(node, "Pasang")!, "click");
    await flushEffects();
    fire(tombol(node, "Ya, pasang")!, "click");
    await flushEffects();

    expect(panggilan.pasang).toEqual(["alpha@pasar"]);
    expect(node.textContent).toContain(
      "Terpasang. Nyalakan di tab Terpasang agar dipakai sesi berikutnya.",
    );
  });

  test("kegagalan menampilkan pesan server apa adanya", async () => {
    const { api } = apiPalsu({
      hasil: { ok: false, message: "Sumber plugin tak bisa dijangkau." },
    });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    fire(tombol(node, "Pasang")!, "click");
    await flushEffects();
    fire(tombol(node, "Ya, pasang")!, "click");
    await flushEffects();

    expect(node.textContent).toContain("Sumber plugin tak bisa dijangkau.");
  });

  test("tombol Batal menutup konfirmasi tanpa memasang", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    fire(tombol(node, "Pasang")!, "click");
    await flushEffects();
    fire(tombol(node, "Batal")!, "click");
    await flushEffects();

    expect(panggilan.pasang).toEqual([]);
    expect(tombol(node, "Ya, pasang")).toBeUndefined();
  });

  test("plugin terpasang menampilkan tombol Terpasang dan Copot", async () => {
    const { api } = apiPalsu({ items: [plugin({ installed: true })] });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    expect(tombol(node, "Terpasang")).toBeDefined();
    expect(tombol(node, "Copot")).toBeDefined();
    expect(tombol(node, "Pasang")).toBeUndefined();
  });
});

/** Isi kolom sumber marketplace. */
function isiSumber(root: FakeNode, teks: string): void {
  const input = find(
    root,
    (node) =>
      node.localName === "input" && node.getAttribute("aria-label") === "Sumber marketplace",
  );
  expect(input).toBeDefined();
  (input as unknown as { value: string }).value = teks;
  fire(input!, "input");
}

describe("tambah marketplace", () => {
  test("konfirmasi muncul dulu dan API tak dipanggil sebelum 'Ya, tambah'", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    isiSumber(node, "anti/slop");
    await flushEffects();
    fire(tombol(node, "Tambah")!, "click");
    await flushEffects();

    expect(node.textContent).toContain("Mengunduh kode dari anti/slop. Lanjutkan?");
    expect(panggilan.tambah).toEqual([]);
  });

  test("'Ya, tambah' memanggil API dan menampilkan pesan sukses", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    isiSumber(node, "anti/slop");
    await flushEffects();
    fire(tombol(node, "Tambah")!, "click");
    await flushEffects();
    fire(tombol(node, "Ya, tambah")!, "click");
    await flushEffects();

    expect(panggilan.tambah).toEqual(["anti/slop"]);
    expect(node.textContent).toContain("Marketplace ditambahkan.");
    expect(tombol(node, "Ya, tambah")).toBeUndefined();
  });

  test("kegagalan menampilkan pesan server", async () => {
    const { api } = apiPalsu({ tambah: { ok: false, message: "Repo tak ditemukan." } });
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    isiSumber(node, "anti/slop");
    await flushEffects();
    fire(tombol(node, "Tambah")!, "click");
    await flushEffects();
    fire(tombol(node, "Ya, tambah")!, "click");
    await flushEffects();

    expect(node.textContent).toContain("Repo tak ditemukan.");
  });

  test("Batal menutup konfirmasi tanpa memanggil API", async () => {
    const { api, panggilan } = apiPalsu();
    const node = mount(h(PluginBrowser, { api }));
    await flushEffects();

    isiSumber(node, "anti/slop");
    await flushEffects();
    fire(tombol(node, "Tambah")!, "click");
    await flushEffects();
    fire(tombol(node, "Batal")!, "click");
    await flushEffects();

    expect(panggilan.tambah).toEqual([]);
    expect(tombol(node, "Ya, tambah")).toBeUndefined();
  });
});
