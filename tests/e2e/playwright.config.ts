/**
 * Konfigurasi Playwright untuk spec e2e Jejak.
 *
 * Lapisan ini terpisah dari `bun test`: spec peramban butuh konteks per berkas,
 * server uji sendiri, dan jejak (trace) saat gagal — lifecycle yang tak
 * dimiliki pemeriksa `bun test`. Karena itu nama berkasnya `.e2e.ts`, bukan
 * `.spec.ts`: `bun test` juga memuat `*.spec.ts` dan akan mengimpor berkas
 * spec ke prosesnya sendiri, di mana `test.describe` melempar galat.
 *
 * Server uji dijalankan oleh Playwright (`webServer`), bukan oleh spec, supaya
 * tiap spec tak perlu menyalakan dan mematikan proses sendiri.
 */

import { defineConfig, devices } from "@playwright/test";
import { akarRepo } from "./tmp-home";

/** Port server uji; sama dengan bawaan `tests/e2e/server.ts`. */
const PORT = Number(process.env.E2E_PORT ?? "3931");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = process.env.CI === "true";

export default defineConfig({
  // Relatif terhadap berkas ini (`tests/e2e/`).
  testDir: "./specs",
  testMatch: "**/*.e2e.ts",
  // Membersihkan direktori data uji setelah semua spec selesai.
  globalTeardown: "./teardown.ts",
  // Spec peramban butuh waktu: halaman dimuat, klien dibangun, lalu SSE.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Satu worker: semua spec berbagi satu server uji dan satu port.
  workers: 1,
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    // Jejak hanya saat percobaan ulang: bukti kegagalan tanpa membebani
    // menjalankan biasa.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Animasi membuat posisi pelacak bergerak dan tangkapan layar jadi
    // acak; tak ada spec yang menguji gerakan.
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1400, height: 800 },
      },
    },
  ],
  webServer: {
    command: "bun tests/e2e/server.ts",
    // Server dijalankan dari akar repo supaya berkas sumber klien ditemukan.
    cwd: akarRepo(),
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_PORT: String(PORT) },
  },
});
