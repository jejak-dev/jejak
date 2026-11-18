import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { MAX_PAGE_BYTES, SLUG_RE, resolveDesignDir } from "./manifest";
import { frameRuntimeScript } from "./runtime";

/** Galat perakitan halaman dengan status HTTP yang sesuai. */
export class DesignError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413,
  ) {
    super(message);
    this.name = "DesignError";
  }
}

const MAX_CSS_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const PLACEHOLDER_GIF =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const EMPTY_URL = 'url("data:,")';

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/** Isi CSP untuk dokumen frame; `allowGoogleFonts` membuka dua host font. */
export function buildCsp(allowGoogleFonts = false): string {
  const style = allowGoogleFonts
    ? "style-src 'unsafe-inline' https://fonts.googleapis.com"
    : "style-src 'unsafe-inline'";
  const font = allowGoogleFonts
    ? "font-src data: https://fonts.gstatic.com"
    : "font-src data:";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    style,
    "img-src data:",
    font,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");
}

interface Tag {
  start: number;
  end: number;
  text: string;
  name: string;
  closing: boolean;
}

const TAG_NAME_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * Pemindai tag linear: satu kali jalan dari kiri ke kanan, tanpa regex yang
 * bisa mundur. Komentar HTML dilewati, dan isi `<script>`/`<style>` tidak
 * dipindai sebagai tag (hanya tag pembuka dan penutupnya yang dicatat).
 */
function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const noClose = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const text = html.slice(lt, gt + 1);
    const match = TAG_NAME_RE.exec(text);
    if (match === null) {
      i = gt + 1;
      continue;
    }
    const name = match[2]!.toLowerCase();
    const closing = match[1] === "/";
    tags.push({ start: lt, end: gt + 1, text, name, closing });
    i = gt + 1;
    if (closing || (name !== "script" && name !== "style")) continue;
    if (noClose.has(name)) continue;
    // Lompati isi mentah sampai tag penutupnya.
    const closeRe = new RegExp(`</${name}\\s*>`, "gi");
    closeRe.lastIndex = i;
    const close = closeRe.exec(html);
    if (close === null) {
      // Tidak ada penutup sama sekali: jangan cari ulang untuk tag berikutnya.
      noClose.add(name);
      continue;
    }
    tags.push({
      start: close.index,
      end: close.index + close[0].length,
      text: close[0],
      name,
      closing: true,
    });
    i = close.index + close[0].length;
  }
  return tags;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Menerapkan suntingan terurut; suntingan yang tumpang tindih dilewati. */
function applyEdits(html: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    parts.push(html.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

/** Membaca nilai atribut dari teks satu tag; nama atribut tak peka huruf. */
function attrValue(tag: string, name: string): string | undefined {
  const re = new RegExp(
    `(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const match = re.exec(tag);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/** Mengganti nilai satu atribut di dalam teks tag (kutip ganda, di-escape). */
function replaceAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(
    `((?:^|[\\s/])${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`,
    "i",
  );
  const escaped = value.replace(/"/g, "&quot;");
  return tag.replace(re, (_whole, prefix: string) => `${prefix}"${escaped}"`);
}

function isInside(dir: string, target: string): boolean {
  if (target === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix);
}

function externalHost(href: string): string | undefined {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

interface AssembleContext {
  designDir: string;
  pagesDir: string;
  totalBytes: number;
  warnings: string[];
}

type AssetRead = { ok: true; dataUri: string } | { ok: false; reason: string };

/** Membaca aset relatif di dalam `design/` dan mengubahnya menjadi data URI. */
async function readAsset(
  rel: string,
  baseDir: string,
  ctx: AssembleContext,
): Promise<AssetRead> {
  const clean = rel.split(/[?#]/)[0] ?? "";
  if (clean === "") return { ok: false, reason: "jalur kosong" };
  if (isAbsolute(clean) || win32.isAbsolute(clean)) {
    return { ok: false, reason: "path absolut" };
  }
  let target: string;
  try {
    target = await realpath(resolve(baseDir, clean));
  } catch {
    return { ok: false, reason: "berkas tidak ditemukan" };
  }
  if (!isInside(ctx.designDir, target)) {
    return { ok: false, reason: "di luar folder design" };
  }
  let info;
  try {
    info = await lstat(target);
  } catch {
    return { ok: false, reason: "berkas tidak ditemukan" };
  }
  if (!info.isFile()) return { ok: false, reason: "bukan berkas biasa" };
  const mime = MIME_BY_EXT[extname(target).toLowerCase()];
  if (mime === undefined) return { ok: false, reason: "tipe berkas tidak diizinkan" };
  if (info.size > MAX_ASSET_BYTES) return { ok: false, reason: "melebihi 512 KB" };
  if (ctx.totalBytes + info.size > MAX_TOTAL_BYTES) {
    return { ok: false, reason: "melebihi batas total 4 MB" };
  }
  let data: Buffer;
  try {
    data = await readFile(target);
  } catch {
    return { ok: false, reason: "berkas tidak dapat dibaca" };
  }
  ctx.totalBytes += data.length;
  return { ok: true, dataUri: `data:${mime};base64,${data.toString("base64")}` };
}

/** Mengganti satu `url(...)`; `undefined` berarti biarkan apa adanya. */
async function cssUrlReplacement(
  raw: string,
  baseDir: string,
  ctx: AssembleContext,
): Promise<string | undefined> {
  const value = raw.trim();
  if (value === "") return undefined;
  if (/^data:/i.test(value)) return undefined;
  if (value.startsWith("#")) return undefined;
  if (/^https?:/i.test(value) || value.startsWith("//")) {
    ctx.warnings.push(`Sumber luar diblokir di frame: ${value}`);
    return undefined;
  }
  if (value.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value)) {
    ctx.warnings.push(`Aset "${value}" diganti penampung: path absolut.`);
    return EMPTY_URL;
  }
  const asset = await readAsset(value, baseDir, ctx);
  if (!asset.ok) {
    ctx.warnings.push(`Aset "${value}" diganti penampung: ${asset.reason}.`);
    return EMPTY_URL;
  }
  return `url("${asset.dataUri}")`;
}

/** Memproses semua `url(...)` di dalam sepotong CSS. */
async function processCssUrls(
  css: string,
  baseDir: string,
  ctx: AssembleContext,
): Promise<string> {
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const replacement = await cssUrlReplacement(raw, baseDir, ctx);
    if (replacement === undefined) continue;
    parts.push(css.slice(last, match.index), replacement);
    last = re.lastIndex;
  }
  parts.push(css.slice(last));
  return parts.join("");
}

/** Menghapus `@import` dari CSS yang di-inline. */
function stripImports(css: string, warnings: string[]): string {
  let removed = 0;
  const out = css.replace(/@import\b[^;{}]*;?/gi, () => {
    removed += 1;
    return "";
  });
  for (let i = 0; i < removed; i += 1) {
    warnings.push("@import tidak didukung, dihapus.");
  }
  return out;
}

type CssRead = { ok: true; css: string; dir: string } | { ok: false; reason: string };

/** Membaca berkas CSS relatif terhadap `design/pages/`. */
async function readCssFile(href: string, ctx: AssembleContext): Promise<CssRead> {
  const clean = href.split(/[?#]/)[0] ?? "";
  if (clean === "") return { ok: false, reason: "jalur kosong" };
  if (isAbsolute(clean) || win32.isAbsolute(clean)) {
    return { ok: false, reason: "path absolut" };
  }
  let target: string;
  try {
    target = await realpath(resolve(ctx.pagesDir, clean));
  } catch {
    return { ok: false, reason: "berkas tidak ditemukan" };
  }
  if (!isInside(ctx.designDir, target)) {
    return { ok: false, reason: "di luar folder design" };
  }
  let info;
  try {
    info = await lstat(target);
  } catch {
    return { ok: false, reason: "berkas tidak ditemukan" };
  }
  if (!info.isFile()) return { ok: false, reason: "bukan berkas biasa" };
  if (extname(target).toLowerCase() !== ".css") {
    return { ok: false, reason: "bukan berkas .css" };
  }
  if (info.size > MAX_CSS_BYTES) return { ok: false, reason: "melebihi 256 KB" };
  try {
    return { ok: true, css: await readFile(target, "utf8"), dir: dirname(target) };
  } catch {
    return { ok: false, reason: "berkas tidak dapat dibaca" };
  }
}

/** Hasil penggantian satu tag `<link rel="stylesheet">`. */
async function stylesheetReplacement(
  href: string,
  ctx: AssembleContext,
  allowGoogleFonts: boolean,
): Promise<string | undefined> {
  const value = href.trim();
  if (value === "") return undefined;
  if (/^data:/i.test(value)) return undefined;
  if (/^https?:/i.test(value) || value.startsWith("//")) {
    if (allowGoogleFonts && externalHost(value) === "fonts.googleapis.com") {
      return undefined;
    }
    ctx.warnings.push(`Sumber luar diblokir di frame: ${value}`);
    return undefined;
  }
  if (value.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value)) {
    ctx.warnings.push(`Gaya "${value}" dihapus: path absolut.`);
    return "";
  }
  const css = await readCssFile(value, ctx);
  if (!css.ok) {
    ctx.warnings.push(`Gaya "${value}" dihapus: ${css.reason}.`);
    return "";
  }
  const withoutImports = stripImports(css.css, ctx.warnings);
  const processed = await processCssUrls(withoutImports, css.dir, ctx);
  return `<style>${processed}</style>`;
}

/** Pengganti `src` pada `<img>`/`<source>`; `undefined` berarti biarkan. */
async function mediaReplacement(
  src: string,
  ctx: AssembleContext,
): Promise<string | undefined> {
  const value = src.trim();
  if (value === "") return undefined;
  if (/^data:/i.test(value)) return undefined;
  if (/^https?:/i.test(value) || value.startsWith("//")) {
    ctx.warnings.push(`Sumber luar diblokir di frame: ${value}`);
    return undefined;
  }
  if (value.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value)) {
    ctx.warnings.push(`Aset "${value}" diganti penampung: path absolut.`);
    return PLACEHOLDER_GIF;
  }
  const asset = await readAsset(value, ctx.pagesDir, ctx);
  if (!asset.ok) {
    ctx.warnings.push(`Aset "${value}" diganti penampung: ${asset.reason}.`);
    return PLACEHOLDER_GIF;
  }
  return asset.dataUri;
}

/**
 * Menyisipkan meta CSP sebagai elemen pertama `<head>`. Posisi dicari lewat
 * pemindai tag (yang melewati komentar dan isi skrip/gaya), supaya `<head>`
 * palsu di dalam komentar tidak menelan meta itu.
 */
function insertCsp(html: string, tags: Tag[], allowGoogleFonts: boolean): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(allowGoogleFonts)}">`;
  const head = tags.find((tag) => !tag.closing && tag.name === "head");
  if (head !== undefined) return html.slice(0, head.end) + meta + html.slice(head.end);
  const block = `<head>${meta}</head>`;
  const htmlTag = tags.find((tag) => !tag.closing && tag.name === "html");
  if (htmlTag !== undefined) return html.slice(0, htmlTag.end) + block + html.slice(htmlTag.end);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype !== null) return html.slice(0, doctype[0].length) + block + html.slice(doctype[0].length);
  return block + html;
}

/** Menyisipkan skrip runtime tepat sebelum `</body>` terakhir. */
function insertRuntime(html: string, script: string): string {
  const re = /<\/body\s*>/gi;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) last = match;
  if (last === null) return html + script;
  return html.slice(0, last.index) + script + html.slice(last.index);
}

/**
 * Merakit satu halaman `design/pages/<slug>.html` menjadi dokumen aman untuk
 * `srcdoc`: CSP ketat, CSS dan aset di-inline, tag berbahaya dibuang, runtime
 * disisipkan. Hanya membaca disk.
 */
export async function assemblePage(
  root: string,
  slug: string,
  options: { allowGoogleFonts?: boolean } = {},
): Promise<{ slug: string; html: string; mtime: number; warnings: string[] }> {
  if (!SLUG_RE.test(slug)) throw new DesignError("Slug halaman tidak valid.", 400);
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) throw new DesignError("Halaman tidak ditemukan.", 404);
  const pagesDir = join(designDir, "pages");
  const pagePath = join(pagesDir, `${slug}.html`);

  let linkInfo;
  try {
    linkInfo = await lstat(pagePath);
  } catch {
    throw new DesignError("Halaman tidak ditemukan.", 404);
  }
  if (!linkInfo.isFile()) throw new DesignError("Halaman tidak ditemukan.", 404);

  let realPage: string;
  try {
    realPage = await realpath(pagePath);
  } catch {
    throw new DesignError("Halaman tidak ditemukan.", 404);
  }
  if (!isInside(designDir, realPage)) {
    throw new DesignError("Halaman tidak ditemukan.", 404);
  }
  const info = await lstat(realPage);
  if (!info.isFile()) throw new DesignError("Halaman tidak ditemukan.", 404);
  if (info.size > MAX_PAGE_BYTES) throw new DesignError("Halaman melebihi 512 KB.", 413);

  const source = await readFile(realPage, "utf8");
  const allowGoogleFonts = options.allowGoogleFonts === true;
  const ctx: AssembleContext = { designDir, pagesDir, totalBytes: 0, warnings: [] };
  const tags = scanTags(source);
  const edits: Edit[] = [];

  // Langkah 3: buang <base> dan <script src>.
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i]!;
    if (tag.closing) continue;
    if (tag.name === "base") {
      edits.push({ start: tag.start, end: tag.end, text: "" });
      ctx.warnings.push("Tag <base> dihapus.");
      continue;
    }
    if (tag.name !== "script") continue;
    const src = attrValue(tag.text, "src");
    if (src === undefined) continue;
    // Hanya ikut membuang tag penutup bila itu tag berikutnya.
    const next = tags[i + 1];
    const end = next !== undefined && next.name === "script" && next.closing ? next.end : tag.end;
    edits.push({ start: tag.start, end, text: "" });
    ctx.warnings.push(`Skrip luar dihapus: ${src}.`);
  }

  // Langkah 4: inline <link rel="stylesheet">.
  for (const tag of tags) {
    if (tag.closing || tag.name !== "link") continue;
    const rel = attrValue(tag.text, "rel");
    if (rel === undefined || !/(^|\s)stylesheet(\s|$)/i.test(rel.trim())) continue;
    const href = attrValue(tag.text, "href");
    if (href === undefined) continue;
    const replacement = await stylesheetReplacement(href, ctx, allowGoogleFonts);
    if (replacement === undefined) continue;
    edits.push({ start: tag.start, end: tag.end, text: replacement });
  }

  // Langkah 5a: url(...) di dalam <style>.
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i]!;
    if (tag.closing || tag.name !== "style") continue;
    let close: Tag | undefined;
    for (let j = i + 1; j < tags.length; j += 1) {
      const next = tags[j]!;
      if (next.name === "style" && next.closing) {
        close = next;
        break;
      }
    }
    if (close === undefined) continue;
    const css = source.slice(tag.end, close.start);
    const processed = await processCssUrls(css, pagesDir, ctx);
    if (processed !== css) {
      edits.push({ start: tag.end, end: close.start, text: processed });
    }
  }

  // Langkah 5a: url(...) di atribut style, dan 5b: src pada <img>/<source>.
  // Keduanya menyunting teks tag yang sama, jadi digabung per tag.
  for (const tag of tags) {
    if (tag.closing) continue;
    let text = tag.text;
    const styleAttr = /(^|[\s/])style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
    if (styleAttr !== null) {
      const value = styleAttr[2] ?? styleAttr[3] ?? "";
      if (/url\(/i.test(value)) {
        const processed = await processCssUrls(value, pagesDir, ctx);
        if (processed !== value) {
          const quote = styleAttr[2] !== undefined ? '"' : "'";
          // Kutip di dalam url() tidak boleh sama dengan kutip atribut.
          const safe =
            quote === '"' ? processed.replace(/url\("([^"]*)"\)/g, "url('$1')") : processed;
          const prefix = styleAttr[0].slice(0, styleAttr[0].length - value.length - 1);
          text =
            text.slice(0, styleAttr.index) +
            prefix +
            safe +
            quote +
            text.slice(styleAttr.index + styleAttr[0].length);
        }
      }
    }
    if (tag.name === "img" || tag.name === "source") {
      const src = attrValue(text, "src");
      if (src !== undefined) {
        const replacement = await mediaReplacement(src, ctx);
        if (replacement !== undefined) text = replaceAttr(text, "src", replacement);
      }
    }
    if (text !== tag.text) edits.push({ start: tag.start, end: tag.end, text });
  }

  let html = applyEdits(source, edits);
  html = insertCsp(html, scanTags(html), allowGoogleFonts);
  html = insertRuntime(html, frameRuntimeScript(slug));

  return { slug, html, mtime: Math.round(info.mtimeMs), warnings: ctx.warnings };
}
