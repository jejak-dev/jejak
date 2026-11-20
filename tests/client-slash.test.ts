import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { Composer } from "../src/client/components/Composer";
import { ReplyBar } from "../src/client/components/ReplyBar";
import { SlashMenu } from "../src/client/components/SlashMenu";
import type { ApiClient, CommandInfo, SessionCreateInput } from "../src/client/lib/api";
import { applyCommand, filterCommands, slashContext } from "../src/client/lib/slash";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import {
  find,
  findAll,
  findByAttr,
  fire,
  flushEffects as flushSekali,
  installDom,
  mount,
  type FakeNode,
} from "./helpers/dom";

/**
 * Efek Preact dan pembaruan menu lambat di runner CI yang sibuk; satu jeda 60 ms
 * kadang belum cukup, jadi tiap tunggu memakai tiga putaran.
 */
async function flushEffects(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await flushSekali();
}

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  // Komposer dan baris balasan memakai ResizeObserver; stub kosong cukup.
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

const PERINTAH: CommandInfo[] = [
  { name: "compact", description: "Padatkan percakapan jadi ringkas.", argumentHint: "" },
  { name: "context", description: "Tampilkan penggunaan konteks sesi.", argumentHint: "" },
  { name: "coba", description: "Uji coba perintah.", argumentHint: "" },
  { name: "list", description: "Daftar perintah compact yang tersedia.", argumentHint: "" },
  { name: "resume", description: "Lanjutkan kerja lama.", argumentHint: "", aliases: ["continue"] },
  { name: "init", description: "Buat berkas CLAUDE.md.", argumentHint: "[nama]" },
];

const SESI: SessionInfo = {
  id: "s1",
  title: "Sesi uji",
  prompt: "Halo",
  cwd: "/tmp/proyek",
  profileId: "lokal",
  permissionMode: "default",
  status: "selesai",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
  pendingPermissions: 0,
  queued: 0,
};

interface Panggilan {
  nama: string;
  argumen: unknown[];
}

/** Klien API tiruan: cukup untuk komposer dan baris balasan. */
function apiPalsu(daftar: Panggilan[], perintah: CommandInfo[] = PERINTAH): ApiClient {
  const base = {
    nativePickerAvailable: async (): Promise<boolean> => false,
    getSandbox: async (): Promise<never> => {
      throw new Error("sandbox tak tersedia");
    },
    listCommands: async (): Promise<{ commands: CommandInfo[]; source: "sdk" }> => ({
      commands: perintah,
      source: "sdk",
    }),
    createSession: async (input: SessionCreateInput): Promise<SessionInfo> => {
      daftar.push({ nama: "createSession", argumen: [input] });
      return SESI;
    },
    sendMessage: async (id: string, text: string): Promise<{ queued: boolean }> => {
      daftar.push({ nama: "sendMessage", argumen: [id, text] });
      return { queued: false };
    },
  };
  return base as unknown as ApiClient;
}

/** Isi kolom teks lalu picu peristiwa input. */
function isi(root: FakeNode, teks: string): void {
  const elemen = find(root, (node) => node.localName === "textarea");
  expect(elemen).toBeDefined();
  (elemen as unknown as { value: string }).value = teks;
  fire(elemen!, "input");
}

/** Nilai kolom: Preact menyetel `value` sebagai atribut bila elemen tak punya properti itu. */
function nilai(elemen: FakeNode | undefined): string {
  if (elemen === undefined) return "";
  const sebagaiProperti = (elemen as unknown as { value?: string }).value;
  if (typeof sebagaiProperti === "string") return sebagaiProperti;
  return elemen.getAttribute("value") ?? "";
}

function area(root: FakeNode): FakeNode | undefined {
  return find(root, (node) => node.localName === "textarea");
}

function opsiPerintah(root: FakeNode): FakeNode[] {
  return findAll(root, (node) => node.getAttribute("role") === "option");
}

/* ---------- Pustaka murni ---------- */

describe("slashContext", () => {
  test("garis miring di awal membuka menu dengan query kosong", () => {
    expect(slashContext("/", 1)).toEqual({ query: "" });
  });

  test("query diambil dari teks sebelum kursor", () => {
    expect(slashContext("/co", 3)).toEqual({ query: "co" });
    expect(slashContext("/compact", 3)).toEqual({ query: "co" });
  });

  test("di tengah kalimat tak membuka menu", () => {
    expect(slashContext("tulis /co", 10)).toBeUndefined();
  });

  test("setelah spasi tak membuka menu", () => {
    expect(slashContext("halo /co", 8)).toBeUndefined();
  });

  test("prompt multi-baris tak membuka menu", () => {
    expect(slashContext("/co\nlanjutan", 13)).toBeUndefined();
    expect(slashContext("baris satu\n/co", 12)).toBeUndefined();
  });

  test("karakter tak diizinkan tak membuka menu", () => {
    expect(slashContext("/co!", 4)).toBeUndefined();
    expect(slashContext("/co perintah", 11)).toBeUndefined();
  });

  test("kursor di luar teks aman", () => {
    expect(slashContext("/co", 99)).toEqual({ query: "co" });
    expect(slashContext("/co", -1)).toBeUndefined();
  });
});

describe("filterCommands", () => {
  test("nama diawali query didahulukan", () => {
    const hasil = filterCommands(PERINTAH, "co");
    // "resume" cocok lewat alias "continue"; "list" cocok lewat deskripsi.
    expect(hasil.map((c) => c.name)).toEqual([
      "compact",
      "context",
      "coba",
      "resume",
      "list",
    ]);
  });

  test("nama yang memuat query menyusul nama yang diawali", () => {
    const hasil = filterCommands(PERINTAH, "coba");
    expect(hasil[0]?.name).toBe("coba");
  });

  test("alias ikut dicocokkan", () => {
    const hasil = filterCommands(PERINTAH, "continue");
    expect(hasil.map((c) => c.name)).toEqual(["resume"]);
  });

  test("deskripsi yang memuat query tetap cocok", () => {
    const hasil = filterCommands(PERINTAH, "berkas");
    expect(hasil.map((c) => c.name)).toEqual(["init"]);
  });

  test("huruf besar kecil tak berpengaruh", () => {
    expect(filterCommands(PERINTAH, "CO").map((c) => c.name)).toEqual(
      filterCommands(PERINTAH, "co").map((c) => c.name),
    );
  });

  test("query kosong memakai semua perintah", () => {
    expect(filterCommands(PERINTAH, "")).toHaveLength(PERINTAH.length);
  });

  test("limit membatasi jumlah baris", () => {
    expect(filterCommands(PERINTAH, "c", 2)).toHaveLength(2);
    expect(filterCommands(PERINTAH, "", 3)).toHaveLength(3);
  });

  test("hasil tak cocok kosong", () => {
    expect(filterCommands(PERINTAH, "zzz")).toEqual([]);
  });
});

describe("applyCommand", () => {
  test("token awal diganti nama perintah", () => {
    expect(applyCommand("/co", 3, "compact")).toEqual({ text: "/compact ", caret: 9 });
  });

  test("teks setelah kursor dipertahankan", () => {
    expect(applyCommand("/co lalu", 3, "compact")).toEqual({
      text: "/compact  lalu",
      caret: 9,
    });
  });

  test("kolom kosong diisi perintah", () => {
    expect(applyCommand("", 0, "compact")).toEqual({ text: "/compact ", caret: 9 });
  });
});

/* ---------- Komponen SlashMenu ---------- */

describe("SlashMenu", () => {
  test("menampilkan daftar perintah", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: PERINTAH,
        status: "siap",
        source: "sdk",
        activeIndex: 0,
        onPick: () => undefined,
      }),
    );

    const listbox = findByAttr(root, "role", "listbox");
    expect(listbox).toBeDefined();
    const opsi = opsiPerintah(root);
    expect(opsi).toHaveLength(PERINTAH.length);
    expect(opsi[0]?.textContent).toContain("/compact");
  });

  test("opsi aktif ditandai aria-selected", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: PERINTAH,
        status: "siap",
        source: "sdk",
        activeIndex: 1,
        onPick: () => undefined,
      }),
    );

    const opsi = opsiPerintah(root);
    expect(opsi[0]?.getAttribute("aria-selected")).toBe("false");
    expect(opsi[1]?.getAttribute("aria-selected")).toBe("true");
  });

  test("klik opsi memanggil handler pilih", () => {
    let dipilih: string | undefined;
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: PERINTAH,
        status: "siap",
        source: "sdk",
        activeIndex: 0,
        onPick: (command: CommandInfo) => {
          dipilih = command.name;
        },
      }),
    );

    fire(opsiPerintah(root)[0]!, "click");
    expect(dipilih).toBe("compact");
  });

  test("keadaan memuat menampilkan catatan", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: [],
        status: "memuat",
        source: "sdk",
        activeIndex: 0,
        onPick: () => undefined,
      }),
    );

    expect(root.textContent).toContain("Memuat perintah…");
    expect(opsiPerintah(root)).toHaveLength(0);
  });

  test("keadaan gagal menampilkan catatan", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: [],
        status: "gagal",
        source: "sdk",
        activeIndex: 0,
        onPick: () => undefined,
      }),
    );

    expect(root.textContent).toContain("Perintah tak dapat dimuat.");
  });

  test("daftar kosong menampilkan catatan", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: [],
        status: "siap",
        source: "sdk",
        activeIndex: 0,
        onPick: () => undefined,
      }),
    );

    expect(root.textContent).toContain("Tak ada perintah cocok.");
  });

  test("catatan daftar bawaan tampil saat sumbernya bawaan", () => {
    const root = mount(
      h(SlashMenu, {
        id: "jk-slash",
        commands: PERINTAH,
        status: "siap",
        source: "bawaan",
        activeIndex: 0,
        onPick: () => undefined,
      }),
    );

    expect(root.textContent).toContain("Daftar bawaan");
  });
});

/* ---------- Composer ---------- */

describe("Composer: menu perintah slash", () => {
  test("mengetik / membuka daftar perintah", async () => {
    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "/co");
    await flushEffects();

    expect(findByAttr(root, "role", "listbox")).toBeDefined();
    const opsi = opsiPerintah(root);
    expect(opsi.length).toBeGreaterThan(0);
    expect(opsi[0]?.textContent).toContain("/compact");
  });

  test("tanpa garis miring tak ada menu", async () => {
    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "tulis kode");
    await flushEffects();

    expect(findByAttr(root, "role", "listbox")).toBeUndefined();
  });

  test("tanpa folder kerja menu tak dibuka", async () => {
    const root = mount(h(Composer, { api: apiPalsu([]), onCreated: () => {} }));

    isi(root, "/co");
    await flushEffects();

    expect(findByAttr(root, "role", "listbox")).toBeUndefined();
  });

  test("Tab mengisi kolom dengan perintah terpilih", async () => {
    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    const peristiwa = fire(kolom!, "keydown", { key: "Tab" });
    await flushEffects();

    expect(peristiwa["defaultPrevented"]).toBe(true);
    expect(nilai(kolom)).toBe("/compact ");
  });

  test("Enter saat menu terbuka tak mengirim pesan", async () => {
    const panggilan: Panggilan[] = [];
    const root = mount(
      h(Composer, {
        api: apiPalsu(panggilan),
        defaultCwd: "/tmp/proyek",
        onCreated: () => {},
      }),
    );

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    const peristiwa = fire(kolom!, "keydown", { key: "Enter" });
    await flushEffects();

    expect(peristiwa["defaultPrevented"]).toBe(true);
    expect(panggilan.some((p) => p.nama === "createSession")).toBe(false);
    expect(nilai(kolom)).toBe("/compact ");
  });

  test("Escape menutup menu sampai teks berubah", async () => {
    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "/co");
    await flushEffects();
    expect(findByAttr(root, "role", "listbox")).toBeDefined();

    fire(area(root)!, "keydown", { key: "Escape" });
    await flushEffects();
    expect(findByAttr(root, "role", "listbox")).toBeUndefined();

    isi(root, "/con");
    await flushEffects();
    expect(findByAttr(root, "role", "listbox")).toBeDefined();
  });

  test("ArrowDown menggeser pilihan aktif", async () => {
    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    // Tunggu menu benar-benar punya dua opsi agar tidak bergantung pada jeda tetap.
    for (let i = 0; i < 40 && opsiPerintah(root).length < 2; i += 1) await flushEffects();
    expect(opsiPerintah(root).length).toBeGreaterThanOrEqual(2);
    fire(kolom!, "keydown", { key: "ArrowDown" });
    for (
      let i = 0;
      i < 40 && opsiPerintah(root)[1]?.getAttribute("aria-selected") !== "true";
      i += 1
    ) {
      await flushEffects();
    }

    const opsi = opsiPerintah(root);
    expect(opsi[0]?.getAttribute("aria-selected")).toBe("false");
    expect(opsi[1]?.getAttribute("aria-selected")).toBe("true");
    expect(kolom?.getAttribute("aria-activedescendant")).toBe(
      opsi[1]?.getAttribute("id"),
    );
  });

  test("textarea punya atribut ARIA combobox", async () => {    const root = mount(
      h(Composer, { api: apiPalsu([]), defaultCwd: "/tmp/proyek", onCreated: () => {} }),
    );

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    expect(kolom?.getAttribute("role")).toBe("combobox");
    expect(kolom?.getAttribute("aria-expanded")).toBe("true");
    const controls = kolom?.getAttribute("aria-controls");
    expect(controls).toBeDefined();
    expect(kolom?.getAttribute("aria-activedescendant")).toContain("opsi");
  });
});

/* ---------- ReplyBar ---------- */

describe("ReplyBar: menu perintah slash", () => {
  function barisBalasan(panggilan: Panggilan[]): FakeNode {
    return mount(
      h(ReplyBar, {
        api: apiPalsu(panggilan),
        session: SESI,
        refresh: async (): Promise<void> => undefined,
        onInterrupt: () => undefined,
        interrupting: false,
      }),
    );
  }

  test("mengetik / membuka daftar perintah", async () => {
    const root = barisBalasan([]);

    isi(root, "/co");
    await flushEffects();

    expect(findByAttr(root, "role", "listbox")).toBeDefined();
    expect(opsiPerintah(root)[0]?.textContent).toContain("/compact");
  });

  test("tanpa garis miring tak ada menu", async () => {
    const root = barisBalasan([]);

    isi(root, "halo");
    await flushEffects();

    expect(findByAttr(root, "role", "listbox")).toBeUndefined();
  });

  test("Enter saat menu terbuka tak mengirim pesan", async () => {
    const panggilan: Panggilan[] = [];
    const root = barisBalasan(panggilan);

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    const peristiwa = fire(kolom!, "keydown", { key: "Enter" });
    await flushEffects();

    expect(peristiwa["defaultPrevented"]).toBe(true);
    expect(panggilan.some((p) => p.nama === "sendMessage")).toBe(false);
    expect(nilai(kolom)).toBe("/compact ");
  });

  test("Tab mengisi kolom dengan perintah terpilih", async () => {
    const root = barisBalasan([]);

    isi(root, "/co");
    await flushEffects();

    const kolom = area(root);
    fire(kolom!, "keydown", { key: "Tab" });
    await flushEffects();

    expect(nilai(kolom)).toBe("/compact ");
  });

  test("Enter tanpa menu tetap mengirim pesan", async () => {
    const panggilan: Panggilan[] = [];
    const root = barisBalasan(panggilan);

    isi(root, "halo");
    await flushEffects();

    fire(area(root)!, "keydown", { key: "Enter" });
    await flushEffects();

    const kirim = panggilan.find((p) => p.nama === "sendMessage");
    expect(kirim).toBeDefined();
    expect(kirim?.argumen[1]).toBe("halo");
  });
});
