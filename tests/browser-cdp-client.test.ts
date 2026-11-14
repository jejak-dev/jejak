import { describe, expect, test } from "bun:test";
import { BrowserError } from "../src/server/browser/browser-error";
import { CdpClient, type CdpTransport } from "../src/server/browser/cdp-client";

/** Transport palsu: pesan masuk disuntik manual tanpa Chrome. */
class TransportPalsu implements CdpTransport {
  readonly terkirim: string[] = [];
  tertutup = false;
  private readonly penerima: Array<(data: string) => void> = [];
  private readonly penutup: Array<() => void> = [];

  send(data: string): void {
    this.terkirim.push(data);
  }

  close(): void {
    this.tertutup = true;
  }

  setMessageHandler(handler: (data: string) => void): void {
    this.penerima.push(handler);
  }

  setCloseHandler(handler: () => void): void {
    this.penutup.push(handler);
  }

  /** Kirim pesan mentah ke klien. */
  masuk(data: string): void {
    for (const handler of this.penerima) handler(data);
  }

  /** Tutup soket dari sisi server. */
  tutup(): void {
    for (const handler of this.penutup) handler();
  }
}

function klien(transport: TransportPalsu, timeoutMs?: number): CdpClient {
  return new CdpClient(transport, timeoutMs === undefined ? {} : { timeoutMs });
}

describe("CdpClient", () => {
  test("menghubungkan jawaban dengan id yang benar", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const hasil = client.send("Target.getTargets");
    expect(transport.terkirim).toHaveLength(1);
    const pesan = JSON.parse(transport.terkirim[0] ?? "{}") as { id: number; method: string };
    expect(pesan.method).toBe("Target.getTargets");
    expect(pesan.id).toBe(1);

    transport.masuk(JSON.stringify({ id: pesan.id, result: { targetInfos: [] } }));
    expect(await hasil).toEqual({ targetInfos: [] });

    const kedua = client.send("Page.enable");
    const pesanKedua = JSON.parse(transport.terkirim[1] ?? "{}") as { id: number };
    expect(pesanKedua.id).toBe(2);
    transport.masuk(JSON.stringify({ id: pesanKedua.id, result: {} }));
    await kedua;
  });

  test("sessionId ikut dikirim pada perintah sesi", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const hasil = client.send("Page.enable", undefined, "S1");
    const pesan = JSON.parse(transport.terkirim[0] ?? "{}") as { sessionId?: string; id: number };
    expect(pesan.sessionId).toBe("S1");
    // Jawab supaya tidak ada janji menggantung yang menolak di tes lain.
    transport.masuk(JSON.stringify({ id: pesan.id, result: {}, sessionId: "S1" }));
    await hasil;
  });

  test("galat CDP menolak janji", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const hasil = client.send("Page.navigate");
    const pesan = JSON.parse(transport.terkirim[0] ?? "{}") as { id: number };
    transport.masuk(JSON.stringify({ id: pesan.id, error: { code: -32000, message: "boom" } }));
    await expect(hasil).rejects.toBeInstanceOf(BrowserError);
  });

  test("waktu habis menolak janji", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport, 20);
    await expect(client.send("Page.enable")).rejects.toBeInstanceOf(BrowserError);
  });

  test("peristiwa diteruskan bersama sessionId", () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const seen: Array<{ params: unknown; sessionId: string | undefined }> = [];
    client.on("Page.frameNavigated", (params, sessionId) => {
      seen.push({ params, sessionId });
    });
    transport.masuk(
      JSON.stringify({
        method: "Page.frameNavigated",
        params: { frame: { url: "https://example.com" } },
        sessionId: "S1",
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe("S1");
    expect(
      (seen[0]?.params as { frame?: { url?: string } }).frame?.url,
    ).toBe("https://example.com");
  });

  test("pendengar per sesi hanya menerima peristiwa sesinya", () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    let jumlah = 0;
    client.on("Page.screencastFrame", () => {
      jumlah += 1;
    }, "S1");
    transport.masuk(
      JSON.stringify({ method: "Page.screencastFrame", params: {}, sessionId: "S2" }),
    );
    expect(jumlah).toBe(0);
    transport.masuk(
      JSON.stringify({ method: "Page.screencastFrame", params: {}, sessionId: "S1" }),
    );
    expect(jumlah).toBe(1);
  });

  test("pesan JSON tak valid diabaikan", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const hasil = client.send("Page.enable");
    transport.masuk("{bukan json");
    transport.masuk("[]");
    const pesan = JSON.parse(transport.terkirim[0] ?? "{}") as { id: number };
    transport.masuk(JSON.stringify({ id: pesan.id, result: { ok: true } }));
    expect(await hasil).toEqual({ ok: true });
  });

  test("soket menutup menolak janji tertunda", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    const hasil = client.send("Page.enable");
    transport.tutup();
    await expect(hasil).rejects.toBeInstanceOf(BrowserError);
  });

  test("perintah setelah ditutup ditolak", async () => {
    const transport = new TransportPalsu();
    const client = klien(transport);
    client.close();
    expect(transport.tertutup).toBe(true);
    await expect(client.send("Page.enable")).rejects.toBeInstanceOf(BrowserError);
  });
});
