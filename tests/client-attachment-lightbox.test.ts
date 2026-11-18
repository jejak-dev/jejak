import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { AttachmentTray } from "../src/client/components/AttachmentParts";
import { Timeline } from "../src/client/components/Timeline";
import type { Attachment } from "../src/client/lib/attachments";
import type { TimelineItem } from "../src/client/lib/timeline";
import {
  FakeNode,
  findAll,
  findByAttr,
  fire,
  fireDocument,
  flushEffects,
  installDom,
  mount,
} from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  // DOM tiruan tak punya pemutaran video; lightbox memanggil `pause()`.
  (FakeNode.prototype as unknown as { pause: () => void }).pause = () => {};
});

afterAll(() => {
  bersihkan?.();
});

/** Tunggu sampai predikat terpenuhi (efek Preact bisa tertunda). */
async function tunggu(root: FakeNode, cek: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cek(); i += 1) {
    await flushEffects();
  }
}

function dialog(root: FakeNode): FakeNode | undefined {
  return findByAttr(root, "role", "dialog");
}

function byClass(root: FakeNode, className: string): FakeNode[] {
  return findAll(root, (node) => node.className === className);
}

const att = (name: string, id: string): Attachment => ({
  id,
  name,
  path: `/home/u/.jejak/attachments/${id}/${name}`,
  size: 10,
  image: /\.png$/.test(name),
});

const ITEMS: Attachment[] = [att("a.png", "0123456789ab"), att("b.txt", "ba9876543210")];

describe("AttachmentTray: pratinjau gambar", () => {
  test("klik thumbnail membuka dialog dengan URL lampiran", async () => {
    const root = mount(
      h(AttachmentTray, { items: ITEMS, pending: 0, onRemove: () => {} }),
    );
    await tunggu(root, () => byClass(root, "jk-att-thumb-btn").length === 1);

    fire(byClass(root, "jk-att-thumb-btn")[0]!, "click");
    await tunggu(root, () => dialog(root) !== undefined);

    expect(dialog(root)).toBeDefined();
    expect(dialog(root)?.getAttribute("aria-label")).toBe("Pratinjau a.png");
    const img = findAll(root, (node) => node.localName === "img").find(
      (node) => node.className === "jk-media-lightbox-view",
    );
    expect(img?.getAttribute("src")).toBe("/api/attachments/0123456789ab/a.png");
  });

  test("Esc menutup dialog", async () => {
    const root = mount(
      h(AttachmentTray, { items: ITEMS, pending: 0, onRemove: () => {} }),
    );
    await tunggu(root, () => byClass(root, "jk-att-thumb-btn").length === 1);

    fire(byClass(root, "jk-att-thumb-btn")[0]!, "click");
    await tunggu(root, () => dialog(root) !== undefined);

    fireDocument("keydown", { key: "Escape" });
    await tunggu(root, () => dialog(root) === undefined);
    expect(dialog(root)).toBeUndefined();
  });

  test("tombol hapus tidak membuka dialog", async () => {
    const removed: string[] = [];
    const root = mount(
      h(AttachmentTray, {
        items: ITEMS,
        pending: 0,
        onRemove: (id: string) => removed.push(id),
      }),
    );
    await tunggu(root, () => byClass(root, "jk-att-remove").length === 2);

    fire(byClass(root, "jk-att-remove")[0]!, "click");
    await flushEffects();

    expect(removed).toEqual(["0123456789ab"]);
    expect(dialog(root)).toBeUndefined();
  });
});

describe("Timeline: pratinjau gambar lampiran pesan", () => {
  const text = "Lihat\n\nLampiran:\n- /home/u/.jejak/attachments/0123456789ab/a.png";

  function timeline(items: TimelineItem[]): FakeNode {
    return mount(
      h(Timeline, {
        items,
        connection: "terhubung",
        cwd: "/tmp/proyek",
        onDecide: async () => {},
      }),
    );
  }

  test("klik gambar lampiran membuka dialog, bukan tab baru", async () => {
    const root = timeline([{ kind: "user", text, seq: 1 }]);
    await tunggu(root, () => byClass(root, "jk-user-att-btn").length === 1);

    expect(findAll(root, (node) => node.localName === "a")).toHaveLength(0);

    fire(byClass(root, "jk-user-att-btn")[0]!, "click");
    await tunggu(root, () => dialog(root) !== undefined);

    expect(dialog(root)?.getAttribute("aria-label")).toBe("Pratinjau a.png");
    const img = findAll(root, (node) => node.localName === "img").find(
      (node) => node.className === "jk-media-lightbox-view",
    );
    expect(img?.getAttribute("src")).toBe("/api/attachments/0123456789ab/a.png");
  });
});
