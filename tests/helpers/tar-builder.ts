/**
 * Penulis tar kecil untuk pengujian ekstraksi SDK.
 *
 * Hanya untuk tes: membangun arsip ustar sintetis supaya entri jahat
 * (symlink, `..`, jalur absolut, header rusak) bisa disisipkan.
 */

const BLOCK_SIZE = 512;

export interface TarInput {
  path: string;
  type?: "file" | "dir" | "symlink" | "hardlink" | "other" | "pax";
  data?: string | Uint8Array;
  linkname?: string;
  mode?: number;
  /** Field size di header dibuat berbeda dari panjang data (untuk menguji pemotongan). */
  headerSize?: number;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeText(block: Uint8Array, text: string, offset: number, length: number): void {
  const bytes = encode(text);
  const limit = Math.min(bytes.length, length - 1);
  block.set(bytes.subarray(0, limit), offset);
}

function modeField(mode: number): string {
  return `${mode.toString(8).padStart(6, "0")}\0 `;
}

function numericField(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function checksumOf(block: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum;
}

function headerBlock(entry: TarInput, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const type = entry.type ?? "file";
  const flag =
    type === "file"
      ? "0"
      : type === "dir"
        ? "5"
        : type === "symlink"
          ? "2"
          : type === "hardlink"
            ? "1"
            : type === "pax"
              ? "x"
              : "3";

  writeText(block, entry.path, 0, 100);
  writeText(block, modeField(entry.mode ?? 0o644), 100, 8);
  writeText(block, modeField(0), 108, 8);
  writeText(block, modeField(0), 116, 8);
  writeText(block, numericField(entry.headerSize ?? size, 12), 124, 12);
  writeText(block, numericField(0, 12), 136, 12);
  block[156] = flag.charCodeAt(0);
  writeText(block, entry.linkname ?? "", 157, 100);
  // Sisa field tetap nol, jadi magic menjadi "ustar\0".
  writeText(block, "ustar ", 257, 6);
  writeText(block, "00", 263, 2);
  writeText(block, "jejak", 265, 32);
  writeText(block, "jejak", 297, 32);
  writeText(block, numericField(0, 8), 329, 8);
  writeText(block, numericField(0, 8), 337, 8);

  const sum = checksumOf(block);
  writeText(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** Membangun arsip tar lengkap dengan dua blok penutup nol. */
export function buildTar(entries: TarInput[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const raw = entry.data ?? "";
    const data = typeof raw === "string" ? encode(raw) : raw;
    const size =
      entry.type === "file" || entry.type === "pax" || entry.type === undefined
        ? data.length
        : 0;
    blocks.push(headerBlock(entry, size));
    if (size > 0) {
      const padded = new Uint8Array(Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE);
      padded.set(data);
      blocks.push(padded);
    }
  }

  blocks.push(new Uint8Array(BLOCK_SIZE));
  blocks.push(new Uint8Array(BLOCK_SIZE));

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.length;
  }
  return output;
}

/** Menggzip byte; dipakai untuk tarball sintetis. */
export function gzipOf(bytes: Uint8Array): Uint8Array {
  return Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>);
}

/** Satu catatan pax: "<panjang> kunci=nilai\n". */
export function paxRecord(key: string, value: string): string {
  let length = key.length + value.length + 3;
  for (;;) {
    const text = `${length} ${key}=${value}\n`;
    if (text.length === length) return text;
    length = text.length;
  }
}

/** Isi package.json yang sah untuk pengujian. */
export function packageJsonContent(name: string, version: string): string {
  return `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`;
}

/** Entri paket baku: package.json dan sdk.mjs. */
export function packageEntries(
  name: string,
  version: string,
  extra: TarInput[] = [],
): TarInput[] {
  return [
    { path: "package/", type: "dir" },
    { path: "package/package.json", data: packageJsonContent(name, version) },
    { path: "package/sdk.mjs", data: "export const query = () => {};\n" },
    ...extra,
  ];
}
