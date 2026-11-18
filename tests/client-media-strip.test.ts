import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { MediaStrip } from "../src/client/components/MediaStrip";
import { Timeline } from "../src/client/components/Timeline";
import type { MediaRef } from "../src/client/lib/media";
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

const CWD = "/tmp/proyek";

const ITEMS: MediaRef[] = [
  { rel: "shot.png", kind: "image", name: "shot.png" },
  { rel: "klip.mp4", kind: "video", name: "klip.mp4" },
];

/** Tunggu sampai predikat terpenuhi (efek Preact bisa tertunda). */
async function tunggu(root: FakeNode, cek: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cek(); i += 1) {
    await flushEffects();
  }
}

function dialog(root: FakeNode): FakeNode | undefined {
  return findByAttr(root, "role", "dialog");
}

function thumbs(root: FakeNode): FakeNode[] {
  return findAll(root, (node) => node.className === "jk-media-thumb");
}

function mediaSrcs(root: FakeNode): string[] {
  return findAll(
    root,
    (node) => node.localName === "img" || node.localName === "video",
  ).map((node) => node.getAttribute("src") ?? "");
}

describe("MediaStrip", () => {
  test("merender thumbnail dengan src endpoint media", async () => {
    const root = mount(h(MediaStrip, { sessionId: "s1", items: ITEMS }));
    await tunggu(root, () => thumbs(root).length === 2);

    expect(thumbs(root)).toHaveLength(2);
    expect(mediaSrcs(root)).toEqual([
      "/api/sessions/s1/media?path=shot.png",
      "/api/sessions/s1/media?path=klip.mp4",
    ]);
  });

  test("klik thumbnail membuka dialog, Esc menutupnya", async () => {
    const root = mount(h(MediaStrip, { sessionId: "s1", items: ITEMS }));
    await tunggu(root, () => thumbs(root).length === 2);

    fire(thumbs(root)[0]!, "click");
    await tunggu(root, () => dialog(root) !== undefined);
    expect(dialog(root)).toBeDefined();
    expect(dialog(root)?.getAttribute("aria-label")).toBe("Pratinjau shot.png");

    fireDocument("keydown", { key: "Escape" });
    await tunggu(root, () => dialog(root) === undefined);
    expect(dialog(root)).toBeUndefined();
  });

  test("panah kanan pindah item dan penghitung berubah", async () => {
    const root = mount(h(MediaStrip, { sessionId: "s1", items: ITEMS }));
    await tunggu(root, () => thumbs(root).length === 2);

    fire(thumbs(root)[0]!, "click");
    await tunggu(root, () => dialog(root) !== undefined);
    expect(root.textContent).toContain("1 dari 2");

    fireDocument("keydown", { key: "ArrowRight" });
    await tunggu(root, () => root.textContent.includes("2 dari 2"));
    expect(root.textContent).toContain("2 dari 2");
    expect(dialog(root)?.getAttribute("aria-label")).toBe("Pratinjau klip.mp4");
  });
});

/* ---------- Timeline ---------- */

function timeline(items: TimelineItem[], sessionId?: string): FakeNode {
  return mount(
    h(Timeline, {
      items,
      connection: "terhubung",
      cwd: CWD,
      sessionId,
      onDecide: async () => {},
    }),
  );
}

function strip(root: FakeNode): FakeNode | undefined {
  return findAll(root, (node) => node.className === "jk-media-strip")[0];
}

describe("Timeline: media dari teks agent", () => {
  test("gambar di folder kerja memunculkan strip", async () => {
    const root = timeline(
      [{ kind: "text", text: "Hasil: ![x](/tmp/proyek/shot.png)", depth: 0 }],
      "s1",
    );
    await tunggu(root, () => strip(root) !== undefined);

    expect(strip(root)).toBeDefined();
    expect(mediaSrcs(root)).toContain("/api/sessions/s1/media?path=shot.png");
  });

  test("gambar dari URL luar tidak memunculkan strip", async () => {
    const root = timeline(
      [{ kind: "text", text: "![x](https://situs.lain/a.png)", depth: 0 }],
      "s1",
    );
    await flushEffects();
    expect(strip(root)).toBeUndefined();
  });

  test("tanpa sessionId tak ada strip", async () => {
    const root = timeline([{ kind: "text", text: "![x](/tmp/proyek/shot.png)", depth: 0 }]);
    await flushEffects();
    expect(strip(root)).toBeUndefined();
  });
});
