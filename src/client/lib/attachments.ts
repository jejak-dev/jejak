export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MARKER = "\n\nLampiran:\n";

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  image: boolean;
}

export interface AttachmentRef {
  id: string;
  name: string;
  path: string;
  image: boolean;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** URL untuk menampilkan/mengunduh lampiran dari server. */
export function attachmentUrl(ref: { id: string; name: string }): string {
  return `/api/attachments/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.name)}`;
}

/** Teks pesan + daftar path lampiran di akhir; agent membacanya dengan tool Read. */
export function appendAttachments(text: string, attachments: readonly Attachment[]): string {
  const base = text.trim();
  if (attachments.length === 0) return base;
  const lines = attachments.map((item) => `- ${item.path}`).join("\n");
  return `${base === "" ? "Perhatikan lampiran berikut." : base}${MARKER}${lines}`;
}

/** Kebalikan appendAttachments untuk tampilan: badan pesan dan rujukan lampiran. */
export function splitAttachments(text: string): { body: string; files: AttachmentRef[] } {
  const index = text.lastIndexOf(MARKER);
  if (index < 0) return { body: text, files: [] };
  const lines = text.slice(index + MARKER.length).split("\n");
  const files: AttachmentRef[] = [];
  for (const line of lines) {
    if (!line.startsWith("- ")) return { body: text, files: [] };
    const path = line.slice(2).trim();
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    const id = parts[parts.length - 2] ?? "";
    if (!/^[0-9a-f]{12}$/.test(id) || name === "") return { body: text, files: [] };
    files.push({ id, name, path, image: IMAGE_EXT.test(name) });
  }
  return files.length === 0 ? { body: text, files: [] } : { body: text.slice(0, index), files };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString().replace(".", ",")} MB`;
}

/** Nama untuk gambar tempel yang tak punya nama berarti (mis. "image.png" dari clipboard). */
export function pastedName(file: { name: string; type: string }, now: Date): string {
  if (file.name !== "" && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `tempel-${stamp}.${ext === "" ? "png" : ext}`;
}

/** Alasan berkas ditolak di klien, atau `undefined` bila boleh diunggah. */
export function rejectReason(file: { name: string; size: number }, currentCount: number): string | undefined {
  if (currentCount >= MAX_ATTACHMENTS) return `Maksimal ${MAX_ATTACHMENTS} lampiran per pesan.`;
  if (file.size === 0) return `${file.name} kosong.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} terlalu besar (maksimal 8 MB).`;
  return undefined;
}

/** Berkas dari paste atau drop; gambar di clipboard datang sebagai item `file`. */
export function filesFromTransfer(
  transfer: Pick<DataTransfer, "items" | "files"> | null | undefined,
): File[] {
  if (transfer === null || transfer === undefined) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  return fromItems.length > 0 ? fromItems : Array.from(transfer.files ?? []);
}

/** Apakah seretan membawa berkas (bukan teks biasa). */
export function hasFiles(transfer: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return transfer !== null && transfer !== undefined && Array.from(transfer.types ?? []).includes("Files");
}
