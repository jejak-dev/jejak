import { writeFigArchive } from "@open-pencil/fig";
import { makeCanvasNodeChange, makeDocumentNodeChange } from "@open-pencil/fig/node-change";
import {
  compress,
  createNodeChange,
  createNodeChangesMessage,
  encodeMessage,
  getSchemaBytes,
  initCodec,
  type NodeChange,
} from "@open-pencil/kiwi/fig/codec";
import { deflateSync } from "fflate";
import type { SceneDoc, SceneNode } from "./scene";

/**
 * Penulis berkas Figma (.fig) dari scene graph. Format ini tidak punya
 * spesifikasi resmi; resepnya mengikuti hasil rekayasa balik pustaka
 * open-pencil dan sudah diuji dibuka di Figma. Semua `box` ditulis sebagai
 * FRAME (ROUNDED_RECTANGLE tampil dengan ukuran berbeda di Figma).
 */

/** Sesi tunggal untuk semua node yang kita buat; DOCUMENT dan CANVAS memakai sesi 0. */
const SESSION = 1;

/** PNG 1x1 transparan sebagai thumbnail wajib arsip. */
const THUMBNAIL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const STYLE_BY_WEIGHT: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** Nama gaya font Figma dari bobot dan miring. */
export function fontStyle(weight: number, italic: boolean): string {
  const bulat = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const dasar = STYLE_BY_WEIGHT[bulat] ?? "Regular";
  if (!italic) return dasar;
  return dasar === "Regular" ? "Italic" : `${dasar} Italic`;
}

/** Kunci posisi anak yang naik secara leksikografis (dua karakter, '!'..'~'). */
function positionKey(index: number): string {
  const dasar = 90;
  return String.fromCharCode(33 + Math.floor(index / dasar), 33 + (index % dasar));
}

const ALIGN: Record<string, string> = {
  left: "LEFT",
  center: "CENTER",
  right: "RIGHT",
  justify: "JUSTIFIED",
};

interface Counter {
  next: number;
}

function emit(
  node: SceneNode,
  parentLocalID: number,
  parentSession: number,
  index: number,
  counter: Counter,
  out: NodeChange[],
): void {
  const localID = counter.next;
  counter.next += 1;
  const isText = node.kind === "text" && node.text !== undefined;
  const radius = node.radius;
  const uniform = typeof radius === "number" ? radius : undefined;
  const change: NodeChange = createNodeChange({
    sessionID: SESSION,
    localID,
    parentSessionID: parentSession,
    parentLocalID,
    position: positionKey(index),
    type: isText ? "TEXT" : "FRAME",
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    fill: isText ? node.text?.color : node.fill,
    stroke: node.stroke?.color,
    strokeWeight: node.stroke?.weight,
    cornerRadius: uniform,
    opacity: node.opacity,
  });
  if (Array.isArray(radius)) {
    change.rectangleCornerRadiiIndependent = true;
    change.rectangleTopLeftCornerRadius = radius[0];
    change.rectangleTopRightCornerRadius = radius[1];
    change.rectangleBottomRightCornerRadius = radius[2];
    change.rectangleBottomLeftCornerRadius = radius[3];
  }
  if (!isText) {
    change.clipsContent = node.clip === true;
    // FRAME tanpa isi tetap tampil; tanpa fill dibiarkan transparan.
    if (node.fill === undefined) change.fillPaints = [];
  }
  const teks = node.text;
  if (isText && teks !== undefined) {
    const family = teks.fontFamily.length > 0 ? teks.fontFamily : "Inter";
    const style = fontStyle(teks.fontWeight, teks.italic);
    change.fontSize = teks.fontSize;
    change.fontName = {
      family,
      style,
      postscript: `${family.replace(/\s+/g, "")}-${style.replace(/\s+/g, "")}`,
    };
    // Teks kosong ditolak Figma; ganti dengan satu spasi.
    change.textData = { characters: teks.characters.length > 0 ? teks.characters : " " };
    change.textAlignHorizontal = ALIGN[teks.align] ?? "LEFT";
    change.textAutoResize = "NONE";
    if (teks.lineHeight !== undefined) {
      change.lineHeight = { value: teks.lineHeight, units: "PIXELS" };
    }
    if (teks.letterSpacing !== undefined) {
      change.letterSpacing = { value: teks.letterSpacing, units: "PIXELS" };
    }
  }
  out.push(change);
  const anak = isText ? undefined : node.children;
  if (anak !== undefined) {
    anak.forEach((child, i) => emit(child, localID, SESSION, i, counter, out));
  }
}

/** Bangun berkas .fig dari scene; satu CANVAS (halaman Figma) per halaman scene. */
export async function buildFig(
  scene: SceneDoc,
): Promise<{ filename: string; data: Uint8Array; nodes: number }> {
  await initCodec();
  const changes: NodeChange[] = [];
  changes.push(makeDocumentNodeChange({ sessionID: 0, localID: 0 }, "srgb"));
  const counter: Counter = { next: 1 };
  scene.pages.forEach((page, index) => {
    // CANVAS memakai sesi 0 dan localID 1.. agar terpisah dari node biasa.
    const canvasID = index + 1;
    changes.push(
      makeCanvasNodeChange(
        { sessionID: 0, localID: canvasID },
        { sessionID: 0, localID: 0 },
        positionKey(index),
        page.name,
      ),
    );
    emit(
      { ...page.root, x: 0, y: 0, width: page.width, height: page.height, name: page.name },
      canvasID,
      0,
      0,
      counter,
      changes,
    );
  });
  const message = createNodeChangesMessage(0, 0, changes);
  const kiwiData = compress(encodeMessage(message));
  const data = writeFigArchive({
    schemaDeflated: deflateSync(getSchemaBytes()),
    kiwiData,
    thumbnailPNG: THUMBNAIL,
    metaJSON: JSON.stringify({ version: 1, file_name: scene.name }),
  });
  return { filename: "design.fig", data, nodes: changes.length };
}
