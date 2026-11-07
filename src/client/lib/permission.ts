export type PermissionIcon = "file" | "edit" | "terminal" | "eye" | "cube";

export type PermissionPreview =
  | { kind: "file"; path: string; lines: string[] }
  | { kind: "diff"; path: string; removed: string[]; added: string[] }
  | { kind: "command"; command: string }
  | { kind: "path"; path: string }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
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
  const base = normalize(cwd);
  const resolved = normalize(target.startsWith("/") ? target : `${cwd}/${target}`);
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

export function describePermission(name: string, input: unknown, cwd: string): PermissionView {
  const data = isRecord(input) ? input : {};
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
