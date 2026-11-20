import { DesignError } from "./assemble";

/**
 * Scene graph desain yang dikirim klien untuk ekspor Figma. Semua nilai
 * dianggap tidak tepercaya: `validateScene` memeriksa tipe, membatasi
 * ukuran, menjepit warna, dan menolak sisanya dengan pesan Indonesia.
 */

export interface SceneColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SceneText {
  characters: string;
  fontSize: number;
  fontFamily: string;
  /** 100..900. */
  fontWeight: number;
  italic: boolean;
  color: SceneColor;
  align: "left" | "center" | "right" | "justify";
  /** Tinggi baris dalam px. */
  lineHeight?: number;
  /** Jarak antarhuruf dalam px. */
  letterSpacing?: number;
}

export interface SceneShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: SceneColor;
  inset: boolean;
}

/** Gambar raster (PNG atau JPEG, base64 tanpa awalan) yang mengisi sebuah box. */
export interface SceneImage {
  data: string;
  fit: "fill" | "fit" | "stretch";
}

export interface SceneNode {
  /** `box` menjadi FRAME Figma; gambar dan svg dikirim klien sebagai box abu-abu. */
  kind: "box" | "text";
  name: string;
  /** Posisi dan ukuran relatif ke induk, dalam px. */
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: SceneColor;
  stroke?: { color: SceneColor; weight: number };
  radius?: number | [number, number, number, number];
  opacity?: number;
  clip?: boolean;
  text?: SceneText;
  shadows?: SceneShadow[];
  image?: SceneImage;
  children?: SceneNode[];
}

export interface ScenePage {
  name: string;
  width: number;
  height: number;
  root: SceneNode;
}

export interface SceneDoc {
  name: string;
  pages: ScenePage[];
}

export const MAX_SCENE_PAGES = 100;
export const MAX_SCENE_NODES = 20000;
export const MAX_SCENE_DEPTH = 60;
const MAX_NAME = 120;
const MAX_CHARACTERS = 20000;
const MAX_FONT_FAMILY = 100;
const MAX_ABS = 1e6;
const MAX_SHADOWS = 8;
const MAX_IMAGE_CHARS = 1_200_000;
export const MAX_SCENE_IMAGES = 60;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(message: string): never {
  throw new DesignError(message, 400);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} harus berupa objek.`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") fail(`${where} harus berupa teks.`);
  return value.length > max ? value.slice(0, max) : value;
}

function num(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_ABS) {
    fail(`${where} harus berupa bilangan terbatas.`);
  }
  return value;
}

function unit(value: unknown, where: string): number {
  return Math.min(1, Math.max(0, num(value, where)));
}

function color(value: unknown, where: string): SceneColor {
  const obj = record(value, where);
  return {
    r: unit(obj.r, `${where}.r`),
    g: unit(obj.g, `${where}.g`),
    b: unit(obj.b, `${where}.b`),
    a: unit(obj.a, `${where}.a`),
  };
}

function text(value: unknown, where: string): SceneText {
  const obj = record(value, where);
  const align = obj.align;
  if (align !== "left" && align !== "center" && align !== "right" && align !== "justify") {
    fail(`${where}.align tidak dikenal.`);
  }
  if (typeof obj.italic !== "boolean") fail(`${where}.italic harus boolean.`);
  const hasil: SceneText = {
    characters: str(obj.characters, `${where}.characters`, MAX_CHARACTERS),
    fontSize: Math.min(1000, Math.max(1, num(obj.fontSize, `${where}.fontSize`))),
    fontFamily: str(obj.fontFamily, `${where}.fontFamily`, MAX_FONT_FAMILY),
    fontWeight: Math.min(900, Math.max(100, num(obj.fontWeight, `${where}.fontWeight`))),
    italic: obj.italic,
    color: color(obj.color, `${where}.color`),
    align,
  };
  if (obj.lineHeight !== undefined) hasil.lineHeight = num(obj.lineHeight, `${where}.lineHeight`);
  if (obj.letterSpacing !== undefined) {
    hasil.letterSpacing = num(obj.letterSpacing, `${where}.letterSpacing`);
  }
  return hasil;
}

interface Budget {
  nodes: number;
  images: number;
}

function node(value: unknown, where: string, depth: number, budget: Budget): SceneNode {
  if (depth > MAX_SCENE_DEPTH) fail(`Struktur terlalu dalam (maksimal ${MAX_SCENE_DEPTH}).`);
  budget.nodes += 1;
  if (budget.nodes > MAX_SCENE_NODES) fail(`Terlalu banyak node (maksimal ${MAX_SCENE_NODES}).`);
  const obj = record(value, where);
  const kind = obj.kind;
  if (kind !== "box" && kind !== "text") fail(`${where}.kind tidak dikenal.`);
  const hasil: SceneNode = {
    kind,
    name: str(obj.name, `${where}.name`, MAX_NAME),
    x: num(obj.x, `${where}.x`),
    y: num(obj.y, `${where}.y`),
    width: Math.max(0, num(obj.width, `${where}.width`)),
    height: Math.max(0, num(obj.height, `${where}.height`)),
  };
  if (obj.fill !== undefined) hasil.fill = color(obj.fill, `${where}.fill`);
  if (obj.stroke !== undefined) {
    const stroke = record(obj.stroke, `${where}.stroke`);
    hasil.stroke = {
      color: color(stroke.color, `${where}.stroke.color`),
      weight: Math.max(0, num(stroke.weight, `${where}.stroke.weight`)),
    };
  }
  if (obj.radius !== undefined) {
    if (Array.isArray(obj.radius)) {
      if (obj.radius.length !== 4) fail(`${where}.radius harus 4 bilangan.`);
      hasil.radius = obj.radius.map((r, i) =>
        Math.max(0, num(r, `${where}.radius[${i}]`)),
      ) as [number, number, number, number];
    } else {
      hasil.radius = Math.max(0, num(obj.radius, `${where}.radius`));
    }
  }
  if (obj.opacity !== undefined) hasil.opacity = unit(obj.opacity, `${where}.opacity`);
  if (obj.clip !== undefined) {
    if (typeof obj.clip !== "boolean") fail(`${where}.clip harus boolean.`);
    hasil.clip = obj.clip;
  }
  if (obj.shadows !== undefined) {
    if (!Array.isArray(obj.shadows)) fail(`${where}.shadows harus berupa daftar.`);
    hasil.shadows = obj.shadows.slice(0, MAX_SHADOWS).map((raw, i) => {
      const w = `${where}.shadows[${i}]`;
      const sh = record(raw, w);
      if (typeof sh.inset !== "boolean") fail(`${w}.inset harus boolean.`);
      return {
        x: num(sh.x, `${w}.x`),
        y: num(sh.y, `${w}.y`),
        blur: Math.max(0, num(sh.blur, `${w}.blur`)),
        spread: num(sh.spread, `${w}.spread`),
        color: color(sh.color, `${w}.color`),
        inset: sh.inset,
      };
    });
  }
  if (obj.image !== undefined) {
    if (kind === "text") fail(`${where}: node teks tidak boleh punya gambar.`);
    const img = record(obj.image, `${where}.image`);
    const fit = img.fit;
    if (fit !== "fill" && fit !== "fit" && fit !== "stretch") fail(`${where}.image.fit tidak dikenal.`);
    const data = img.data;
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_IMAGE_CHARS || !BASE64_RE.test(data)) {
      fail(`${where}.image.data bukan base64 yang sah atau terlalu besar.`);
    }
    budget.images += 1;
    if (budget.images > MAX_SCENE_IMAGES) fail(`Terlalu banyak gambar (maksimal ${MAX_SCENE_IMAGES}).`);
    hasil.image = { data, fit };
  }
  if (kind === "text") {
    if (obj.text === undefined) fail(`${where}.text wajib untuk node teks.`);
    hasil.text = text(obj.text, `${where}.text`);
  }
  if (obj.children !== undefined) {
    if (!Array.isArray(obj.children)) fail(`${where}.children harus berupa daftar.`);
    if (kind === "text") fail(`${where}: node teks tidak boleh punya anak.`);
    hasil.children = obj.children.map((child, i) =>
      node(child, `${where}.children[${i}]`, depth + 1, budget),
    );
  }
  return hasil;
}

/** Validasi scene dari klien; melempar `DesignError` 400 bila tak sah. */
export function validateScene(value: unknown): SceneDoc {
  const obj = record(value, "scene");
  if (!Array.isArray(obj.pages)) fail("scene.pages harus berupa daftar.");
  if (obj.pages.length < 1) fail("Scene minimal punya satu halaman.");
  if (obj.pages.length > MAX_SCENE_PAGES) {
    fail(`Terlalu banyak halaman (maksimal ${MAX_SCENE_PAGES}).`);
  }
  const budget: Budget = { nodes: 0, images: 0 };
  const pages = obj.pages.map((raw, i): ScenePage => {
    const where = `scene.pages[${i}]`;
    const page = record(raw, where);
    return {
      name: str(page.name, `${where}.name`, MAX_NAME),
      width: Math.max(1, num(page.width, `${where}.width`)),
      height: Math.max(1, num(page.height, `${where}.height`)),
      root: node(page.root, `${where}.root`, 0, budget),
    };
  });
  return { name: str(obj.name, "scene.name", MAX_NAME), pages };
}
