import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { MAX_PAGE_BYTES, SLUG_RE, resolveDesignDir } from "./manifest";

export type PatchOp = "replace" | "inner" | "text" | "attr" | "remove" | "before" | "after";

export interface PatchInput {
  slug: string;
  selector: string;
  op: PatchOp;
  value?: string;
  attr?: string;
  baseMtime?: number;
}

/** Galat tambal halaman desain dengan status HTTP yang sesuai. */
export class DesignPatchError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "DesignPatchError";
  }
}

const OPS: readonly PatchOp[] = ["replace", "inner", "text", "attr", "remove", "before", "after"];
const VALUE_OPS = new Set<PatchOp>(["replace", "inner", "text", "before", "after"]);
const MAX_SELECTOR_LENGTH = 500;
const MAX_VALUE_BYTES = 64 * 1024;
const ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const URL_ATTRS = new Set(["href", "src", "action", "formaction"]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NOT_FOUND = "Halaman tidak ditemukan.";
const TOO_LARGE = "Halaman melebihi 512 KB.";
const INVALID_SELECTOR = "Selector tidak valid.";

interface ValidatedPatch {
  slug: string;
  selector: string;
  op: PatchOp;
  value?: string;
  attr?: string;
  baseMtime?: number;
}

function isOp(value: unknown): value is PatchOp {
  return typeof value === "string" && (OPS as readonly string[]).includes(value);
}

/** Menormalkan nilai URL untuk memeriksa skema berbahaya. */
function normalizedUrl(value: string): string {
  return value.toLowerCase().replace(/[\s\u0000-\u001f\u007f]/g, "");
}

function validateInput(input: PatchInput): ValidatedPatch {
  if (typeof input.slug !== "string" || !SLUG_RE.test(input.slug)) {
    throw new DesignPatchError("Slug halaman tidak valid.", 400);
  }
  const selector = input.selector;
  if (
    typeof selector !== "string" ||
    selector.trim() === "" ||
    selector.length > MAX_SELECTOR_LENGTH ||
    CONTROL_RE.test(selector)
  ) {
    throw new DesignPatchError(INVALID_SELECTOR, 400);
  }
  if (!isOp(input.op)) {
    throw new DesignPatchError("Op tidak dikenal.", 400);
  }
  const op = input.op;

  let value: string | undefined;
  if (VALUE_OPS.has(op)) {
    if (typeof input.value !== "string") {
      throw new DesignPatchError("Isi wajib diisi.", 400);
    }
    if (Buffer.byteLength(input.value, "utf8") > MAX_VALUE_BYTES) {
      throw new DesignPatchError("Isi terlalu besar.", 413);
    }
    value = input.value;
  }

  let attr: string | undefined;
  if (op === "attr") {
    if (typeof input.attr !== "string" || !ATTR_RE.test(input.attr)) {
      throw new DesignPatchError("Nama atribut tidak valid.", 400);
    }
    const name = input.attr;
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || lower === "srcdoc") {
      throw new DesignPatchError(`Atribut "${name}" tidak diizinkan.`, 400);
    }
    attr = name;
    if (input.value !== undefined) {
      if (typeof input.value !== "string") {
        throw new DesignPatchError("Isi wajib berupa teks.", 400);
      }
      if (Buffer.byteLength(input.value, "utf8") > MAX_VALUE_BYTES) {
        throw new DesignPatchError("Isi terlalu besar.", 413);
      }
      value = input.value;
      if (value !== "" && URL_ATTRS.has(lower)) {
        const url = normalizedUrl(value);
        if (url.startsWith("javascript:") || url.startsWith("data:text/html")) {
          throw new DesignPatchError(`Nilai atribut "${name}" tidak diizinkan.`, 400);
        }
      }
    }
  }

  let baseMtime: number | undefined;
  if (input.baseMtime !== undefined) {
    if (typeof input.baseMtime !== "number" || !Number.isFinite(input.baseMtime)) {
      throw new DesignPatchError("baseMtime harus berupa bilangan.", 400);
    }
    baseMtime = input.baseMtime;
  }

  return { slug: input.slug, selector, op, value, attr, baseMtime };
}

interface PageTarget {
  pagePath: string;
  mode: number;
  size: number;
  mtime: number;
}

/** Memastikan halaman ada, berkas biasa, dan realpath-nya di dalam `design/`. */
async function resolvePage(root: string, slug: string): Promise<PageTarget> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignPatchError(NOT_FOUND, 404);
  }
  const pagePath = join(designDir, "pages", `${slug}.html`);
  let info;
  try {
    info = await lstat(pagePath);
  } catch {
    throw new DesignPatchError(NOT_FOUND, 404);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DesignPatchError(NOT_FOUND, 404);
  }
  let real: string;
  try {
    real = await realpath(pagePath);
  } catch {
    throw new DesignPatchError(NOT_FOUND, 404);
  }
  if (real !== pagePath && !real.startsWith(designDir + sep)) {
    throw new DesignPatchError(NOT_FOUND, 404);
  }
  if (info.size > MAX_PAGE_BYTES) {
    throw new DesignPatchError(TOO_LARGE, 413);
  }
  return { pagePath, mode: info.mode & 0o777, size: info.size, mtime: Math.round(info.mtimeMs) };
}

function countMatches(html: string, selector: string): number {
  let count = 0;
  try {
    new HTMLRewriter()
      .on(selector, {
        element() {
          count += 1;
        },
      })
      .transform(html);
  } catch {
    throw new DesignPatchError(INVALID_SELECTOR, 400);
  }
  return count;
}

function isVoid(element: HTMLRewriterTypes.Element): boolean {
  return element.selfClosing || VOID_TAGS.has(element.tagName.toLowerCase());
}

function applyOp(element: HTMLRewriterTypes.Element, patch: ValidatedPatch): void {
  switch (patch.op) {
    case "replace":
      element.replace(patch.value ?? "", { html: true });
      return;
    case "inner":
    case "text": {
      if (isVoid(element)) {
        throw new DesignPatchError(
          `Elemen <${element.tagName.toLowerCase()}> tidak mendukung op ${patch.op}.`,
          400,
        );
      }
      element.setInnerContent(patch.value ?? "", { html: patch.op === "inner" });
      return;
    }
    case "attr": {
      const name = patch.attr ?? "";
      if (patch.value === undefined || patch.value === "") {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, patch.value);
      }
      return;
    }
    case "remove":
      element.remove();
      return;
    case "before":
      element.before(patch.value ?? "", { html: true });
      return;
    case "after":
      element.after(patch.value ?? "", { html: true });
      return;
  }
}

function applyPatch(html: string, patch: ValidatedPatch): string {
  try {
    return new HTMLRewriter()
      .on(patch.selector, {
        element(element) {
          applyOp(element, patch);
        },
      })
      .transform(html);
  } catch (error) {
    if (error instanceof DesignPatchError) throw error;
    throw new DesignPatchError(INVALID_SELECTOR, 400);
  }
}

/**
 * Menambal satu elemen pada `design/pages/<slug>.html` memakai `HTMLRewriter`.
 * Selector harus cocok tepat satu elemen; bagian dokumen lain tetap utuh.
 * Penulisan atomik lewat berkas sementara di folder yang sama, mode lama
 * dipertahankan, dan mtime baru dikembalikan (dibulatkan).
 */
export async function patchPage(
  root: string,
  input: PatchInput,
): Promise<{ slug: string; selector: string; op: PatchOp; mtime: number }> {
  const patch = validateInput(input);
  const target = await resolvePage(root, patch.slug);

  if (patch.baseMtime !== undefined && patch.baseMtime !== target.mtime) {
    throw new DesignPatchError("Halaman berubah sejak dibaca; ambil selector baru.", 409);
  }

  let html: string;
  try {
    html = await readFile(target.pagePath, "utf8");
  } catch {
    throw new DesignPatchError(NOT_FOUND, 404);
  }

  const matches = countMatches(html, patch.selector);
  if (matches === 0) {
    throw new DesignPatchError("Selector tidak cocok dengan elemen mana pun.", 404);
  }
  if (matches > 1) {
    throw new DesignPatchError(
      `Selector cocok dengan ${matches} elemen; pakai selector yang lebih spesifik (mis. [id="..."]).`,
      409,
    );
  }

  const output = applyPatch(html, patch);
  if (Buffer.byteLength(output, "utf8") > MAX_PAGE_BYTES) {
    throw new DesignPatchError(TOO_LARGE, 413);
  }

  const tempPath = join(dirname(target.pagePath), `.jejak-patch-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, output, { mode: target.mode });
    // mode pada writeFile tunduk pada umask; chmod memastikan mode lama utuh.
    await chmod(tempPath, target.mode);
    await rename(tempPath, target.pagePath);
  } catch {
    await rm(tempPath, { force: true });
    throw new DesignPatchError("Halaman tidak dapat disimpan.", 400);
  }

  const after = await lstat(target.pagePath);
  return {
    slug: patch.slug,
    selector: patch.selector,
    op: patch.op,
    mtime: Math.round(after.mtimeMs),
  };
}
