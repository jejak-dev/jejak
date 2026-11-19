import { describe, expect, test } from "bun:test";
import {
  CANVAS_FILE_NAME,
  EXPORT_MARGIN,
  MAX_EXPORT_SIDE,
  canvasBounds,
  dataUrlToBlob,
  downloadBlob,
  exportFailureMessage,
  exportFileName,
  fitScale,
  placeShots,
  type ExportRect,
} from "../src/client/lib/design-export";

function rect(slug: string, x: number, y: number, width = 100, height = 200): ExportRect {
  return { slug, x, y, width, height };
}

describe("exportFileName", () => {
  test("skala 1 memakai nama polos, skala 2 memakai sufiks @2x", () => {
    expect(exportFileName("beranda", 1)).toBe("beranda.png");
    expect(exportFileName("beranda", 2)).toBe("beranda@2x.png");
  });

  test("karakter tak aman diganti tanda hubung", () => {
    expect(exportFileName("halaman/utama", 1)).toBe("halaman-utama.png");
    expect(exportFileName("", 1)).toBe("halaman.png");
  });
});

describe("canvasBounds", () => {
  test("kotak pembatas melingkupi semua frame dengan margin", () => {
    const bounds = canvasBounds([rect("a", 0, 0), rect("b", 200, 100, 100, 100)], 40);
    expect(bounds).toEqual({ x: -40, y: -40, width: 380, height: 280 });
  });

  test("koordinat negatif tidak bikin kotak kosong", () => {
    const bounds = canvasBounds([rect("a", -500, -300, 100, 100)], 40);
    expect(bounds?.x).toBe(-540);
    expect(bounds?.y).toBe(-340);
    expect(bounds?.width).toBe(180);
    expect(bounds?.height).toBe(180);
  });

  test("daftar kosong tak punya kotak pembatas", () => {
    expect(canvasBounds([], EXPORT_MARGIN)).toBeUndefined();
  });
});

describe("fitScale", () => {
  test("skala 1 bila sisi terpanjang masih di bawah batas", () => {
    expect(fitScale(3040, 980, MAX_EXPORT_SIDE)).toBe(1);
  });

  test("skala turun proporsional saat melebihi batas", () => {
    expect(fitScale(16000, 4000, 8192)).toBeCloseTo(8192 / 16000, 10);
  });

  test("skala tak pernah lebih besar dari 1 dan nilai tak sah kembali ke 1", () => {
    expect(fitScale(100, 100, 8192)).toBe(1);
    expect(fitScale(0, 0, 8192)).toBe(1);
    expect(fitScale(Number.NaN, 10, 8192)).toBe(1);
  });
});

describe("placeShots", () => {
  test("posisi dihitung relatif terhadap kotak pembatas", () => {
    const rects = [rect("a", 0, 0), rect("b", 200, 0)];
    const bounds = canvasBounds(rects, 0);
    expect(bounds).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    const tempat = placeShots(rects, bounds!, 2);
    expect(tempat[0]).toEqual({ slug: "a", x: 0, y: 0, width: 200, height: 400 });
    expect(tempat[1]).toEqual({ slug: "b", x: 400, y: 0, width: 200, height: 400 });
  });

  test("daftar kosong tak menghasilkan penempatan", () => {
    const bounds = canvasBounds([rect("a", 0, 0)], 0);
    expect(placeShots([], bounds!, 1)).toEqual([]);
  });
});

describe("dataUrlToBlob", () => {
  test("data URL PNG jadi blob bertipe image/png", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,aGVsbG8=");
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("hello");
  });
});

describe("downloadBlob", () => {
  test("membuat tautan unduh dengan nama berkas lalu mencabut URL", async () => {
    const diklik: Array<{ href: string; download: string }> = [];
    const tautan = {
      href: "",
      download: "",
      rel: "",
      click(): void {
        diklik.push({ href: this.href, download: this.download });
      },
      remove(): void {
        // tak ada yang perlu dibuang di dokumen palsu
      },
    };
    const doc = {
      createElement: () => tautan,
      body: { appendChild: () => undefined },
    } as unknown as Document;

    const urlAsli = URL.createObjectURL;
    const revokeAsli = URL.revokeObjectURL;
    const dicabut: string[] = [];
    URL.createObjectURL = (() => "blob:uji") as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      dicabut.push(url);
    }) as typeof URL.revokeObjectURL;
    try {
      downloadBlob(new Blob([new Uint8Array([1, 2, 3])]), "beranda.png", doc);
      expect(diklik).toHaveLength(1);
      expect(diklik[0]?.download).toBe("beranda.png");
      expect(diklik[0]?.href).toBe("blob:uji");
      // URL objek dicabut sesudahnya, tak sebelum unduhan mulai.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(dicabut).toEqual(["blob:uji"]);
    } finally {
      URL.createObjectURL = urlAsli;
      URL.revokeObjectURL = revokeAsli;
    }
  });
});

describe("exportFailureMessage", () => {
  test("setiap alasan punya pesan Bahasa Indonesia", () => {
    expect(exportFailureMessage("tainted")).toContain("Browser");
    expect(exportFailureMessage("too-large")).toContain("terlalu besar");
    expect(exportFailureMessage("no-frame")).toContain("kanvas");
    expect(exportFailureMessage("failed")).toContain("gagal");
    expect(exportFailureMessage("timeout")).toContain("Waktu");
  });
});

describe("nama berkas kanvas", () => {
  test("nama berkas tetap", () => {
    expect(CANVAS_FILE_NAME).toBe("kanvas-desain.png");
  });
});
