import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import type { ApiClient } from "../src/client/lib/api";
import { NetworkSettings } from "../src/client/components/NetworkSettings";
import type { NetworkStatus } from "../src/client/lib/network-form";
import { toggleQrUrl } from "../src/client/lib/network-form";
import {
  encodeQr,
  encodeQrDetailed,
  qrSize,
  readFormatInfo,
  readVersionInfo,
  reedSolomonDivide,
  reedSolomonRemainder,
} from "../src/client/lib/qr";
import {
  findAll,
  fire,
  flushEffects,
  installDom,
  mount,
  type FakeNode,
} from "./helpers/dom";

/* ---------- Encoder ---------- */

describe("penulis kode QR", () => {
  test("ukuran matriks mengikuti versi terkecil yang cukup", () => {
    const kasus: [number, number][] = [
      [14, 21],
      [15, 25],
      [26, 25],
      [27, 29],
      [42, 29],
      [43, 33],
      [62, 33],
      [63, 37],
      [84, 37],
      [85, 41],
      [106, 41],
      [107, 45],
      [122, 45],
      [123, 49],
      [152, 49],
      [153, 53],
      [180, 53],
      [181, 57],
      [213, 57],
    ];
    for (const [byte, sisi] of kasus) {
      const modules = encodeQr("a".repeat(byte));
      expect(modules.length).toBe(sisi);
      expect(modules[0]?.length).toBe(sisi);
      expect(qrSize((sisi - 17) / 4)).toBe(sisi);
    }
  });

  test("teks di luar kapasitas melempar galat", () => {
    expect(() => encodeQr("a".repeat(214))).toThrow(
      "Teks terlalu panjang untuk kode QR.",
    );
  });

  test("tiga pola pencari berada di tiga sudut", () => {
    const modules = encodeQr("http://192.168.1.5:4747");
    const size = modules.length;
    const benar = (top: number, left: number): boolean => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const jarak = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          const gelap = jarak !== 2;
          if ((modules[top + dy]?.[left + dx] ?? false) !== gelap) return false;
        }
      }
      return true;
    };
    expect(benar(0, 0)).toBe(true);
    expect(benar(0, size - 7)).toBe(true);
    expect(benar(size - 7, 0)).toBe(true);
    // Pemisah di sekeliling pola searching tetap putih.
    expect(modules[7]?.[0]).toBe(false);
    expect(modules[7]?.[size - 8]).toBe(false);
    expect(modules[size - 8]?.[0]).toBe(false);
  });

  test("timing pattern bolak-balik", () => {
    const modules = encodeQr("https://contoh.example.com/jejak");
    const size = modules.length;
    for (let col = 8; col <= size - 9; col++) {
      expect(modules[6]?.[col]).toBe(col % 2 === 0);
    }
    for (let row = 8; row <= size - 9; row++) {
      expect(modules[row]?.[6]).toBe(row % 2 === 0);
    }
  });

  test("modul gelap tetap berada di kolom 8 baris 4v+9", () => {
    for (const byte of [14, 40, 100, 180, 213]) {
      const hasil = encodeQrDetailed("a".repeat(byte));
      const baris = 4 * hasil.version + 9;
      expect(hasil.modules[baris]?.[8]).toBe(true);
    }
  });

  test("info format pada dua salinan sama dan BCH-nya sah", () => {
    const hasil = encodeQrDetailed("http://10.0.0.3:4747");
    const info = readFormatInfo(hasil.modules);
    expect(info).toBeDefined();
    expect(info?.first).toBe(info?.second);
    expect(info?.errorCorrection).toBe(0); // tingkat M
    expect(info?.mask).toBe(hasil.mask);
  });

  test("info format rusak ditolak", () => {
    const hasil = encodeQrDetailed("http://10.0.0.3:4747");
    const rusak = hasil.modules.map((row) => row.slice());
    const baris = rusak[8]!;
    baris[8] = !baris[8];
    expect(readFormatInfo(rusak)).toBeUndefined();
  });

  test("info versi BCH(18,6) sah untuk versi 7 ke atas", () => {
    expect(readVersionInfo(encodeQrDetailed("a".repeat(122)).modules)).toBe(7);
    expect(readVersionInfo(encodeQrDetailed("a".repeat(152)).modules)).toBe(8);
    expect(readVersionInfo(encodeQrDetailed("a".repeat(180)).modules)).toBe(9);
    expect(readVersionInfo(encodeQrDetailed("a".repeat(213)).modules)).toBe(10);
    // Versi di bawah 7 tak memakai info versi.
    expect(readVersionInfo(encodeQrDetailed("a".repeat(14)).modules)).toBeUndefined();
  });

  test("pembagi generator memberi sisa nol untuk data plus ECC", () => {
    const data = [
      0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6,
      0xc6, 0x96, 0x70, 0xec,
    ];
    const ecc = reedSolomonRemainder(data, 10);
    expect(ecc.length).toBe(10);
    const sisa = reedSolomonDivide([...data, ...ecc], 10);
    expect(sisa.length).toBe(10);
    expect(sisa.every((nilai) => nilai === 0)).toBe(true);
  });

  test("hasil penulisan deterministik", () => {
    const teks = "https://contoh.example.com/jejak?token=abc";
    expect(encodeQr(teks)).toEqual(encodeQr(teks));
  });
});

/* ---------- Komponen pengaturan jaringan ---------- */

describe("buka-tutup kode QR", () => {
  test("satu kode terbuka sekali dan tombol yang sama menutupnya", () => {
    expect(toggleQrUrl(undefined, "http://a")).toBe("http://a");
    expect(toggleQrUrl("http://a", "http://a")).toBeUndefined();
    expect(toggleQrUrl("http://a", "http://b")).toBe("http://b");
  });
});

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

function status(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    enabled: false,
    port: 4747,
    listening: false,
    urls: [],
    passwordRequired: false,
    ...overrides,
  };
}

function apiDengan(statusAkhir: NetworkStatus): ApiClient {
  return {
    getNetworkStatus: async () => statusAkhir,
  } as unknown as ApiClient;
}

/** Tunggu sampai tombol QR muncul (status dimuat async; 60 ms tetap tidak cukup di CI lambat). */
async function tungguTombolQr(root: FakeNode, jumlah: number): Promise<void> {
  for (let i = 0; i < 100 && tombolQr(root).length < jumlah; i += 1) {
    await flushEffects();
  }
}

function tombolQr(root: FakeNode): FakeNode[] {
  return findAll(
    root,
    (node) =>
      (node.getAttribute("aria-label") ?? "").startsWith(
        "Tampilkan kode QR untuk ",
      ),
  );
}

function svgQr(root: FakeNode): FakeNode[] {
  return findAll(
    root,
    (node) => node.localName === "svg" && node.getAttribute("role") === "img",
  );
}

describe("kode QR di pengaturan akses jaringan", () => {
  test("tombol QR muncul untuk tiap alamat", async () => {
    const root = mount(
      h(NetworkSettings, {
        api: apiDengan(
          status({
            enabled: true,
            listening: true,
            urls: ["http://192.168.1.5:4747", "http://10.0.0.3:4747"],
          }),
        ),
      }),
    );
    await tungguTombolQr(root, 2);
    const tombol = tombolQr(root);
    expect(tombol.length).toBe(2);
    expect(tombol[0]?.getAttribute("aria-label")).toBe(
      "Tampilkan kode QR untuk http://192.168.1.5:4747",
    );
    expect(tombol[1]?.getAttribute("aria-label")).toBe(
      "Tampilkan kode QR untuk http://10.0.0.3:4747",
    );
    expect(svgQr(root).length).toBe(0);
  });

  test("tanpa alamat tak ada tombol QR", async () => {
    const root = mount(
      h(NetworkSettings, { api: apiDengan(status({ listening: true })) }),
    );
    await flushEffects();
    expect(tombolQr(root).length).toBe(0);
  });

  test("klik membuka kode QR dan klik lagi menutupnya", async () => {
    const url = "http://192.168.1.5:4747";
    const root = mount(
      h(NetworkSettings, {
        api: apiDengan(
          status({ enabled: true, listening: true, urls: [url] }),
        ),
      }),
    );
    await flushEffects();

    await tungguTombolQr(root, 1);
    const tombol = tombolQr(root)[0]!;
    fire(tombol, "click");
    await flushEffects();
    const svg = svgQr(root);
    expect(svg.length).toBe(1);
    expect(svg[0]?.getAttribute("aria-label")).toBe(`Kode QR untuk ${url}`);

    fire(tombol, "click");
    await flushEffects();
    expect(svgQr(root).length).toBe(0);
  });

  test("hanya satu kode yang terbuka sekali", async () => {
    const urls = ["http://192.168.1.5:4747", "http://10.0.0.3:4747"];
    const root = mount(
      h(NetworkSettings, {
        api: apiDengan(status({ enabled: true, listening: true, urls })),
      }),
    );
    await flushEffects();

    await tungguTombolQr(root, 2);
    const tombol = tombolQr(root);
    fire(tombol[0]!, "click");
    await flushEffects();
    expect(svgQr(root).length).toBe(1);
    expect(svgQr(root)[0]?.getAttribute("aria-label")).toBe(
      `Kode QR untuk ${urls[0]}`,
    );

    fire(tombol[1]!, "click");
    await flushEffects();
    expect(svgQr(root).length).toBe(1);
    expect(svgQr(root)[0]?.getAttribute("aria-label")).toBe(
      `Kode QR untuk ${urls[1]}`,
    );
  });

  test("catatan pindai tampil di bawah kode", async () => {
    const root = mount(
      h(NetworkSettings, {
        api: apiDengan(
          status({
            enabled: true,
            listening: true,
            urls: ["http://192.168.1.5:4747"],
          }),
        ),
      }),
    );
    await tungguTombolQr(root, 1);
    fire(tombolQr(root)[0]!, "click");
    await flushEffects();
    expect(root.textContent).toContain("Pindai dari HP di jaringan yang sama.");
  });
});
