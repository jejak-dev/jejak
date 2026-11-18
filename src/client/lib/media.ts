/**
 * Media buatan agent di folder kerja sesi: pengenalan jenis, path relatif,
 * URL endpoint media, dan ekstraksi rujukan dari teks pesan.
 *
 * Fungsi murni tanpa DOM supaya mudah diuji. URL luar (http/https) dan skema
 * lain tidak pernah diterjemahkan menjadi media.
 */

export type MediaKind = "image" | "video";

export interface MediaRef {
  /** Path relatif terhadap folder kerja sesi, pemisah `/`. */
  rel: string;
  kind: MediaKind;
  /** Nama berkas untuk label dan chip galat. */
  name: string;
}

/** Batas jumlah media yang ditampilkan per pesan. */
export const MAX_MEDIA = 12;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;

/** Jenis media dari ekstensi; SVG sengaja bukan media (bisa memuat skrip). */
export function mediaKind(path: string): MediaKind | undefined {
  const clean = path.split(/[?#]/)[0] ?? "";
  if (IMAGE_EXT.test(clean)) return "image";
  if (VIDEO_EXT.test(clean)) return "video";
  return undefined;
}

function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function isWindowsPath(path: string): boolean {
  return WINDOWS_ABS.test(path) || path.startsWith("//");
}

function baseName(rel: string): string {
  const parts = rel.split("/");
  return parts[parts.length - 1] ?? rel;
}

/**
 * Path relatif terhadap folder kerja sesi, atau `undefined` bila di luar
 * folder kerja, mengandung `..`, atau berskema (http:, data:, file:, dst).
 */
export function toSessionRelative(cwd: string, path: string): string | undefined {
  const raw = path.trim();
  if (raw === "") return undefined;
  // Skema URL tidak pernah dirender; huruf drive Windows bukan skema.
  if (SCHEME.test(raw) && !WINDOWS_ABS.test(raw)) return undefined;

  const target = toSlashes(raw);
  const rootRaw = toSlashes(cwd.trim());
  const root = rootRaw.length > 1 ? rootRaw.replace(/\/+$/, "") : rootRaw;
  const windows = isWindowsPath(target) || isWindowsPath(root);
  const absolute = target.startsWith("/") || WINDOWS_ABS.test(target);

  if (absolute) {
    if (root === "") return undefined;
    const a = windows ? target.toLowerCase() : target;
    const b = windows ? root.toLowerCase() : root;
    if (a === b) return undefined;
    const prefix = b === "/" ? "/" : `${b}/`;
    if (!a.startsWith(prefix)) return undefined;
    const rel = target.slice(prefix.length);
    return rel === "" ? undefined : rel;
  }

  const rel = target.replace(/^\.\//, "");
  if (rel === "" || rel === ".") return undefined;
  if (rel.split("/").some((part) => part === "..")) return undefined;
  return rel;
}

/** URL endpoint media sesi untuk satu path relatif. */
export function mediaUrl(sessionId: string, rel: string): string {
  return `/api/sessions/${sessionId}/media?path=${encodeURIComponent(rel)}`;
}

interface Hit {
  index: number;
  raw: string;
}

const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const MD_LINK = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BACKTICK = /`([^`\n]+)`/g;
const PLAIN =
  /(?:[A-Za-z]:[\\/]|\/|\.\/|[\w.@+-]+[\\/])(?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:png|jpe?g|gif|webp|mp4|webm|mov)\b/gi;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** Ganti blok kode berpagar dengan spasi; posisi karakter tetap. */
function stripFences(text: string): string {
  return text.replace(FENCE, (block) => block.replace(/[^\n]/g, " "));
}

function collect(text: string, pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    if (raw !== undefined) hits.push({ index: match.index, raw });
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return hits;
}

/**
 * Rujukan media di teks pesan agent: gambar/tautan markdown, path dalam
 * backtick, dan path polos. Tanpa duplikat, urut kemunculan, maksimal 12.
 */
export function extractMedia(text: string, cwd: string): MediaRef[] {
  const source = stripFences(text);
  const hits: Hit[] = [
    ...collect(source, MD_IMAGE),
    ...collect(source, MD_LINK),
    ...collect(source, BACKTICK),
  ];

  // Path polos: hanya yang didahului pemisah, bukan bagian URL.
  PLAIN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAIN.exec(source)) !== null) {
    const before = match.index > 0 ? (source[match.index - 1] ?? "") : "";
    if (before === "" || !/[A-Za-z0-9_./\\:@+-]/.test(before)) {
      hits.push({ index: match.index, raw: match[0] });
    }
  }

  hits.sort((a, b) => a.index - b.index);
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (out.length >= MAX_MEDIA) break;
    const raw = hit.raw.trim().replace(/^<|>$/g, "").split(/[?#]/)[0] ?? "";
    if (raw === "" || /\s/.test(raw)) continue;
    const rel = toSessionRelative(cwd, raw);
    if (rel === undefined || seen.has(rel)) continue;
    const kind = mediaKind(rel);
    if (kind === undefined) continue;
    seen.add(rel);
    out.push({ rel, kind, name: baseName(rel) });
  }
  return out;
}

/** Media dari masukan tool `Read` yang membaca berkas gambar/video. */
export function mediaFromToolInput(
  cwd: string,
  name: string,
  input: unknown,
): MediaRef | undefined {
  if (name !== "Read") return undefined;
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== "string") return undefined;
  const rel = toSessionRelative(cwd, filePath);
  if (rel === undefined) return undefined;
  const kind = mediaKind(rel);
  if (kind === undefined) return undefined;
  return { rel, kind, name: baseName(rel) };
}
