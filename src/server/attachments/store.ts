import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 80;
const ID_PATTERN = /^[0-9a-f]{12}$/;
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface SavedAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  image: boolean;
}

/** Nama berkas aman: tanpa path, karakter aneh jadi `_`, panjang dibatasi. */
export function safeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").trim();
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = `${name.slice(0, MAX_NAME - ext.length)}${ext}`;
  }
  return name === "" ? "lampiran" : name;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function imageTypeOf(name: string): string | undefined {
  return IMAGE_TYPES[extensionOf(name)];
}

/** Menyimpan lampiran pesan di `<root>/<id>/<nama>`; di luar folder proyek. */
export class AttachmentStore {
  constructor(private readonly options: { root: string }) {}

  get root(): string {
    return this.options.root;
  }

  async save(rawName: unknown, base64: unknown): Promise<SavedAttachment> {
    if (typeof rawName !== "string" || typeof base64 !== "string") {
      throw new AttachmentError("Nama dan data lampiran harus berupa string.", 400);
    }
    if (base64.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8) {
      throw new AttachmentError("Lampiran terlalu besar (maksimal 8 MB).", 413);
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw new AttachmentError("Lampiran kosong.", 400);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("Lampiran terlalu besar (maksimal 8 MB).", 413);
    }
    const name = safeAttachmentName(rawName);
    const id = randomBytes(6).toString("hex");
    const dir = join(this.options.root, id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, bytes);
    return { id, name, path, size: bytes.length, image: imageTypeOf(name) !== undefined };
  }

  /** Path berkas tersimpan, atau `undefined` bila id/nama tidak valid atau tak ada. */
  resolve(id: string, name: string): string | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    if (name !== safeAttachmentName(name) || name.includes("/") || name.includes("\\")) {
      return undefined;
    }
    const path = join(this.options.root, id, name);
    return existsSync(path) ? path : undefined;
  }
}
