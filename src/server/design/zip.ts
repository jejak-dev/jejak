import { deflateRawSync } from "node:zlib";

/** Galat saat menyusun arsip ZIP (nama tak sah, arsip terlalu besar). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Satu berkas yang akan dimasukkan ke arsip. */
export interface ZipEntry {
  /** Path relatif di dalam arsip, memakai pemisah "/". */
  name: string;
  data: Uint8Array;
}

/** Batas arsip; tanpa dukungan ZIP64 sehingga batasnya tetap. */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Stempel waktu DOS tetap (1 Januari 1980) agar keluaran deterministik. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Flag umum: bit 11 berarti nama berkas memakai UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Karakter kontrol yang dilarang di nama entri. */
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/** Tabel CRC-32 (polinomial IEEE) dihitung sekali saat modul dimuat. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) dari satu byte; sama dengan yang dipakai utilitas zip. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const index = (crc ^ data[i]!) & 0xff;
    crc = (CRC_TABLE[index]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Menolak nama entri yang bisa keluar dari folder arsip: nama mutlak,
 * segmen "..", garis miring terbalik, dan karakter kontrol.
 */
function validateName(name: string): void {
  if (name.length === 0) throw new ZipError("Nama entri ZIP tidak boleh kosong.");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`Nama entri ZIP tidak sah: "${name}".`);
  }
  if (name.includes("..")) {
    throw new ZipError(`Nama entri ZIP tidak sah: "${name}".`);
  }
  if (name.includes("\\")) {
    throw new ZipError(`Nama entri ZIP tidak sah: "${name}".`);
  }
  if (CONTROL_RE.test(name)) {
    throw new ZipError(`Nama entri ZIP tidak sah: "${name}".`);
  }
}

/** Menulis satu integer kecil ke dalam buffer pada offset tertentu. */
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

/** Menulis satu integer 32-bit ke dalam buffer pada offset tertentu. */
function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/**
 * Menyusun arsip ZIP dari daftar entri. Metode DEFLATE dipakai bila hasilnya
 * lebih kecil daripada data asal, selain itu STORE. Stempel waktu tetap
 * sehingga dua pemanggilan dengan isi sama menghasilkan byte identik.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError(`Arsip melebihi batas ${MAX_ENTRIES} entri.`);
  }
  let total = 0;
  for (const entry of entries) total += entry.data.length;
  if (total > MAX_TOTAL_BYTES) {
    throw new ZipError("Arsip melebihi batas 64 MB.");
  }

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    validateName(entry.name);
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    let method = METHOD_STORE;
    let payload = entry.data;
    if (entry.data.length > 0) {
      const deflated = new Uint8Array(deflateRawSync(Buffer.from(entry.data)));
      if (deflated.length < entry.data.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, FLAG_UTF8);
    writeU16(localView, 8, method);
    writeU16(localView, 10, DOS_TIME);
    writeU16(localView, 12, DOS_DATE);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, payload.length);
    writeU32(localView, 22, entry.data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(nameBytes, 30);
    parts.push(local, payload);

    const directory = new Uint8Array(46 + nameBytes.length);
    const directoryView = new DataView(directory.buffer);
    writeU32(directoryView, 0, 0x02014b50);
    writeU16(directoryView, 4, 20);
    writeU16(directoryView, 6, 20);
    writeU16(directoryView, 8, FLAG_UTF8);
    writeU16(directoryView, 10, method);
    writeU16(directoryView, 12, DOS_TIME);
    writeU16(directoryView, 14, DOS_DATE);
    writeU32(directoryView, 16, checksum);
    writeU32(directoryView, 20, payload.length);
    writeU32(directoryView, 24, entry.data.length);
    writeU16(directoryView, 28, nameBytes.length);
    writeU16(directoryView, 30, 0);
    writeU16(directoryView, 32, 0);
    writeU16(directoryView, 34, 0);
    writeU16(directoryView, 36, 0);
    writeU32(directoryView, 38, 0);
    writeU32(directoryView, 42, offset);
    directory.set(nameBytes, 46);
    central.push(directory);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);
  writeU16(endView, 20, 0);
  parts.push(...central, end);

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}
