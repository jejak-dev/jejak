import { useEffect, useState } from "preact/hooks";
import { splitLines } from "./files";
import { canonicalPath } from "./format";
import type { PermissionStatus } from "./timeline";

export type PermissionIcon = "file" | "edit" | "terminal" | "eye" | "cube";

export type PermissionPreview =
  | { kind: "file"; path: string; lines: string[] }
  | { kind: "diff"; path: string; removed: string[]; added: string[] }
  | { kind: "command"; command: string }
  | { kind: "path"; path: string }
  | { kind: "browser"; label: string; lines: string[] }
  | { kind: "json"; text: string };

export interface PermissionView {
  tool: string;
  icon: PermissionIcon;
  /** Jenis aksi: "Baca", "Ubah berkas", "Jalankan perintah", "Jaringan". */
  risk: string;
  /** Peringatan yang membuat kartu tampil merah; tidak ada = aksi biasa. */
  warning?: string;
  lead: string;
  /** Sasaran aksi (path/URL) yang ditampilkan sebagai kode; kosong bila tidak ada. */
  target: string;
  preview: PermissionPreview;
}

const MAX_LINES = 200;
const MAX_JSON = 2000;
/** Batas panjang teks yang diketik yang ditampilkan di pratinjau izin. */
const MAX_BROWSER_TEXT = 200;

/** Awalan nama tool MCP milik server memory Jejak. */
const MCP_MEMORY_PREFIX = "mcp__jejak-memory__";

/** Judul ramah per tool browser (tanpa awalan server MCP). */
const BROWSER_TOOL_TITLES: Record<string, string> = {
  browser_navigate: "Buka alamat di browser",
  browser_click: "Klik elemen di browser",
  browser_type: "Ketik di browser",
  browser_press: "Tekan tombol di browser",
  browser_scroll: "Gulir browser",
  browser_new_tab: "Tab baru di browser",
  browser_switch_tab: "Pindah tab browser",
  browser_close_tab: "Tutup tab browser",
  browser_back: "Kembali di browser",
};

/** Level risiko tool browser: semuanya mengendalikan browser pengguna. */
const BROWSER_RISK = "Mengendalikan browser";

/** Peringatan saat agent akan mengetik teks. */
const BROWSER_TYPE_WARNING = "Jangan setujui bila teks berisi rahasia";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toLines(value: string): string[] {
  const lines = splitLines(value);
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
}

function normalize(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out;
}

/** True bila path (absolut atau relatif terhadap cwd) jatuh di luar folder kerja. */
export function isOutsideCwd(cwd: string, target: string): boolean {
  if (target === "" || cwd === "") return false;
  const base = normalize(canonicalPath(cwd));
  const resolved = normalize(canonicalPath(target.startsWith("/") ? target : `${cwd}/${target}`));
  if (resolved.length < base.length) return true;
  return base.some((segment, index) => resolved[index] !== segment);
}

const DANGEROUS_COMMANDS: { pattern: RegExp; warning: string }[] = [
  { pattern: /\brm\s+(?:-\w*[rR]\w*|--recursive)\b/, warning: "Menghapus berkas" },
  { pattern: /\bsudo\b/, warning: "Memakai sudo" },
  { pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:ba|z)?sh\b/, warning: "Mengunduh lalu menjalankan skrip" },
  { pattern: /\b(?:mkfs|dd\s+if=)/, warning: "Menulis langsung ke disk" },
  { pattern: /\bgit\s+(?:reset\s+--hard|push\b[^;&|]*(?:--force|-f\b)|clean\s+-\w*f)/, warning: "Mengubah atau menghapus riwayat git" },
];

export function dangerousCommandWarning(command: string): string | undefined {
  return DANGEROUS_COMMANDS.find((entry) => entry.pattern.test(command))?.warning;
}

function jsonPreview(input: unknown): PermissionPreview {
  let body: string;
  try {
    body = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    body = String(input);
  }
  return { kind: "json", text: body.length > MAX_JSON ? `${body.slice(0, MAX_JSON)}…` : body };
}

function withWarning(view: PermissionView, warning: string | undefined): PermissionView {
  return warning === undefined ? view : { ...view, warning };
}

/** Nama tool browser tanpa awalan server MCP; undefined bila bukan tool browser. */
function namaToolBrowser(name: string): string | undefined {
  const nama = name.startsWith(MCP_MEMORY_PREFIX) ? name.slice(MCP_MEMORY_PREFIX.length) : name;
  return BROWSER_TOOL_TITLES[nama] === undefined ? undefined : nama;
}

/** Teks angka (mis. nomor elemen) dari masukan tool. */
function nomor(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

/**
 * Tampilan izin untuk tool browser.
 *
 * Judul, ringkasan, dan pratinjau dibuat per tool supaya pengguna tahu apa
 * yang akan dilakukan agent di browsernya. Teks yang diketik ditampilkan
 * (dipotong) karena isi itulah yang paling perlu diperiksa pengguna.
 */
function describeBrowserPermission(
  name: string,
  data: Record<string, unknown>,
): PermissionView | undefined {
  const tool = namaToolBrowser(name);
  if (tool === undefined) return undefined;
  const judul = BROWSER_TOOL_TITLES[tool] ?? name;
  switch (tool) {
    case "browser_navigate": {
      const url = text(data.url);
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Membuka alamat di tab browser aktif",
        target: url,
        preview: { kind: "browser", label: "alamat", lines: url === "" ? [] : [url] },
      };
    }

    case "browser_new_tab": {
      const url = text(data.url);
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Membuka tab baru di browser",
        target: url,
        preview: {
          kind: "browser",
          label: "alamat",
          lines: url === "" ? ["(tab kosong)"] : [url],
        },
      };
    }

    case "browser_click": {
      const ref = nomor(data.ref);
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Mengeklik elemen di halaman",
        target: ref === "" ? "" : `elemen #${ref}`,
        preview: { kind: "browser", label: "elemen", lines: ref === "" ? [] : [`#${ref}`] },
      };
    }

    case "browser_type": {
      const ref = nomor(data.ref);
      const isi = text(data.text);
      const dipotong = isi.length > MAX_BROWSER_TEXT ? `${isi.slice(0, MAX_BROWSER_TEXT)}…` : isi;
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        warning: BROWSER_TYPE_WARNING,
        lead: "Mengetik teks ke elemen halaman",
        target: ref === "" ? "" : `elemen #${ref}`,
        preview: {
          kind: "browser",
          label: "teks yang diketik",
          lines: dipotong === "" ? [] : [dipotong],
        },
      };
    }

    case "browser_press": {
      const key = text(data.key);
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Menekan tombol di halaman",
        target: key,
        preview: { kind: "browser", label: "tombol", lines: key === "" ? [] : [key] },
      };
    }

    case "browser_scroll": {
      const arah = text(data.direction);
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Menggulir halaman",
        target: arah,
        preview: { kind: "browser", label: "arah", lines: arah === "" ? [] : [arah] },
      };
    }

    case "browser_switch_tab":
    case "browser_close_tab": {
      const id = text(data.id);
      const menutup = tool === "browser_close_tab";
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: menutup ? "Menutup tab browser" : "Berpindah ke tab lain",
        target: id,
        preview: { kind: "browser", label: "tab", lines: id === "" ? [] : [id] },
      };
    }

    default:
      return {
        tool: judul,
        icon: "cube",
        risk: BROWSER_RISK,
        lead: "Kembali ke halaman sebelumnya",
        target: "",
        preview: { kind: "browser", label: "aksi", lines: ["Kembali satu halaman"] },
      };
  }
}

export function describePermission(name: string, input: unknown, cwd: string): PermissionView {
  const data = isRecord(input) ? input : {};
  const browser = describeBrowserPermission(name, data);
  if (browser !== undefined) return browser;
  const filePath = text(data.file_path) || text(data.path);
  const outside = filePath !== "" && isOutsideCwd(cwd, filePath) ? "Di luar folder kerja" : undefined;

  switch (name) {
    case "Write":
      return withWarning(
        {
          tool: name,
          icon: "file",
          risk: "Ubah berkas",
          lead: "Membuat atau menimpa berkas",
          target: filePath,
          preview: { kind: "file", path: filePath, lines: toLines(text(data.content)) },
        },
        outside,
      );

    case "Edit":
    case "MultiEdit": {
      const edits = Array.isArray(data.edits) ? data.edits.filter(isRecord) : [data];
      const removed = edits.flatMap((edit) => toLines(text(edit.old_string)));
      const added = edits.flatMap((edit) => toLines(text(edit.new_string)));
      return withWarning(
        {
          tool: name,
          icon: "edit",
          risk: "Ubah berkas",
          lead: "Mengubah berkas",
          target: filePath,
          preview: { kind: "diff", path: filePath, removed, added },
        },
        outside,
      );
    }

    case "Bash": {
      const command = text(data.command);
      return withWarning(
        {
          tool: name,
          icon: "terminal",
          risk: "Jalankan perintah",
          lead: "Menjalankan perintah di folder kerja",
          target: "",
          preview: { kind: "command", command },
        },
        dangerousCommandWarning(command),
      );
    }

    case "Read":
    case "NotebookEdit":
      return withWarning(
        {
          tool: name,
          icon: "eye",
          risk: name === "Read" ? "Baca" : "Ubah berkas",
          lead: name === "Read" ? "Membaca berkas" : "Mengubah notebook",
          target: filePath,
          preview: { kind: "path", path: filePath },
        },
        outside,
      );

    case "Glob":
    case "Grep": {
      const target = text(data.pattern) || filePath;
      return withWarning(
        {
          tool: name,
          icon: "eye",
          risk: "Baca",
          lead: name === "Glob" ? "Mencari berkas" : "Mencari isi berkas",
          target,
          preview: { kind: "path", path: target },
        },
        outside,
      );
    }

    case "WebFetch":
    case "WebSearch": {
      const target = text(data.url) || text(data.query);
      return {
        tool: name,
        icon: "cube",
        risk: "Jaringan",
        lead: name === "WebFetch" ? "Mengambil halaman web" : "Mencari di web",
        target,
        preview: { kind: "path", path: target },
      };
    }

    default:
      return {
        tool: name,
        icon: "cube",
        risk: "Jalankan tool",
        lead: `Memakai tool ${name}`,
        target: "",
        preview: jsonPreview(input),
      };
  }
}

/** Sisa detik sampai batas waktu; null bila tidak ada batas. Tidak pernah negatif. */
export function secondsUntil(expiresAt: string | undefined, now: Date): number | null {
  if (expiresAt === undefined) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Hitung mundur menuju batas waktu izin.
 *
 * `active`false membuat hitungan berhenti; nilai terakhir dikembalikan.
 */
export function useCountdown(expiresAt: string | undefined, active: boolean): number | null {
  const [seconds, setSeconds] = useState(() => secondsUntil(expiresAt, new Date()));
  useEffect(() => {
    if (!active) return;
    setSeconds(secondsUntil(expiresAt, new Date()));
    const timer = window.setInterval(() => setSeconds(secondsUntil(expiresAt, new Date())), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, active]);
  return seconds;
}

/** Lencana status izin yang sudah diputuskan; dipakai kartu izin dan tab Rencana. */
export const DONE_LABELS: Record<
  Exclude<PermissionStatus, "menunggu">,
  { text: string; tone: string }
> = {
  diizinkan: { text: "Diizinkan", tone: "jk-step-selesai" },
  ditolak: { text: "Ditolak", tone: "jk-step-gagal" },
  kedaluwarsa: { text: "Kedaluwarsa", tone: "" },
  dihentikan: { text: "Sesi dihentikan", tone: "" },
};
