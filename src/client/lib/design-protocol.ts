/**
 * Protokol pesan antara frame desain dan klien. Murni: tanpa DOM, tanpa
 * jaringan. Semua pesan dari frame dianggap tidak tepercaya, jadi setiap
 * bidang divalidasi dan dipotong sebelum dipakai.
 */

export const DESIGN_CHANNEL = "jejak-design-v1";
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MIN_FRAME_HEIGHT = 200;
export const MAX_FRAME_HEIGHT = 6000;
export const MAX_HTML_CHARS = 2048;

/** Batas id pesan `capture`/`shot`: 1..64 karakter `[A-Za-z0-9_-]`. */
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Batas perkiraan panjang data URL PNG; lebih besar dari batas pesan biasa. */
export const MAX_SHOT_CHARS = 6_000_000;
/** Batas sisi lebar/tinggi gambar tangkapan yang dilaporkan frame. */
export const MAX_SHOT_DIMENSION = 8192;
/** Batas panjang JSON scene yang dilaporkan frame (ekspor Figma). */
export const MAX_SCENE_CHARS = 6_000_000;
export const SHOT_DATA_URL_PREFIX = "data:image/png;base64,";

const MAX_TEXT_CHARS = 200;
const MAX_SELECTOR_CHARS = 500;
const MAX_HASH_CHARS = 200;
const MAX_LABEL_CHARS = 64;
const MAX_STYLE_VALUE_CHARS = 200;
const MAX_COORD = 1e6;

/** Kotak elemen dalam koordinat viewport frame. */
export interface FrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Satu pin komentar yang digambar di dalam frame. */
export interface PinSpec {
  id: string;
  selector: string;
  /** Nomor pin 1..999; stabil walau status berubah. */
  n: number;
  done: boolean;
}

/** Batas jumlah pin yang dikirim ke satu frame. */
export const MAX_PINS = 50;

/** Subset gaya terhitung yang dikirim bersama pilihan. */
export interface FrameStyle {
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  padding?: string;
  margin?: string;
  borderRadius?: string;
  display?: string;
}

export type FrameMessage =
  | { channel: typeof DESIGN_CHANNEL; type: "ready"; slug: string }
  | { channel: typeof DESIGN_CHANNEL; type: "size"; height: number }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "hover";
      bounds: FrameBounds;
      tag: string;
      label: string;
    }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "select";
      selector: string;
      tag: string;
      text: string;
      html: string;
      bounds: FrameBounds;
      style: FrameStyle;
    }
  | { channel: typeof DESIGN_CHANNEL; type: "route"; hash: string }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "wheel";
      deltaX: number;
      deltaY: number;
      ctrlKey: boolean;
      clientX: number;
      clientY: number;
    }
  | { channel: typeof DESIGN_CHANNEL; type: "pan"; dx: number; dy: number }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "shot";
      id: string;
      width: number;
      height: number;
      dataUrl: string;
    }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "scene";
      id: string;
      width: number;
      height: number;
      /** Pohon scene mentah dari frame; divalidasi ketat oleh server. */
      root: Record<string, unknown>;
    }
  | {
      channel: typeof DESIGN_CHANNEL;
      type: "shot-error";
      id: string;
      reason: ShotErrorReason;
    }
  | { channel: typeof DESIGN_CHANNEL; type: "pin"; id: string };

/** Alasan tangkapan layar gagal di dalam frame. */
export type ShotErrorReason = "tainted" | "too-large" | "failed";

const SHOT_ERROR_REASONS: readonly ShotErrorReason[] = ["tainted", "too-large", "failed"];

export type HostMessage =
  | { channel: typeof DESIGN_CHANNEL; type: "mode"; tool: "preview" | "select" }
  | { channel: typeof DESIGN_CHANNEL; type: "clear-selection" }
  | { channel: typeof DESIGN_CHANNEL; type: "highlight"; selector: string }
  | { channel: typeof DESIGN_CHANNEL; type: "capture"; id: string; scale: 1 | 2 }
  | { channel: typeof DESIGN_CHANNEL; type: "scene"; id: string }
  | { channel: typeof DESIGN_CHANNEL; type: "pins"; pins: PinSpec[] };

const STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "padding",
  "margin",
  "borderRadius",
  "display",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function angka(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < -MAX_COORD || value > MAX_COORD) return undefined;
  return value;
}

function teks(value: unknown, maks: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, maks);
}

/** Bilangan bulat 1..MAX_SHOT_DIMENSION untuk dimensi tangkapan. */
function dimensi(value: unknown): number | undefined {
  const n = angka(value);
  if (n === undefined || !Number.isInteger(n)) return undefined;
  if (n < 1 || n > MAX_SHOT_DIMENSION) return undefined;
  return n;
}

function bounds(value: unknown): FrameBounds | undefined {
  if (!isRecord(value)) return undefined;
  const x = angka(value.x);
  const y = angka(value.y);
  const width = angka(value.width);
  const height = angka(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function style(value: unknown): FrameStyle {
  const hasil: FrameStyle = {};
  if (!isRecord(value)) return hasil;
  for (const kunci of STYLE_KEYS) {
    const nilai = value[kunci];
    if (typeof nilai === "string") hasil[kunci] = nilai.slice(0, MAX_STYLE_VALUE_CHARS);
  }
  return hasil;
}

/**
 * Sisa `dataUrl` setelah awalan PNG harus base64 murni. Regex lengket dipakai
 * supaya pemeriksaan dimulai di offset awalan tanpa memotong (menyalin)
 * string data URL yang bisa berukuran megabita.
 */
const SHOT_BASE64_RE = /[A-Za-z0-9+/]+={0,2}$/y;

/** Memvalidasi pesan `shot` tanpa men-stringify data URL besar. */
function parseShot(data: Record<string, unknown>): FrameMessage | undefined {
  const id = data.id;
  if (typeof id !== "string" || !MESSAGE_ID_RE.test(id)) return undefined;
  const width = dimensi(data.width);
  const height = dimensi(data.height);
  if (width === undefined || height === undefined) return undefined;
  const dataUrl = data.dataUrl;
  if (typeof dataUrl !== "string") return undefined;
  if (dataUrl.length > MAX_SHOT_CHARS) return undefined;
  if (!dataUrl.startsWith(SHOT_DATA_URL_PREFIX)) return undefined;
  SHOT_BASE64_RE.lastIndex = SHOT_DATA_URL_PREFIX.length;
  if (!SHOT_BASE64_RE.test(dataUrl)) return undefined;
  return { channel: DESIGN_CHANNEL, type: "shot", id, width, height, dataUrl };
}

/** Memvalidasi pesan `scene`: hanya bentuk luar; isi diperiksa server. */
function parseScene(data: Record<string, unknown>): FrameMessage | undefined {
  const id = data.id;
  if (typeof id !== "string" || !MESSAGE_ID_RE.test(id)) return undefined;
  const width = dimensi(data.width);
  const height = dimensi(data.height);
  if (width === undefined || height === undefined) return undefined;
  if (!isRecord(data.root)) return undefined;
  return { channel: DESIGN_CHANNEL, type: "scene", id, width, height, root: data.root };
}

/**
 * Memvalidasi satu pesan dari frame. Mengembalikan `undefined` untuk apa pun
 * yang tidak dikenal, terlalu besar, atau berbentuk salah; tidak pernah
 * melempar.
 */
export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  if (!isRecord(data)) return undefined;
  if (data.channel !== DESIGN_CHANNEL) return undefined;
  if (typeof data.type !== "string") return undefined;
  // `shot` membawa data URL besar dengan batasnya sendiri; jangan di-stringify.
  if (data.type === "shot") return parseShot(data);
  if (data.type === "scene") return parseScene(data);
  let ukuran: number;
  try {
    ukuran = JSON.stringify(data).length;
  } catch {
    return undefined;
  }
  if (ukuran > MAX_MESSAGE_BYTES) return undefined;

  switch (data.type) {
    case "ready": {
      const slug = teks(data.slug, MAX_LABEL_CHARS);
      if (slug === undefined) return undefined;
      return { channel: DESIGN_CHANNEL, type: "ready", slug };
    }
    case "size": {
      const tinggi = angka(data.height);
      if (tinggi === undefined) return undefined;
      const height = Math.min(
        MAX_FRAME_HEIGHT,
        Math.max(MIN_FRAME_HEIGHT, Math.round(tinggi)),
      );
      return { channel: DESIGN_CHANNEL, type: "size", height };
    }
    case "hover": {
      const kotak = bounds(data.bounds);
      const tag = teks(data.tag, MAX_LABEL_CHARS);
      const label = teks(data.label, MAX_LABEL_CHARS);
      if (kotak === undefined || tag === undefined || label === undefined) return undefined;
      return { channel: DESIGN_CHANNEL, type: "hover", bounds: kotak, tag, label };
    }
    case "select": {
      const kotak = bounds(data.bounds);
      const selector = teks(data.selector, MAX_SELECTOR_CHARS);
      const tag = teks(data.tag, MAX_LABEL_CHARS);
      const text = teks(data.text, MAX_TEXT_CHARS);
      const html = teks(data.html, MAX_HTML_CHARS);
      if (
        kotak === undefined ||
        selector === undefined ||
        tag === undefined ||
        text === undefined ||
        html === undefined
      ) {
        return undefined;
      }
      return {
        channel: DESIGN_CHANNEL,
        type: "select",
        selector,
        tag,
        text,
        html,
        bounds: kotak,
        style: style(data.style),
      };
    }
    case "route": {
      const hash = teks(data.hash, MAX_HASH_CHARS);
      if (hash === undefined) return undefined;
      return { channel: DESIGN_CHANNEL, type: "route", hash };
    }
    case "wheel": {
      const deltaX = angka(data.deltaX);
      const deltaY = angka(data.deltaY);
      const clientX = angka(data.clientX);
      const clientY = angka(data.clientY);
      if (
        deltaX === undefined ||
        deltaY === undefined ||
        clientX === undefined ||
        clientY === undefined ||
        typeof data.ctrlKey !== "boolean"
      ) {
        return undefined;
      }
      return {
        channel: DESIGN_CHANNEL,
        type: "wheel",
        deltaX,
        deltaY,
        ctrlKey: data.ctrlKey,
        clientX,
        clientY,
      };
    }
    case "pan": {
      const dx = angka(data.dx);
      const dy = angka(data.dy);
      if (dx === undefined || dy === undefined) return undefined;
      return { channel: DESIGN_CHANNEL, type: "pan", dx, dy };
    }
    case "shot-error": {
      const id = data.id;
      if (typeof id !== "string" || !MESSAGE_ID_RE.test(id)) return undefined;
      const reason = SHOT_ERROR_REASONS.find((nilai) => nilai === data.reason);
      if (reason === undefined) return undefined;
      return { channel: DESIGN_CHANNEL, type: "shot-error", id, reason };
    }
    case "pin": {
      const id = data.id;
      if (typeof id !== "string" || !MESSAGE_ID_RE.test(id)) return undefined;
      return { channel: DESIGN_CHANNEL, type: "pin", id };
    }
    default:
      return undefined;
  }
}

/** Benar bila peristiwa `message` berasal dari jendela frame yang dikenal. */
export function isFromFrame(event: { source: unknown }, frameWindow: unknown): boolean {
  return frameWindow != null && event.source === frameWindow;
}

/** Pesan untuk mengganti alat di frame. */
export function modeMessage(tool: "preview" | "select"): HostMessage {
  return { channel: DESIGN_CHANNEL, type: "mode", tool };
}

/** Pesan untuk menghapus sorotan pilihan. */
export function clearSelectionMessage(): HostMessage {
  return { channel: DESIGN_CHANNEL, type: "clear-selection" };
}

/** Pesan untuk menyorot elemen lewat selector (dipakai D2). */
export function highlightMessage(selector: string): HostMessage {
  return { channel: DESIGN_CHANNEL, type: "highlight", selector: selector.slice(0, MAX_SELECTOR_CHARS) };
}

/**
 * Pesan untuk meminta tangkapan layar dari frame (dipakai D2). `undefined`
 * bila `id` tidak lolos batas, karena frame akan mengabaikannya.
 */
export function captureMessage(id: string, scale: 1 | 2 = 1): HostMessage | undefined {
  if (!MESSAGE_ID_RE.test(id)) return undefined;
  return { channel: DESIGN_CHANNEL, type: "capture", id, scale };
}

/** Pesan untuk meminta scene (kotak, warna, teks) dari frame; `undefined` bila id tak sah. */
export function sceneMessage(id: string): HostMessage | undefined {
  if (!MESSAGE_ID_RE.test(id)) return undefined;
  return { channel: DESIGN_CHANNEL, type: "scene", id };
}

/** Nomor pin tertinggi yang diterima frame. */
const MAX_PIN_NUMBER = 999;

/**
 * Pesan untuk menggambar pin komentar di frame. Pin tak sah dibuang; maksimal
 * `MAX_PINS`. Daftar kosong sah dan menghapus semua pin.
 */
export function pinsMessage(pins: PinSpec[]): HostMessage {
  const hasil: PinSpec[] = [];
  for (const pin of pins) {
    if (hasil.length >= MAX_PINS) break;
    if (!isRecord(pin)) continue;
    if (typeof pin.id !== "string" || !MESSAGE_ID_RE.test(pin.id)) continue;
    if (typeof pin.selector !== "string") continue;
    if (pin.selector.length < 1 || pin.selector.length > MAX_SELECTOR_CHARS) continue;
    if (typeof pin.n !== "number" || !Number.isInteger(pin.n)) continue;
    if (pin.n < 1 || pin.n > MAX_PIN_NUMBER) continue;
    if (typeof pin.done !== "boolean") continue;
    hasil.push({ id: pin.id, selector: pin.selector, n: pin.n, done: pin.done });
  }
  return { channel: DESIGN_CHANNEL, type: "pins", pins: hasil };
}
