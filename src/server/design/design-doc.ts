import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDesign, resolveDesignDir, type DesignPage } from "./manifest";
import { readTokens, type DesignToken } from "./tokens";

/** Galat dokumen desain dengan status HTTP yang sesuai. */
export class DesignDocError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413,
  ) {
    super(message);
    this.name = "DesignDocError";
  }
}

/** Penanda batas blok otomatis; keduanya harus berada di baris tunggal. */
export const AUTO_START = "<!-- jejak:auto:start -->";
export const AUTO_END = "<!-- jejak:auto:end -->";

const MAX_DOC_BYTES = 256 * 1024;
const NOT_CREATED = "Desain belum dibuat.";
const INVALID_FILE = "Berkas DESIGN.md tidak valid.";
const TOO_LARGE = "Berkas DESIGN.md melebihi 256 KB.";
const SAVE_FAILED = "DESIGN.md tidak dapat disimpan.";

/** Escape tanda pipa agar nilai tak merusak tabel Markdown. */
function sel(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Tabel token; daftar kosong diganti catatan singkat. */
function tokenTable(tokens: DesignToken[]): string {
  if (tokens.length === 0) return "Belum ada token.";
  const rows = tokens.map((token) => `| \`${sel(token.name)}\` | \`${sel(token.value)}\` |`);
  return ["| Nama | Nilai |", "| --- | --- |", ...rows].join("\n");
}

/** Tabel halaman; daftar kosong diganti catatan singkat. */
function pageTable(pages: DesignPage[]): string {
  if (pages.length === 0) return "Belum ada halaman.";
  const rows = pages.map(
    (page) => `| \`${sel(page.slug)}\` | ${sel(page.title)} | ${sel(page.device)} |`,
  );
  return ["| Slug | Judul | Perangkat |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * Blok otomatis: daftar token dan halaman terkini. Tanpa cap waktu supaya
 * hasilnya idempoten: panggilan kedua tak mengubah berkas.
 */
export function buildAutoBlock(tokens: DesignToken[], pages: DesignPage[]): string {
  return [
    AUTO_START,
    "## Token saat ini",
    "",
    tokenTable(tokens),
    "",
    "## Halaman saat ini",
    "",
    pageTable(pages),
    AUTO_END,
  ].join("\n");
}

interface LineSpan {
  text: string;
  /** Indeks awal baris (tanpa newline). */
  start: number;
  /** Indeks tepat setelah isi baris. */
  end: number;
}

/** Pecah teks menjadi baris beserta posisi karakternya. */
function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    spans.push({ text: line, start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  return spans;
}

interface BlockSpan {
  start: number;
  end: number;
}

/**
 * Cari blok otomatis: penanda mulai terakhir, lalu penanda akhir pertama
 * sesudahnya. Tanpa penanda akhir, blok dianggap tak lengkap.
 */
function locateBlock(text: string): BlockSpan | undefined {
  const spans = lineSpans(text);
  let startIndex = -1;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (spans[index]?.text.trim() === AUTO_START) {
      startIndex = index;
      break;
    }
  }
  if (startIndex === -1) return undefined;
  for (let index = startIndex + 1; index < spans.length; index += 1) {
    if (spans[index]?.text.trim() === AUTO_END) {
      return { start: spans[startIndex]?.start ?? 0, end: spans[index]?.end ?? 0 };
    }
  }
  return undefined;
}

/**
 * Terapkan blok ke isi berkas: ganti isi di antara penanda bila ada, kalau
 * tidak tambahkan di akhir. Teks di luar penanda tidak pernah disentuh.
 */
export function applyAutoBlock(text: string, block: string): string {
  const located = locateBlock(text);
  if (located !== undefined) {
    return `${text.slice(0, located.start)}${block}${text.slice(located.end)}`;
  }
  if (text === "") return `${block}\n`;
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return `${base}\n${block}\n`;
}

interface DocFile {
  present: boolean;
  text: string;
  mode: number;
}

/** Baca `DESIGN.md`; berkas yang bukan berkas biasa atau terlalu besar -> galat. */
async function readDoc(path: string): Promise<DocFile> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { present: false, text: "", mode: 0o644 };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new DesignDocError(INVALID_FILE, 400);
  }
  if (info.size > MAX_DOC_BYTES) {
    throw new DesignDocError(TOO_LARGE, 413);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DesignDocError(INVALID_FILE, 400);
  }
  return { present: true, text, mode: info.mode & 0o777 };
}

// Antrean promise per path: tulis yang bersamaan tidak saling menimpa.
const locks = new Map<string, Promise<void>>();

function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(path, settled);
  void settled.then(() => {
    if (locks.get(path) === settled) locks.delete(path);
  });
  return run;
}

/**
 * Sinkronkan blok otomatis `design/DESIGN.md` dengan token dan halaman
 * terkini. Bila isi blok tak berubah, berkas tak ditulis. Penulisan atomik
 * lewat berkas sementara di folder yang sama, mode berkas lama dipertahankan.
 */
export async function syncDesignDoc(root: string): Promise<{ changed: boolean }> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) throw new DesignDocError(NOT_CREATED, 404);
  const path = join(designDir, "DESIGN.md");

  return withLock(path, async () => {
    const { tokens } = await readTokens(root);
    const design = await readDesign(root);
    const block = buildAutoBlock(tokens, design.pages);
    const file = await readDoc(path);
    const next = applyAutoBlock(file.text, block);
    if (file.present && next === file.text) return { changed: false };

    const tempPath = join(designDir, `.jejak-design-doc-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, next, { mode: file.mode });
      // mode pada writeFile tunduk pada umask; chmod memastikan mode lama utuh.
      await chmod(tempPath, file.mode);
      await rename(tempPath, path);
    } catch {
      await rm(tempPath, { force: true });
      throw new DesignDocError(SAVE_FAILED, 400);
    }
    return { changed: true };
  });
}
