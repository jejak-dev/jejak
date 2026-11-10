import { describe, expect, test } from "bun:test";
import {
  MAX_ATTACHMENTS,
  appendAttachments,
  attachmentUrl,
  formatSize,
  pastedName,
  rejectReason,
  splitAttachments,
  type Attachment,
} from "../src/client/lib/attachments";

const att = (name: string, id = "0123456789ab"): Attachment => ({
  id,
  name,
  path: `/home/u/.jejak/attachments/${id}/${name}`,
  size: 10,
  image: /\.png$/.test(name),
});

describe("appendAttachments / splitAttachments", () => {
  test("bolak-balik", () => {
    const text = appendAttachments("  Lihat ini  ", [att("a.png"), att("b.txt", "ba9876543210")]);
    expect(text).toContain("\n\nLampiran:\n- /home/u/.jejak/attachments/0123456789ab/a.png");
    const parsed = splitAttachments(text);
    expect(parsed.body).toBe("Lihat ini");
    expect(parsed.files.map((f) => [f.name, f.image])).toEqual([
      ["a.png", true],
      ["b.txt", false],
    ]);
  });

  test("teks kosong diberi kalimat bawaan; tanpa lampiran tak berubah", () => {
    expect(appendAttachments("", [att("a.png")]).startsWith("Perhatikan lampiran berikut.")).toBe(true);
    expect(appendAttachments(" halo ", [])).toBe("halo");
  });

  test("blok yang bukan lampiran sah dibiarkan apa adanya", () => {
    const fake = "Daftar\n\nLampiran:\n- bukan/path/valid.txt";
    expect(splitAttachments(fake)).toEqual({ body: fake, files: [] });
    expect(splitAttachments("polos")).toEqual({ body: "polos", files: [] });
    const mixed = "x\n\nLampiran:\n- /a/0123456789ab/c.png\nbaris lain";
    expect(splitAttachments(mixed).files).toEqual([]);
  });
});

describe("util lampiran", () => {
  test("url di-encode", () => {
    expect(attachmentUrl({ id: "0123456789ab", name: "foto saya.png" })).toBe(
      "/api/attachments/0123456789ab/foto%20saya.png",
    );
  });

  test("ukuran", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });

  test("nama gambar tempel", () => {
    const now = new Date("2026-11-11T10:20:30.000Z");
    expect(pastedName({ name: "image.png", type: "image/png" }, now)).toBe("tempel-20261111-102030.png");
    expect(pastedName({ name: "", type: "image/jpeg" }, now)).toBe("tempel-20261111-102030.jpg");
    expect(pastedName({ name: "foto.webp", type: "image/webp" }, now)).toBe("foto.webp");
  });

  test("penolakan di klien", () => {
    expect(rejectReason({ name: "a", size: 5 }, 0)).toBeUndefined();
    expect(rejectReason({ name: "a", size: 5 }, MAX_ATTACHMENTS)).toContain("Maksimal");
    expect(rejectReason({ name: "a", size: 0 }, 0)).toContain("kosong");
    expect(rejectReason({ name: "a", size: 9 * 1024 * 1024 }, 0)).toContain("terlalu besar");
  });
});
