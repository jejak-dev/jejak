/**
 * Server uji untuk spec e2e (Playwright).
 *
 * Menyalakan Jejak dengan runner mock supaya spec tak pernah menyentuh API
 * model sungguhan. Semua data ditulis ke direktori sementara (`JEJAK_HOME`),
 * jadi `~/.jejak` milik pengembang tak pernah tersentuh.
 *
 * Env diatur SEBELUM modul server dimuat: beberapa penyimpanan membaca env
 * saat modul dievaluasi, bukan saat `createApp` dipanggil.
 */

import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Elysia } from "elysia";
import { direktoriDataUji } from "./tmp-home";
import type { MemoryBridge } from "../../src/server/memory/memory-bridge";

/** Port server uji; `playwright.config.ts` memakai nomor yang sama. */
const PORT = Number(process.env.E2E_PORT ?? "3931");

/** Direktori sementara; tempat seluruh data Jejak uji ditulis. */
const home = direktoriDataUji();
// Run sebelumnya mungkin meninggalkan sisa; direktori dibersihkan dulu.
await rm(home, { recursive: true, force: true });
await mkdir(home, { recursive: true, mode: 0o700 });

process.env.JEJAK_HOME = home;
// Penyimpanan dimatikan: sesi, tahanan, dan tugas terjadwal hanya di memori.
process.env.JEJAK_PERSIST = "0";
// Sandbox tak diperlukan: runner mock tak pernah menjalankan perintah.
process.env.JEJAK_SANDBOX = "0";
// Menandai server sebagai mock; dipakai klien untuk lencana "mock".
process.env.MOCK = "true";

// Registry provider minimal: pembuatan sesi selalu butuh profil yang bisa
// dipecahkan, walau runner mock tak pernah memanggil model sungguhan.
await writeFile(
  join(home, "providers.json"),
  `${JSON.stringify(
    {
      profiles: [{ id: "mock", name: "Mock Uji", models: [{ id: "mock-model" }] }],
      activeProfileId: "mock",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const { createApp } = await import("../../src/server");
const { createMockRunner } = await import("../../src/server/agent");

const app = createApp({ runner: createMockRunner({}) });

// Jam tahanan dan jam tugas terjadwal dijalankan seperti pada server sungguhan.
const layanan = app as unknown as {
  heldPrompts?: { start(): void };
  scheduledTasks?: { start(): void };
};
layanan.heldPrompts?.start();
layanan.scheduledTasks?.start();

/**
 * Rute KHUSUS UJI: memanggil tool `design_screenshot` lewat jembatan memory
 * tanpa agent sungguhan. Hanya ada di server uji ini, tidak di `src/`.
 * Jawaban tidak memuat gambar, hanya ukuran dan dimensi IHDR-nya.
 */
const bridge = (app as unknown as { memoryBridge?: MemoryBridge }).memoryBridge;
if (bridge !== undefined) {
  (app as unknown as Elysia).post(
    "/__uji/design-screenshot",
    async ({ body }) => {
      const gagal = (pesan: string, status = 400): Response =>
        new Response(JSON.stringify({ error: pesan }), {
          status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      let input: unknown;
      try {
        input = JSON.parse(typeof body === "string" ? body : "");
      } catch {
        return gagal("Body harus JSON.");
      }
      if (typeof input !== "object" || input === null) return gagal("Body harus objek.");
      const record = input as Record<string, unknown>;
      const { sessionId, cwd, slug } = record;
      if (typeof sessionId !== "string" || typeof cwd !== "string" || typeof slug !== "string") {
        return gagal("Field sessionId, cwd, dan slug wajib string.");
      }
      const args: { slug: string; scale?: 1 | 2 } = { slug };
      if (record.scale === 1 || record.scale === 2) args.scale = record.scale;
      const opened = await bridge.open({ sessionId, cwd });
      try {
        const hasil = await opened.memory.call("design_screenshot", args);
        let imageBytes = 0;
        let width = 0;
        let height = 0;
        if (hasil.image !== undefined) {
          const png = Buffer.from(hasil.image.data, "base64");
          imageBytes = png.length;
          if (png.length >= 24 && png.toString("latin1", 12, 16) === "IHDR") {
            width = png.readUInt32BE(16);
            height = png.readUInt32BE(20);
          }
        }
        return new Response(
          JSON.stringify({
            isError: hasil.isError,
            text: hasil.text,
            imageBytes,
            width,
            height,
            mimeType: hasil.image?.mimeType ?? "",
          }),
          { headers: { "content-type": "application/json; charset=utf-8" } },
        );
      } finally {
        opened.close();
      }
    },
    { parse: "text" },
  );
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  // Sama dengan server sungguhan: aliran SSE butuh koneksi yang lebih tua
  // daripada bawaan Bun (10 detik).
  idleTimeout: 30,
  fetch: (request) => app.handle(request),
});

/** Hapus direktori sementara; dipakai saat proses dihentikan. */
async function bersihkan(): Promise<void> {
  await server.stop(true).catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

for (const sinyal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinyal, () => {
    void bersihkan().finally(() => process.exit(0));
  });
}
process.on("exit", () => {
  // Cadangan bila proses mati mendadak: hapus direktori sementara.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Tidak ada yang bisa dilakukan; proses sedang berakhir.
  }
});

// Bundel klien dibangun saat permintaan pertama. Pemanasan ini membuat spec
// pertama tak menunggu build dan tak gagal karena timeout halaman.
await fetch(`http://127.0.0.1:${PORT}/app.js`)
  .then((response) => response.arrayBuffer())
  .catch(() => undefined);

console.log(`server uji siap di http://127.0.0.1:${PORT}`);
