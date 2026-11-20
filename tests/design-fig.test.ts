import { describe, expect, test } from "bun:test";
import { parseFigBuffer } from "@open-pencil/fig";
import { buildFig, fontStyle, resolveFont } from "../src/server/design/fig";
import type { SceneDoc } from "../src/server/design/scene";

const putih = { r: 1, g: 1, b: 1, a: 1 };
const hitam = { r: 0, g: 0, b: 0, a: 1 };

function contoh(): SceneDoc {
  return {
    name: "Rumah Tepi Danau",
    pages: [
      {
        name: "Beranda",
        width: 1440,
        height: 900,
        root: {
          kind: "box",
          name: "body",
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          fill: putih,
          children: [
            {
              kind: "box",
              name: "tombol",
              x: 80,
              y: 200,
              width: 240,
              height: 56,
              fill: { r: 0.7, g: 0.15, b: 0.12, a: 1 },
              radius: [8, 8, 0, 0],
              clip: true,
              stroke: { color: hitam, weight: 2 },
            },
            {
              kind: "text",
              name: "judul",
              x: 80,
              y: 100,
              width: 600,
              height: 60,
              text: {
                characters: "Rumah Tepi Danau",
                fontSize: 48,
                fontFamily: "Inter",
                fontWeight: 700,
                italic: false,
                color: hitam,
                align: "left",
                lineHeight: 56,
                letterSpacing: 1,
              },
            },
            {
              kind: "text",
              name: "kosong",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              text: {
                characters: "",
                fontSize: 12,
                fontFamily: "Inter",
                fontWeight: 400,
                italic: true,
                color: hitam,
                align: "center",
              },
            },
          ],
        },
      },
      {
        name: "Kontak",
        width: 390,
        height: 800,
        root: { kind: "box", name: "body", x: 0, y: 0, width: 390, height: 800 },
      },
    ],
  };
}

interface Baca {
  type: string;
  name: string;
  guid: { sessionID: number; localID: number };
  parentIndex?: { guid: { sessionID: number; localID: number } };
  size?: { x: number; y: number };
  transform: { m02: number; m12: number };
  textData?: { characters: string };
}

async function baca(data: Uint8Array): Promise<Baca[]> {
  const salinan = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hasil = await parseFigBuffer(salinan);
  return hasil.nodeChanges as unknown as Baca[];
}

describe("buildFig", () => {
  test("menulis dokumen, dua halaman, frame, dan teks yang terbaca balik", async () => {
    const out = await buildFig(contoh());
    expect(out.filename).toBe("design.fig");
    const nodes = await baca(out.data);
    expect(nodes.length).toBe(out.nodes);
    expect(nodes.filter((n) => n.type === "DOCUMENT").length).toBe(1);
    expect(nodes.filter((n) => n.type === "CANVAS").map((n) => n.name)).toEqual([
      "Beranda",
      "Kontak",
    ]);
    expect(nodes.filter((n) => n.type === "FRAME").map((n) => n.name)).toEqual([
      "Beranda",
      "tombol",
      "Kontak",
    ]);
    const tombol = nodes.find((n) => n.name === "tombol");
    expect(tombol?.size).toEqual({ x: 240, y: 56 });
    expect(tombol?.transform.m02).toBe(80);
    expect(tombol?.transform.m12).toBe(200);
    const judul = nodes.find((n) => n.name === "judul");
    expect(judul?.type).toBe("TEXT");
    expect(judul?.textData?.characters).toBe("Rumah Tepi Danau");
    const kosong = nodes.find((n) => n.name === "kosong");
    expect(kosong?.textData?.characters).toBe(" ");
  });

  test("ID unik dan setiap induk ada tanpa siklus", async () => {
    const out = await buildFig(contoh());
    const nodes = await baca(out.data);
    const key = (g: { sessionID: number; localID: number }): string =>
      `${g.sessionID}:${g.localID}`;
    const ids = new Set(nodes.map((n) => key(n.guid)));
    expect(ids.size).toBe(nodes.length);
    for (const n of nodes) {
      if (n.type === "DOCUMENT") continue;
      const parent = n.parentIndex?.guid;
      expect(parent).toBeDefined();
      expect(ids.has(key(parent!))).toBe(true);
      // Naik ke akar tidak boleh berputar.
      let langkah = 0;
      let kini: Baca | undefined = n;
      while (kini !== undefined && kini.type !== "DOCUMENT") {
        const p: string = key(kini.parentIndex!.guid);
        kini = nodes.find((m) => key(m.guid) === p);
        langkah += 1;
        expect(langkah).toBeLessThan(100);
      }
    }
  });

  test("dua kali build menghasilkan byte identik", async () => {
    const a = await buildFig(contoh());
    const b = await buildFig(contoh());
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("bayangan dan gambar", () => {
  function sceneGambar(): SceneDoc {
    const dasar = contoh();
    const root = dasar.pages[0]!.root;
    root.children = [
      {
        kind: "box",
        name: "foto",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        image: { data: PNG_1X1, fit: "fill" },
        shadows: [
          { x: 0, y: 2, blur: 8, spread: 1, color: { r: 0, g: 0, b: 0, a: 0.2 }, inset: false },
        ],
      },
      {
        kind: "box",
        name: "foto-sama",
        x: 0,
        y: 100,
        width: 50,
        height: 50,
        image: { data: PNG_1X1, fit: "fit" },
      },
    ];
    return dasar;
  }

  test("gambar masuk arsip sekali (dedup) dan dirujuk lewat paint IMAGE", async () => {
    const out = await buildFig(sceneGambar());
    const salinan = out.data.buffer.slice(
      out.data.byteOffset,
      out.data.byteOffset + out.data.byteLength,
    ) as ArrayBuffer;
    const hasil = await parseFigBuffer(salinan);
    expect(hasil.images.length).toBe(1);
    const [nama, bytes] = hasil.images[0]!;
    expect(nama).toMatch(/^[0-9a-f]{40}$/);
    expect(bytes.length).toBeGreaterThan(10);
    const foto = (hasil.nodeChanges as unknown as Array<Record<string, unknown>>).find(
      (n) => n.name === "foto",
    ) as { fillPaints: Array<{ type: string; imageScaleMode?: string }>; effects: unknown[] };
    expect(foto.fillPaints.some((p) => p.type === "IMAGE" && p.imageScaleMode === "FILL")).toBe(true);
    expect(foto.effects.length).toBe(1);
  });

  test("build dengan gambar tetap deterministik", async () => {
    const a = await buildFig(sceneGambar());
    const b = await buildFig(sceneGambar());
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

describe("fontStyle", () => {
  test("memetakan bobot dan miring", () => {
    expect(fontStyle(400, false)).toBe("Regular");
    expect(fontStyle(400, true)).toBe("Italic");
    expect(fontStyle(700, true)).toBe("Bold Italic");
    expect(fontStyle(650, false)).toBe("Bold");
    expect(fontStyle(50, false)).toBe("Thin");
  });
});

describe("resolveFont", () => {
  test("memetakan font sistem ke font yang ada di Figma", () => {
    expect(resolveFont("Arial", 400)).toEqual({ family: "Inter", weight: 400 });
    expect(resolveFont("Georgia", 800)).toEqual({ family: "Lora", weight: 700 });
    expect(resolveFont("monospace", 400).family).toBe("Roboto Mono");
    expect(resolveFont("Poppins", 600)).toEqual({ family: "Poppins", weight: 600 });
    expect(resolveFont("FontAneh", 500).family).toBe("Inter");
    expect(resolveFont("", 400).family).toBe("Inter");
  });
});
