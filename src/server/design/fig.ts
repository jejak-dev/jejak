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
import { createHash } from "node:crypto";
import { deflateSync } from "fflate";
import type { SceneDoc, SceneGradient, SceneLayout, SceneNode } from "./scene";

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

/** Font Google yang pasti ada di Figma; nama lain dipetakan atau jatuh ke Inter. */
const FIGMA_FONTS = new Set([
  "inter",
  "roboto",
  "open sans",
  "lato",
  "montserrat",
  "poppins",
  "lora",
  "playfair display",
  "merriweather",
  "source sans 3",
  "nunito",
  "dm sans",
  "work sans",
  "roboto mono",
  "fira code",
  "jetbrains mono",
]);

const FONT_ALIAS: Record<string, string> = {
  arial: "Inter",
  helvetica: "Inter",
  "helvetica neue": "Inter",
  "system-ui": "Inter",
  "-apple-system": "Inter",
  "segoe ui": "Inter",
  "sans-serif": "Inter",
  georgia: "Lora",
  "times new roman": "Lora",
  times: "Lora",
  serif: "Lora",
  courier: "Roboto Mono",
  "courier new": "Roboto Mono",
  menlo: "Roboto Mono",
  monaco: "Roboto Mono",
  monospace: "Roboto Mono",
};

/**
 * Pilih font Figma: Figma web tidak punya font sistem (Arial, Georgia),
 * dan teks dengan font hilang tidak tampil. Nama dikenal dipakai apa adanya,
 * alias dipetakan, sisanya Inter. Lora hanya punya bobot 400..700.
 */
export function resolveFont(family: string, weight: number): { family: string; weight: number } {
  const kunci = family.trim().toLowerCase();
  let nama = "Inter";
  if (FIGMA_FONTS.has(kunci)) nama = family.trim();
  else nama = FONT_ALIAS[kunci] ?? "Inter";
  const bobot = nama === "Lora" ? Math.min(700, Math.max(400, weight)) : weight;
  return { family: nama, weight: bobot };
}

const ALIGN: Record<string, string> = {
  left: "LEFT",
  center: "CENTER",
  right: "RIGHT",
  justify: "JUSTIFIED",
};

type Transform = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };

function inversi(t: Transform): Transform {
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (Math.abs(det) < 1e-12) return { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const m00 = t.m11 / det;
  const m01 = -t.m01 / det;
  const m10 = -t.m10 / det;
  const m11 = t.m00 / det;
  return {
    m00,
    m01,
    m02: -(m00 * t.m02 + m01 * t.m12),
    m10,
    m11,
    m12: -(m10 * t.m02 + m11 * t.m12),
  };
}

/**
 * Transform paint gradien linear Figma (kotak satuan layer ke ruang gradien,
 * tempat garis berjalan dari (0, 0.5) ke (1, 0.5)) dari sudut CSS dan ukuran px.
 */
export function gradientTransform(angle: number, width: number, height: number): Transform {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  // Panjang garis gradien CSS menyentuh sudut kotak.
  const panjang = Math.abs(w * dx) + Math.abs(h * dy);
  const awal = { x: 0.5 - (dx * panjang) / 2 / w, y: 0.5 - (dy * panjang) / 2 / h };
  const akhir = { x: 0.5 + (dx * panjang) / 2 / w, y: 0.5 + (dy * panjang) / 2 / h };
  const sumbu = { x: akhir.x - awal.x, y: akhir.y - awal.y };
  // Sumbu kedua tegak lurus di layar dan sepanjang sumbu utama.
  const lintang = { x: (-sumbu.y * h) / w, y: (sumbu.x * w) / h };
  return inversi({
    m00: sumbu.x,
    m01: lintang.x,
    m02: awal.x - lintang.x / 2,
    m10: sumbu.y,
    m11: lintang.y,
    m12: awal.y - lintang.y / 2,
  });
}

function paintGradien(g: SceneGradient, width: number, height: number) {
  return {
    type: "GRADIENT_LINEAR" as const,
    stops: g.stops.map((st) => ({ color: st.color, position: st.position })),
    transform: gradientTransform(g.angle, width, height),
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  };
}

/**
 * Auto layout hanya dipakai bila perhitungan tata letak Figma menaruh semua
 * anak dalam 1.5 px dari posisi DOM asli; selain itu posisi mutlak dipertahankan.
 */
export function layoutCocok(node: SceneNode, layout: SceneLayout): boolean {
  const anak = node.children ?? [];
  if (anak.length === 0) return false;
  const [atas, kanan, bawah, kiri] = layout.padding;
  const baris = layout.direction === "row";
  const dalamUtama = (baris ? node.width - kiri - kanan : node.height - atas - bawah);
  const dalamSilang = (baris ? node.height - atas - bawah : node.width - kiri - kanan);
  const ukuranUtama = anak.map((c) => (baris ? c.width : c.height));
  const total = ukuranUtama.reduce((a, b) => a + b, 0);
  const bebas = dalamUtama - total - layout.gap * (anak.length - 1);
  let kursor = layout.main === "center" ? bebas / 2 : layout.main === "end" ? bebas : 0;
  const celah = layout.main === "between" && anak.length > 1
    ? (dalamUtama - total) / (anak.length - 1)
    : layout.gap;
  if (layout.main === "between" && anak.length === 1) kursor = 0;
  for (let i = 0; i < anak.length; i += 1) {
    const c = anak[i];
    if (c === undefined) return false;
    const silang = baris ? c.height : c.width;
    const geser = layout.cross === "center" ? (dalamSilang - silang) / 2
      : layout.cross === "end" ? dalamSilang - silang : 0;
    const x = baris ? kiri + kursor : kiri + geser;
    const y = baris ? atas + geser : atas + kursor;
    if (Math.abs(x - c.x) > 1.5 || Math.abs(y - c.y) > 1.5) return false;
    kursor += (baris ? c.width : c.height) + celah;
  }
  return true;
}

const JUSTIFY: Record<string, string> = {
  start: "MIN",
  center: "CENTER",
  end: "MAX",
  between: "SPACE_BETWEEN",
};
const ALIGN_ITEMS: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX" };

interface Counter {
  next: number;
}

/** Gambar unik (dedup lewat SHA-1 isi) yang ikut masuk arsip. */
interface ImagePool {
  entries: Map<string, Uint8Array>;
}

const IMAGE_SCALE: Record<string, string> = { fill: "FILL", fit: "FIT", stretch: "STRETCH" };

function emit(
  node: SceneNode,
  parentLocalID: number,
  parentSession: number,
  index: number,
  counter: Counter,
  out: NodeChange[],
  pool: ImagePool,
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
  // Garis tepi CSS berada di dalam kotak.
  if (node.stroke !== undefined) change.strokeAlign = "INSIDE";
  if (!isText) {
    change.clipsContent = node.clip === true;
    // FRAME tanpa isi tetap tampil; tanpa fill dibiarkan transparan.
    if (node.fill === undefined) change.fillPaints = [];
  }
  if (node.shadows !== undefined && node.shadows.length > 0 && !isText) {
    change.effects = node.shadows.map((sh) => ({
      type: sh.inset ? ("INNER_SHADOW" as const) : ("DROP_SHADOW" as const),
      color: sh.color,
      offset: { x: sh.x, y: sh.y },
      radius: sh.blur,
      spread: sh.spread,
      visible: true,
      blendMode: "NORMAL",
      showShadowBehindNode: false,
    }));
  }
  if (node.gradient !== undefined && !isText) {
    change.fillPaints = [
      ...(change.fillPaints ?? []),
      paintGradien(node.gradient, node.width, node.height),
    ];
  }
  const layout = node.layout;
  const autoLayout = !isText && layout !== undefined && layoutCocok(node, layout);
  if (autoLayout && layout !== undefined) {
    const [atas, kanan, bawah, kiri] = layout.padding;
    change.stackMode = layout.direction === "row" ? "HORIZONTAL" : "VERTICAL";
    change.stackSpacing = layout.gap;
    change.stackHorizontalPadding = kiri;
    change.stackPaddingRight = kanan;
    change.stackVerticalPadding = atas;
    change.stackPaddingBottom = bawah;
    change.stackPrimaryAlignItems = JUSTIFY[layout.main] ?? "MIN";
    change.stackCounterAlignItems = ALIGN_ITEMS[layout.cross] ?? "MIN";
    change.stackPrimarySizing = "FIXED";
    change.stackCounterSizing = "FIXED";
  }
  if (node.image !== undefined && !isText) {
    const bytes = new Uint8Array(Buffer.from(node.image.data, "base64"));
    const hash = createHash("sha1").update(bytes).digest();
    pool.entries.set(`images/${hash.toString("hex")}`, bytes);
    const paints = change.fillPaints ?? [];
    change.fillPaints = [
      ...paints,
      {
        type: "IMAGE",
        image: { hash: new Uint8Array(hash) },
        imageScaleMode: IMAGE_SCALE[node.image.fit] ?? "FILL",
        opacity: 1,
        visible: true,
        blendMode: "NORMAL",
      },
    ];
  }
  const teks = node.text;
  if (isText && teks !== undefined) {
    const font = resolveFont(teks.fontFamily, teks.fontWeight);
    const family = font.family;
    const style = fontStyle(font.weight, teks.italic);
    change.fontSize = teks.fontSize;
    change.fontName = {
      family,
      style,
      postscript: `${family.replace(/\s+/g, "")}-${style.replace(/\s+/g, "")}`,
    };
    // Teks kosong ditolak Figma; ganti dengan satu spasi.
    change.textData = { characters: teks.characters.length > 0 ? teks.characters : " " };
    change.textAlignHorizontal = ALIGN[teks.align] ?? "LEFT";
    change.textAutoResize = teks.singleLine === true ? "WIDTH_AND_HEIGHT" : "NONE";
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
    anak.forEach((child, i) => emit(child, localID, SESSION, i, counter, out, pool));
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
  const pool: ImagePool = { entries: new Map() };
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
      pool,
    );
  });
  const message = createNodeChangesMessage(0, 0, changes);
  const kiwiData = compress(encodeMessage(message));
  const data = writeFigArchive({
    schemaDeflated: deflateSync(getSchemaBytes()),
    kiwiData,
    thumbnailPNG: THUMBNAIL,
    metaJSON: JSON.stringify({ version: 1, file_name: scene.name }),
    images: [...pool.entries].map(([name, data]) => ({ name, data })),
  });
  return { filename: "design.fig", data, nodes: changes.length };
}
