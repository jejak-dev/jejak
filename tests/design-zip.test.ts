import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { buildZip, crc32, type ZipEntry } from "../src/server/design/zip";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-zip-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

/**
 * Pembaca arsip kecil untuk uji: cari EOCD, telusuri central directory,
 * lalu kembalikan isi tiap entri (.inflate bila method 8).
 */
function parseZip(archive: Uint8Array): ParsedEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("EOCD tidak ditemukan");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Header pusat rusak");
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Header lokal rusak");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : raw;
    entries.push({ name, method, crc, data });
  }
  return entries;
}

function entry(name: string, text: string): ZipEntry {
  return { name, data: new TextEncoder().encode(text) };
}

describe("buildZip", () => {
  test("arsip bisa dibaca ulang dan isinya sama persis", () => {
    const isi = [
      entry("halo.txt", "Halo dunia"),
      entry("pages/beranda.html", "<html><body>Beranda</body></html>"),
      entry("assets/gambar.bin", String.fromCharCode(...new Array(256).keys())),
    ];
    const archive = buildZip(isi);
    const parsed = parseZip(archive);
    expect(parsed.map((item) => item.name)).toEqual([
      "halo.txt",
      "pages/beranda.html",
      "assets/gambar.bin",
    ]);
    for (let i = 0; i < isi.length; i += 1) {
      expect(parsed[i]!.data).toEqual(isi[i]!.data);
      expect(parsed[i]!.crc).toBe(crc32(isi[i]!.data));
    }
  });

  test("nama UTF-8 memakai flag bit 11", () => {
    const archive = buildZip([entry("nama-bahasa-международный.txt", "isi")]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(parseZip(archive)[0]!.name).toBe("nama-bahasa-международный.txt");
  });

  test("isi besar dikompres, isi kecil disimpan apa adanya", () => {
    const panjang = "a".repeat(2000);
    const parsed = parseZip(buildZip([entry("besar.txt", panjang)]));
    expect(parsed[0]!.method).toBe(8);
    expect(new TextDecoder().decode(parsed[0]!.data)).toBe(panjang);
  });

  test("dua pemanggilan menghasilkan byte identik", () => {
    const isi = [entry("a.txt", "sama"), entry("b/c.txt", "juga sama")];
    const pertama = buildZip(isi);
    const kedua = buildZip(isi);
    expect(new Uint8Array(pertama)).toEqual(new Uint8Array(kedua));
  });

  test("nama berbahaya ditolak", () => {
    const nama = ["/mutlak.txt", "C:/windows.txt", "../luar.txt", "a/../b.txt", "a\\b.txt", "a\u0001b.txt", ""];
    for (const name of nama) {
      expect(() => buildZip([entry(name, "isi")])).toThrow();
    }
  });

  test("arsip dibaca juga oleh unzip bila tersedia", async () => {
    if (Bun.which("unzip") === null) return;
    const archive = buildZip([entry("halo.txt", "Halo dunia")]);
    const path = join(dir, "arsip.zip");
    await writeFile(path, archive);
    const uji = Bun.spawn(["unzip", "-t", path], { stdout: "pipe", stderr: "pipe" });
    const kodeUji = await uji.exited;
    expect(kodeUji).toBe(0);
    const baca = Bun.spawn(["unzip", "-p", path, "halo.txt"], { stdout: "pipe", stderr: "pipe" });
    const isi = await new Response(baca.stdout).text();
    expect(await baca.exited).toBe(0);
    expect(isi).toBe("Halo dunia");
  });
});
