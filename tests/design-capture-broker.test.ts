import { describe, expect, test } from "bun:test";
import {
  CaptureBroker,
  CaptureError,
  type CaptureResult,
} from "../src/server/design/capture-broker";

/** PNG minimal yang cukup untuk broker: tanda tangan + IHDR + IEND. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // kedalaman bit
  buf[25] = 2; // truecolor
  buf.writeUInt32BE(0, 29);
  buf.writeUInt32BE(0, 33);
  buf.write("IEND", 37, "latin1");
  return buf;
}

function errorOf(promise: Promise<unknown>): Promise<CaptureError> {
  return promise.then(
    () => {
      throw new Error("seharusnya ditolak");
    },
    (error: unknown) => error as CaptureError,
  );
}

describe("CaptureBroker request/complete", () => {
  test("request tertunda lalu complete memakai dimensi IHDR", async () => {
    const broker = new CaptureBroker();
    broker.touch("s1");
    const janji = broker.request("s1", "home", 2);
    const pending = broker.pending("s1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toMatch(/^k_[0-9a-f]{16}$/);
    expect(pending[0]?.slug).toBe("home");
    expect(pending[0]?.scale).toBe(2);

    const hasil = broker.complete("s1", pending[0]!.id, png(640, 480));
    expect(hasil.width).toBe(640);
    expect(hasil.height).toBe(480);
    const dariRequest: CaptureResult = await janji;
    expect(dariRequest.width).toBe(640);
    expect(dariRequest.height).toBe(480);
    expect(dariRequest.png.length).toBe(45);
    expect(broker.pending("s1")).toEqual([]);
  });

  test("PNG rusak/tanda tangan salah/terlalu kecil menolak permintaan", async () => {
    for (const rusak of [Buffer.alloc(40), Buffer.from("bukan png"), png(0, 10)]) {
      const broker = new CaptureBroker();
      broker.touch("s1");
      const janji = broker.request("s1", "home", 1);
      const id = broker.pending("s1")[0]!.id;
      expect(() => broker.complete("s1", id, rusak)).toThrow(CaptureError);
      const galat = await errorOf(janji);
      expect(galat.reason).toBe("failed");
      expect(galat.message).toBe("Gambar tangkapan tidak valid.");
      expect(broker.pending("s1")).toEqual([]);
    }
  });

  test("PNG melebihi 4 MB ditolak", async () => {
    const broker = new CaptureBroker();
    broker.touch("s1");
    const janji = broker.request("s1", "home", 1);
    const id = broker.pending("s1")[0]!.id;
    const besar = Buffer.concat([png(10, 10), Buffer.alloc(4 * 1024 * 1024)]);
    expect(() => broker.complete("s1", id, besar)).toThrow("Gambar tangkapan tidak valid.");
    expect((await errorOf(janji)).reason).toBe("failed");
  });

  test("id milik sesi lain tidak dikenal", async () => {
    const broker = new CaptureBroker();
    broker.touch("s1");
    const janji = broker.request("s1", "home", 1);
    const id = broker.pending("s1")[0]!.id;
    expect(() => broker.complete("s2", id, png(1, 1))).toThrow("Permintaan tidak ditemukan.");
    broker.complete("s1", id, png(1, 1));
    await janji;
  });
});

describe("CaptureBroker fail dan batas", () => {
  test("fail dengan tiap alasan memakai pesan Indonesia", async () => {
    const kasus = [
      ["tainted", "Browser ini tidak mengizinkan tangkapan layar frame desain."],
      ["too-large", "Halaman terlalu besar untuk ditangkap."],
      ["no-frame", "Frame halaman belum tampil di kanvas."],
      ["failed", "Tangkapan layar gagal."],
    ] as const;
    for (const [alasan, pesan] of kasus) {
      const broker = new CaptureBroker();
      broker.touch("s1");
      const janji = broker.request("s1", "home", 1);
      const id = broker.pending("s1")[0]!.id;
      expect(broker.fail("s1", id, alasan)).toBe(true);
      const galat = await errorOf(janji);
      expect(galat.message).toBe(pesan);
      expect(galat.reason).toBe(alasan);
    }
    const broker = new CaptureBroker();
    expect(broker.fail("s1", "k_tidakada", "failed")).toBe(false);
  });

  test("timeout membuang permintaan dan membersihkan antrean", async () => {
    const broker = new CaptureBroker({ timeoutMs: 30 });
    broker.touch("s1");
    const janji = broker.request("s1", "home", 1);
    expect(broker.pending("s1")).toHaveLength(1);
    const galat = await errorOf(janji);
    expect(galat.reason).toBe("timeout");
    expect(galat.message).toContain("Buka kanvas desain");
    expect(broker.pending("s1")).toEqual([]);
  });

  test("permintaan selesai tidak ditolak lagi setelah timeout", async () => {
    const broker = new CaptureBroker({ timeoutMs: 30 });
    broker.touch("s1");
    let ditolak = false;
    const janji = broker.request("s1", "home", 1);
    janji.catch(() => {
      ditolak = true;
    });
    const id = broker.pending("s1")[0]!.id;
    broker.complete("s1", id, png(2, 3));
    await janji;
    await Bun.sleep(60);
    expect(ditolak).toBe(false);
  });

  test("tanpa touch langsung no-viewer", async () => {
    const broker = new CaptureBroker();
    const galat = await errorOf(broker.request("s1", "home", 1));
    expect(galat.reason).toBe("no-viewer");
    expect(galat.message).toBe("Buka kanvas desain di Jejak agar tangkapan layar tersedia.");
  });

  test("touch kedaluwarsa memakai waktu injeksi", async () => {
    let waktu = 1000;
    const broker = new CaptureBroker({ viewerTtlMs: 5000, now: () => waktu });
    broker.touch("s1");
    waktu = 7000;
    expect((await errorOf(broker.request("s1", "home", 1))).reason).toBe("no-viewer");
    waktu = 9000;
    broker.touch("s1");
    const janji = broker.request("s1", "home", 1);
    broker.complete("s1", broker.pending("s1")[0]!.id, png(1, 1));
    await janji;
  });

  test("maksimal 3 permintaan tertunda per sesi", async () => {
    const broker = new CaptureBroker();
    broker.touch("s1");
    const semua = [1, 2, 3].map(() => broker.request("s1", "home", 1));
    expect((await errorOf(broker.request("s1", "home", 1))).message).toBe(
      "Terlalu banyak tangkapan layar tertunda.",
    );
    expect(broker.pending("s1")).toHaveLength(3);
    for (const item of broker.pending("s1")) broker.fail("s1", item.id, "failed");
    await Promise.all(semua.map((item) => item.catch(() => undefined)));
  });
});
