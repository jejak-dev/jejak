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
import { direktoriDataUji } from "./tmp-home";

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
