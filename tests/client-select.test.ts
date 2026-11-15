import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { h } from "preact";
import { Select, SelectMenu, SelectTrigger } from "../src/client/components/Select";
import {
  firstEnabledIndex,
  lastEnabledIndex,
  menuPlacement,
  nextEnabledIndex,
  typeAheadIndex,
  MENU_EDGE,
  MENU_GAP,
  type SelectOption,
} from "../src/client/lib/select";
import {
  activeElement,
  find,
  findAll,
  findByAttr,
  fire,
  fireDocument,
  flushEffects,
  installDom,
  mount,
  setViewport,
  type FakeNode,
} from "./helpers/dom";

/* ---------- Penjaga: tak ada `<select>` native ---------- */

const CLIENT_DIR = join(import.meta.dir, "..", "src", "client");

function berkasKlien(dir: string): string[] {
  const keluar: string[] = [];
  for (const nama of readdirSync(dir)) {
    const path = join(dir, nama);
    if (statSync(path).isDirectory()) keluar.push(...berkasKlien(path));
    else if (/\.(ts|tsx)$/.test(nama)) keluar.push(path);
  }
  return keluar;
}

test("kode src/client tak memakai elemen select native", () => {
  const ditemukan: string[] = [];
  for (const path of berkasKlien(CLIENT_DIR)) {
    if (path.endsWith(join("components", "Select.tsx"))) continue;
    if (readFileSync(path, "utf8").includes("<select")) ditemukan.push(path);
  }
  expect(ditemukan).toEqual([]);
});

/* ---------- Logika murni ---------- */

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

const OPSI: SelectOption[] = [
  { value: "a", label: "Alfa" },
  { value: "b", label: "Bravo", disabled: true },
  { value: "c", label: "Charlie" },
  { value: "d", label: "Delta" },
];

describe("logika Select", () => {
  test("navigasi lewati opsi disabled dan berputar", () => {
    expect(nextEnabledIndex(OPSI, 0, 1)).toBe(2);
    expect(nextEnabledIndex(OPSI, 2, 1)).toBe(3);
    expect(nextEnabledIndex(OPSI, 3, 1)).toBe(0);
    expect(nextEnabledIndex(OPSI, 0, -1)).toBe(3);
    expect(nextEnabledIndex(OPSI, 2, -1)).toBe(0);
  });

  test("indeks pertama dan terakhir hanya mengambil yang aktif", () => {
    expect(firstEnabledIndex(OPSI)).toBe(0);
    expect(lastEnabledIndex(OPSI)).toBe(3);
    expect(firstEnabledIndex([{ value: "x", label: "X", disabled: true }])).toBe(-1);
    expect(lastEnabledIndex([])).toBe(-1);
  });

  test("ketik-huruf-awal melompat ke opsi yang diawali huruf", () => {
    expect(typeAheadIndex(OPSI, "c", -1)).toBe(2);
    expect(typeAheadIndex(OPSI, "d", 0)).toBe(3);
    expect(typeAheadIndex(OPSI, "z", -1)).toBe(-1);
  });

  test("ketik-huruf-awal melewati opsi disabled", () => {
    const opsi: SelectOption[] = [
      { value: "x", label: "X-ray", disabled: true },
      { value: "y", label: "X-ray aktif" },
    ];
    expect(typeAheadIndex(opsi, "x", -1)).toBe(1);
  });

  test("menu dibuka ke bawah bila ruang cukup", () => {
    const posisi = menuPlacement(
      { top: 100, left: 20, width: 180, height: 32, bottom: 132 },
      { width: 1024, height: 768 },
      200,
      180,
    );
    expect(posisi.flipped).toBe(false);
    expect(posisi.top).toBe(132 + MENU_GAP);
    expect(posisi.left).toBe(20);
    expect(posisi.maxHeight).toBe(768 - 132 - MENU_GAP);
  });

  test("menu dibuka ke atas bila tak muat ke bawah", () => {
    const posisi = menuPlacement(
      { top: 600, left: 20, width: 180, height: 32, bottom: 632 },
      { width: 1024, height: 768 },
      300,
      180,
    );
    expect(posisi.flipped).toBe(true);
    expect(posisi.top).toBeLessThan(600);
  });

  test("menu tetap di dalam layar walau ruangnya sempit", () => {
    const posisi = menuPlacement(
      { top: 10, left: 900, width: 180, height: 32, bottom: 42 },
      { width: 1024, height: 768 },
      200,
      180,
    );
    expect(posisi.left).toBeLessThanOrEqual(1024 - MENU_EDGE);
    expect(posisi.left).toBeGreaterThanOrEqual(MENU_EDGE);
    expect(posisi.top).toBeGreaterThanOrEqual(MENU_EDGE);
  });

  test("menu lebarnya dibatasi dan rata kanan bila diminta", () => {
    const posisi = menuPlacement(
      { top: 100, left: 800, width: 180, height: 32, bottom: 132 },
      { width: 1024, height: 768 },
      100,
      900,
      "end",
    );
    expect(posisi.left + 180).toBeLessThanOrEqual(1024 - MENU_EDGE);
  });
});

/* ---------- Tampilan ---------- */

function pemicu(root: FakeNode): FakeNode | undefined {
  return find(root, (el) => el.className.split(" ").includes("jk-select"));
}

function opsiMenu(root: FakeNode): FakeNode[] {
  return findAll(root, (el) => el.getAttribute("role") === "option");
}

describe("tampilan Select", () => {
  test("pemicu menampilkan label opsi terpilih dan atribut aria", () => {
    const node = mount(
      h(SelectTrigger, {
        id: "jk-s",
        value: "b",
        options: OPSI,
        open: false,
        onToggle: () => {},
        onKeyDown: () => {},
      }),
    );
    const tombol = pemicu(node);
    expect(tombol?.getAttribute("id")).toBe("jk-s");
    expect(tombol?.textContent).toContain("Bravo");
    expect(tombol?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(tombol?.getAttribute("aria-expanded")).toBe("false");
  });

  test("pemicu menampilkan placeholder bila nilai tak cocok opsi", () => {
    const node = mount(
      h(SelectTrigger, {
        value: "zzz",
        options: OPSI,
        placeholder: "Pilih.…",
        open: false,
        onToggle: () => {},
        onKeyDown: () => {},
      }),
    );
    expect(pemicu(node)?.textContent).toContain("Pilih.…");
  });

  test("pemicu menandai invalid dan disabled", () => {
    const node = mount(
      h(SelectTrigger, {
        value: "a",
        options: OPSI,
        open: false,
        invalid: true,
        disabled: true,
        onToggle: () => {},
        onKeyDown: () => {},
      }),
    );
    const tombol = pemicu(node);
    expect(tombol?.getAttribute("aria-invalid")).toBe("true");
    expect(tombol?.getAttribute("disabled")).not.toBeNull();
  });

  test("menu menampilkan opsi dengan role, centang, dan status disabled", () => {
    const node = mount(
      h(SelectMenu, {
        id: "jk-s-menu",
        options: OPSI,
        value: "c",
        activeIndex: 2,
        onPick: () => {},
        onKeyDown: () => {},
        onHover: () => {},
      }),
    );
    const menu = findByAttr(node, "role", "listbox");
    expect(menu?.getAttribute("id")).toBe("jk-s-menu");
    const opsi = opsiMenu(node);
    expect(opsi).toHaveLength(4);
    expect(opsi.map((el) => el.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(opsi[1]?.getAttribute("aria-disabled")).toBe("true");
    expect(opsi[1]?.getAttribute("disabled")).not.toBeNull();
    // Opsi terpilih memuat ikon centang (svg), opsi lain tidak.
    expect(findAll(opsi[2] as FakeNode, (el) => el.localName === "svg")).toHaveLength(1);
    expect(findAll(opsi[0] as FakeNode, (el) => el.localName === "svg")).toHaveLength(0);
  });

  test("klik opsi memanggil onPick sekali dengan nilainya", () => {
    const dipanggil: string[] = [];
    const node = mount(
      h(SelectMenu, {
        id: "jk-s-menu",
        options: OPSI,
        value: "a",
        activeIndex: 0,
        onPick: (value: string) => {
          dipanggil.push(value);
        },
        onKeyDown: () => {},
        onHover: () => {},
      }),
    );
    const opsi = opsiMenu(node);
    fire(opsi[2] as FakeNode, "click");
    expect(dipanggil).toEqual(["c"]);
  });
});

/* ---------- Perilaku ---------- */

describe("perilaku Select", () => {
  test("klik pemicu membuka menu dan mengubah aria-expanded", async () => {
    setViewport(1024, 768);
    const node = mount(
      h(Select, {
        value: "a",
        options: OPSI,
        ariaLabel: "Pilih satu",
        onChange: () => {},
      }),
    );
    const tombol = pemicu(node);
    expect(tombol?.getAttribute("aria-expanded")).toBe("false");
    fire(tombol as FakeNode, "click");
    await flushEffects();
    expect(tombol?.getAttribute("aria-expanded")).toBe("true");
    expect(findByAttr(node, "role", "listbox")).toBeDefined();
    expect(tombol?.getAttribute("aria-label")).toBe("Pilih satu");
  });

  test("memilih opsi memanggil onChange sekali", async () => {
    setViewport(1024, 768);
    const perubahan: string[] = [];
    const node = mount(
      h(Select, {
        value: "a",
        options: OPSI,
        onChange: (value: string) => perubahan.push(value),
      }),
    );
    fire(pemicu(node) as FakeNode, "click");
    await flushEffects();
    fire(opsiMenu(node)[2] as FakeNode, "click");
    await flushEffects();
    expect(perubahan).toEqual(["c"]);
  });

  test("memilih nilai yang sama tidak memanggil onChange", async () => {
    setViewport(1024, 768);
    const perubahan: string[] = [];
    const node = mount(
      h(Select, {
        value: "a",
        options: OPSI,
        onChange: (value: string) => perubahan.push(value),
      }),
    );
    fire(pemicu(node) as FakeNode, "click");
    await flushEffects();
    fire(opsiMenu(node)[0] as FakeNode, "click");
    await flushEffects();
    expect(perubahan).toEqual([]);
  });

  test("opsi disabled tak bisa dipilih", async () => {
    setViewport(1024, 768);
    const perubahan: string[] = [];
    const node = mount(
      h(Select, {
        value: "a",
        options: OPSI,
        onChange: (value: string) => perubahan.push(value),
      }),
    );
    fire(pemicu(node) as FakeNode, "click");
    await flushEffects();
    fire(opsiMenu(node)[1] as FakeNode, "click");
    await flushEffects();
    expect(perubahan).toEqual([]);
  });

  test("keyboard membuka menu dan memilih opsi", async () => {
    setViewport(1024, 768);
    const perubahan: string[] = [];
    const node = mount(
      h(Select, {
        value: "a",
        options: OPSI,
        onChange: (value: string) => perubahan.push(value),
      }),
    );
    const tombol = pemicu(node);
    fire(tombol as FakeNode, "keydown", { key: "ArrowDown" });
    await flushEffects();
    expect(tombol?.getAttribute("aria-expanded")).toBe("true");
    // Panah bawah melompati opsi disabled (indeks 1) ke indeks 2.
    fire(findByAttr(node, "role", "listbox") as FakeNode, "keydown", { key: "ArrowDown" });
    await flushEffects();
    expect(opsiMenu(node)[2]?.className.split(" ")).toContain("jk-dd-item-active");
    fire(opsiMenu(node)[2] as FakeNode, "keydown", { key: "Enter" });
    await flushEffects();
    expect(perubahan).toEqual(["c"]);
  });

  test("klik di luar menutup menu", async () => {
    setViewport(1024, 768);
    const node = mount(h(Select, { value: "a", options: OPSI, onChange: () => {} }));
    fire(pemicu(node) as FakeNode, "click");
    await flushEffects();
    expect(findByAttr(node, "role", "listbox")).toBeDefined();
    fireDocument("pointerdown");
    await flushEffects();
    expect(findByAttr(node, "role", "listbox")).toBeUndefined();
  });

  test("Escape menutup menu dan mengembalikan fokus ke pemicu", async () => {
    setViewport(1024, 768);
    const node = mount(h(Select, { value: "a", options: OPSI, onChange: () => {} }));
    const tombol = pemicu(node);
    fire(tombol as FakeNode, "click");
    await flushEffects();
    fire(tombol as FakeNode, "keydown", { key: "Escape" });
    await flushEffects();
    expect(findByAttr(node, "role", "listbox")).toBeUndefined();
    expect(activeElement()).toBe(tombol ?? null);
  });

  test("pemicu disabled tak membuka menu", async () => {
    setViewport(1024, 768);
    const node = mount(
      h(Select, { value: "a", options: OPSI, disabled: true, onChange: () => {} }),
    );
    fire(pemicu(node) as FakeNode, "click");
    await flushEffects();
    expect(findByAttr(node, "role", "listbox")).toBeUndefined();
  });
});
