import { afterAll, describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import { Markdown } from "../src/client/components/Markdown";
import {
  activeElement,
  findAll,
  findByAttr,
  fire,
  fireDocument,
  flushEffects,
  installDom,
  mount,
  type FakeNode,
} from "./helpers/dom";

const bersihkan = installDom();
afterAll(bersihkan);

const tabel = "## Keterangan\n\n| Kolom | Isi |\n| --- | --- |\n| `pegawai_id` | panjang |";

function tombolPerbesar(root: FakeNode): FakeNode | undefined {
  return findByAttr(root, "aria-label", "Perbesar tabel");
}

describe("tabel pratinjau berkas (rich)", () => {
  test("rich menampilkan tombol Perbesar tabel dan isi tabel", () => {
    const root = mount(Markdown({ text: tabel, rich: true }) as VNode);
    expect(tombolPerbesar(root)).toBeDefined();
    expect(root.textContent).toContain("pegawai_id");
    const scroll = findAll(root, (node) => node.className.includes("jk-md-table-scroll"));
    expect(scroll).toHaveLength(1);
    expect(findAll(root, (node) => node.localName === "table")).toHaveLength(1);
  });

  test("tanpa rich tidak ada tombol Perbesar tabel", () => {
    const root = mount(Markdown({ text: tabel }) as VNode);
    expect(tombolPerbesar(root)).toBeUndefined();
    expect(findAll(root, (node) => node.localName === "table")).toHaveLength(1);
  });

  test("klik Perbesar membuka dialog berjudul heading terdekat", async () => {
    const root = mount(Markdown({ text: tabel, rich: true }) as VNode);
    const tombol = tombolPerbesar(root);
    if (tombol === undefined) throw new Error("tombol tidak ada");
    fire(tombol, "click");
    await flushEffects();

    const dialog = findByAttr(root, "role", "dialog");
    expect(dialog).toBeDefined();
    expect((dialog as FakeNode).getAttribute("aria-label")).toBe("Keterangan");
    expect(findByAttr(dialog as FakeNode, "aria-label", "Tutup")).toBeDefined();
    expect((dialog as FakeNode).textContent).toContain("pegawai_id");
    const tabelModal = findAll(dialog as FakeNode, (node) => node.localName === "table");
    expect(tabelModal).toHaveLength(1);
    expect(activeElement()?.getAttribute("aria-label")).toBe("Tutup");
  });

  test("Escape menutup dialog dan fokus kembali ke Perbesar", async () => {
    const root = mount(Markdown({ text: tabel, rich: true }) as VNode);
    const tombol = tombolPerbesar(root);
    if (tombol === undefined) throw new Error("tombol tidak ada");
    fire(tombol, "click");
    await flushEffects();
    expect(findByAttr(root, "role", "dialog")).toBeDefined();

    fireDocument("keydown", { key: "Escape" });
    await flushEffects();
    expect(findByAttr(root, "role", "dialog")).toBeUndefined();
    expect(activeElement()?.getAttribute("aria-label")).toBe("Perbesar tabel");
  });

  test("klik backdrop menutup dialog", async () => {
    const root = mount(Markdown({ text: tabel, rich: true }) as VNode);
    const tombol = tombolPerbesar(root);
    if (tombol === undefined) throw new Error("tombol tidak ada");
    fire(tombol, "click");
    await flushEffects();

    const backdrop = findAll(root, (node) =>
      node.className.includes("jk-md-table-modal-backdrop"),
    )[0];
    if (backdrop === undefined) throw new Error("backdrop tidak ada");
    fire(backdrop, "pointerdown");
    await flushEffects();
    expect(findByAttr(root, "role", "dialog")).toBeUndefined();
  });
});
