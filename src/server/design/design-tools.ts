import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import type { McpToolDefinition, McpToolOutcome } from "../memory/mcp-http";
import { DesignPatchError, patchPage, type PatchOp } from "./patch";

export interface DesignToolsOptions {
  /** Penyuntingan berkas menyala (JEJAK_FILE_EDIT != "0"); dibaca setiap panggilan. */
  editEnabled: () => boolean;
  /** Penyimpan audit; tanpa ini tool tidak dicatat. */
  audit?: AuditStore;
}

/** Pesan galat saat penyuntingan berkas dimatikan. */
export const DESIGN_EDIT_DISABLED_MESSAGE = "Penyuntingan berkas dimatikan.";

const OPS = ["replace", "inner", "text", "attr", "remove", "before", "after"] as const;

const PATCH_DEFINITION: McpToolDefinition = {
  name: "design_patch",
  description:
    "Ubah SATU elemen pada halaman desain design/pages/<slug>.html tanpa menulis ulang seluruh halaman. Selector harus cocok tepat satu elemen (disarankan [id=\"...\"] atau [data-testid=\"...\"]; boleh juga tag:nth-of-type(n) dan tanda >). Sertakan baseMtime dari hasil terakhir agar tidak menimpa edit lain; hasil berisi mtime baru.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Slug halaman di design/pages/ (tanpa .html)." },
      selector: {
        type: "string",
        description:
          "Selector yang cocok tepat satu elemen. Pakai [id=\"...\"] atau [data-testid=\"...\"] bila ada.",
      },
      op: {
        type: "string",
        enum: [...OPS],
        description:
          "Jenis perubahan: replace (ganti elemen, HTML), inner (isi elemen, HTML), text (isi elemen, teks ter-escape), attr (aturan atribut, memakai attr + value), remove (hapus elemen, tanpa value), before/after (sisipkan HTML di luar elemen).",
      },
      value: {
        type: "string",
        description:
          "Isi untuk replace, inner, text, before, after; nilai atribut untuk attr (value kosong atau tanpa value = hapus atribut); tidak dipakai untuk remove.",
      },
      attr: { type: "string", description: "Nama atribut untuk op attr." },
      baseMtime: {
        type: "number",
        description:
          "mtime halaman dari hasil terakhir; bila halaman sudah berubah, tambal ditolak agar tidak menimpa edit lain.",
      },
    },
    required: ["slug", "selector", "op"],
    additionalProperties: false,
  },
};

interface ArgumenPatch {
  slug: string;
  selector: string;
  op: PatchOp;
  value?: string;
  attr?: string;
  baseMtime?: number;
}

/** Galat argumen tool; pesannya aman ditampilkan. */
class ArgumenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumenError";
  }
}

const FIELD_PATCH = ["slug", "selector", "op", "value", "attr", "baseMtime"] as const;

function isOp(value: unknown): value is PatchOp {
  return typeof value === "string" && (OPS as readonly string[]).includes(value);
}

/** Tolak argumen yang bukan objek dan field yang tak dikenal. */
function cekArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ArgumenError("Argumen harus berupa objek.");
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(FIELD_PATCH as readonly string[]).includes(key)) {
      throw new ArgumenError(`Argumen "${key}" tidak dikenal.`);
    }
  }
  return record;
}

/** Validasi tipe setiap field; nilai `value` tak pernah masuk pesan galat. */
function parseArgs(args: unknown): ArgumenPatch {
  const rec = cekArgs(args);
  if (typeof rec.slug !== "string") throw new ArgumenError("Argumen slug tidak valid.");
  if (typeof rec.selector !== "string") throw new ArgumenError("Argumen selector tidak valid.");
  if (!isOp(rec.op)) throw new ArgumenError("Argumen op tidak valid.");
  if (rec.value !== undefined && typeof rec.value !== "string") {
    throw new ArgumenError("Argumen value tidak valid.");
  }
  if (rec.attr !== undefined && typeof rec.attr !== "string") {
    throw new ArgumenError("Argumen attr tidak valid.");
  }
  if (rec.baseMtime !== undefined && typeof rec.baseMtime !== "number") {
    throw new ArgumenError("Argumen baseMtime tidak valid.");
  }
  const patch: ArgumenPatch = { slug: rec.slug, selector: rec.selector, op: rec.op };
  if (rec.value !== undefined) patch.value = rec.value;
  if (rec.attr !== undefined) patch.attr = rec.attr;
  if (rec.baseMtime !== undefined) patch.baseMtime = rec.baseMtime;
  return patch;
}

/**
 * Tool desain untuk agent: menambal satu elemen halaman di `design/pages/`.
 *
 * Nilai `value` dan isi HTML tak pernah masuk ke audit maupun pesan galat.
 */
export class DesignTools {
  readonly definitions: McpToolDefinition[] = [PATCH_DEFINITION];

  private readonly editEnabled: () => boolean;
  private readonly audit: AuditStore | undefined;

  constructor(options: DesignToolsOptions) {
    this.editEnabled = options.editEnabled;
    this.audit = options.audit;
  }

  async call(
    ctx: { sessionId: string; cwd: string },
    name: string,
    args: unknown,
  ): Promise<McpToolOutcome> {
    if (name !== "design_patch") {
      return { text: `Tool "${String(name)}" tidak dikenal.`, isError: true };
    }
    // Saklar dibaca saat pemanggilan: berlaku seketika.
    if (!this.editEnabled()) {
      return { text: DESIGN_EDIT_DISABLED_MESSAGE, isError: true };
    }
    let patch: ArgumenPatch;
    try {
      patch = parseArgs(args);
    } catch (error) {
      if (error instanceof ArgumenError) return { text: error.message, isError: true };
      return { text: "Argumen tidak valid.", isError: true };
    }

    try {
      // Sesi workspace multi-repo memakai cwd sesi saja (batasan diterima).
      const hasil = await patchPage(ctx.cwd, patch);
      recordAudit(this.audit, {
        kind: "berkas",
        sessionId: ctx.sessionId,
        summary: "Halaman desain diubah agent",
        meta: { aksi: "design-patch", halaman: patch.slug, op: patch.op },
      });
      return {
        text: `Berhasil: ${hasil.op} pada ${hasil.selector} di ${hasil.slug}. mtime baru: ${hasil.mtime}.`,
        isError: false,
      };
    } catch (error) {
      if (error instanceof DesignPatchError) return { text: error.message, isError: true };
      // Galat tak dikenal: pesan umum tanpa detail.
      return { text: "Halaman tidak dapat diubah.", isError: true };
    }
  }
}
