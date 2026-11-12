/**
 * Uji asap binary Jejak.
 *
 * Menjalankan binary `serve --mock` di folder sementara (JEJAK_HOME, HOME,
 * dan cwd kosong), lalu memeriksa handful rute. Skrip ini bukan bagian
 * `bun test`; dijalankan manual atau di CI.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildBinary,
  currentBuildTarget,
  ROOT,
  targetOutputPath,
} from "./build-binary";

/** Pola nama chunk hasil code-splitting. */
const CHUNK_PATTERN = /chunk-[A-Za-z0-9._-]+\.js/g;

/**
 * Mengambil nama chunk yang dirujuk di dalam JavaScript entri.
 * Hasil unik dan berurutan kemunculan pertama.
 */
export function extractChunkRefs(js: string): string[] {
  const hasil: string[] = [];
  for (const cocok of js.matchAll(CHUNK_PATTERN)) {
    const nama = cocok[0];
    if (nama !== undefined && !hasil.includes(nama)) hasil.push(nama);
  }
  return hasil;
}

export interface SmokeCheck {
  /** Nama pemeriksaan. */
  name: string;
  /** Hasil pemeriksaan. */
  passed: boolean;
  /** Ringkasan singkat. */
  detail: string;
}

/** Mencari port bebas: bind port 0, ambil portnya, lalu lepas. */
export async function cariPort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  server.stop(true);
  if (port === undefined || port === 0) {
    throw new Error("tidak bisa mencari port bebas");
  }
  return port;
}

/** Menunggu server siap; mengembalikan true bila `/api/health` merespons. */
export async function tungguSiap(
  base: string,
  batasMs: number,
  anak: ChildProcess,
): Promise<boolean> {
  const akhir = Date.now() + batasMs;
  while (Date.now() < akhir) {
    if (anak.exitCode !== null || anak.signalCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        await res.text();
        return true;
      }
    } catch {
      // Server belum siap; coba lagi.
    }
    await Bun.sleep(150);
  }
  return false;
}

/** Menghentikan proses anak yang dijalankan skrip ini lewat PID-nya. */
export async function hentikan(anak: ChildProcess): Promise<void> {
  if (anak.exitCode !== null || anak.signalCode !== null) return;
  anak.kill("SIGTERM");
  const selesai = new Promise<void>((resolveDone) => {
    anak.once("exit", () => resolveDone());
  });
  await Promise.race([selesai, Bun.sleep(3000).then(() => undefined)]);
  if (anak.exitCode === null && anak.signalCode === null) {
    anak.kill("SIGKILL");
  }
}

interface KonteksPemeriksaan {
  base: string;
  versiPaket: string;
  binary: string;
}

/** Menjalankan seluruh pemeriksaan terhadap server yang sudah siap. */
export async function periksaSemuanya(
  konteks: KonteksPemeriksaan,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const { base, versiPaket, binary } = konteks;

  // Versi binary harus sama dengan package.json.
  const versi = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const teksVersi = (versi.stdout ?? "").trim();
  checks.push({
    name: "--version sama dengan package.json",
    passed: versi.status === 0 && teksVersi === versiPaket,
    detail: `status=${versi.status ?? 1} keluaran="${teksVersi}" diharapkan="${versiPaket}"`,
  });

  // Halaman utama harus HTML.
  try {
    const html = await fetch(`${base}/`);
    const tipe = html.headers.get("content-type") ?? "";
    const badan = await html.text();
    checks.push({
      name: "GET / menjawab 200 HTML",
      passed: html.status === 200 && tipe.includes("text/html") && badan.includes("<html"),
      detail: `status=${html.status} tipe="${tipe}"`,
    });
  } catch (error) {
    checks.push({
      name: "GET / menjawab 200 HTML",
      passed: false,
      detail: `galat: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Bundle JavaScript entri: 200, tipe JavaScript, isi tidak kosong.
  let appJs = "";
  try {
    const js = await fetch(`${base}/app.js`);
    const tipe = js.headers.get("content-type") ?? "";
    appJs = await js.text();
    checks.push({
      name: "GET /app.js menjawab 200 JavaScript tidak kosong",
      passed: js.status === 200 && tipe.includes("javascript") && appJs.trim().length > 0,
      detail: `status=${js.status} tipe="${tipe}" panjang=${appJs.length}`,
    });
  } catch (error) {
    checks.push({
      name: "GET /app.js menjawab 200 JavaScript tidak kosong",
      passed: false,
      detail: `galat: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const css = await fetch(`${base}/app.css`);
    const tipe = css.headers.get("content-type") ?? "";
    const badan = await css.text();
    checks.push({
      name: "GET /app.css menjawab 200 CSS",
      passed: css.status === 200 && tipe.includes("text/css") && badan.trim().length > 0,
      detail: `status=${css.status} tipe="${tipe}" panjang=${badan.length}`,
    });
  } catch (error) {
    checks.push({
      name: "GET /app.css menjawab 200 CSS",
      passed: false,
      detail: `galat: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Satu chunk yang dirujuk dari app.js harus tersedia.
  const refs = extractChunkRefs(appJs);
  if (refs.length === 0) {
    checks.push({
      name: "chunk yang dirujuk app.js tersedia",
      passed: true,
      detail: "tidak ada chunk yang dirujuk; pemeriksaan dilewati",
    });
  } else {
    const nama = refs[0] as string;
    try {
      const chunk = await fetch(`${base}/${nama}`);
      const tipe = chunk.headers.get("content-type") ?? "";
      const badan = await chunk.text();
      checks.push({
        name: "chunk yang dirujuk app.js tersedia",
        passed: chunk.status === 200 && badan.length > 0,
        detail: `${nama} status=${chunk.status} tipe="${tipe}" panjang=${badan.length}`,
      });
    } catch (error) {
      checks.push({
        name: "chunk yang dirujuk app.js tersedia",
        passed: false,
        detail: `${nama} galat: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  try {
    const health = await fetch(`${base}/api/health`);
    const data = (await health.json()) as { version?: unknown };
    checks.push({
      name: "/api/health memuat versi",
      passed: health.status === 200 && data.version === versiPaket,
      detail: `status=${health.status} version=${String(data.version)}`,
    });
  } catch (error) {
    checks.push({
      name: "/api/health memuat versi",
      passed: false,
      detail: `galat: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return checks;
}

/** Alur skrip; mengembalikan kode keluar untuk skrip. */
export async function main(argv: readonly string[]): Promise<number> {
  const argumen = argv.filter((item) => item !== "");
  if (argumen.length > 1) {
    console.error("Pakai: bun run scripts/smoke-binary.ts [path-binary]");
    return 1;
  }

  let binary: string;
  if (argumen.length === 1) {
    const mentah = argumen[0] as string;
    binary = isAbsolute(mentah) ? mentah : resolve(process.cwd(), mentah);
  } else {
    const target = currentBuildTarget();
    if (target === null) {
      console.error(
        "Platform ini tidak punya target sah. Pakai: bun run scripts/smoke-binary.ts <path-binary>",
      );
      return 1;
    }
    console.log(`Membangun binary untuk ${target}...`);
    try {
      await buildBinary([target]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    binary = targetOutputPath(target);
  }

  const versiPaket = (
    JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version?: string }
  ).version;
  if (typeof versiPaket !== "string") {
    console.error("package.json tidak punya field version");
    return 1;
  }

  const induk = await mkdtemp(join(tmpdir(), "jejak-smoke-"));
  const dirHome = join(induk, "home");
  const dirJejakHome = join(induk, "jejak-home");
  const dirKerja = join(induk, "kerja");
  await mkdir(dirHome, { recursive: true });
  await mkdir(dirJejakHome, { recursive: true });
  await mkdir(dirKerja, { recursive: true });

  const port = await cariPort();
  const base = `http://127.0.0.1:${port}`;

  const env = { ...process.env };
  delete env.JEJAK_DEV;
  env.HOME = dirHome;
  env.JEJAK_HOME = dirJejakHome;
  env.MOCK = "true";

  let keluaran = "";
  const anak = spawn(binary, ["serve", "--mock", "--port", String(port)], {
    cwd: dirKerja,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  anak.stdout?.on("data", (data: Buffer) => {
    keluaran += data.toString();
  });
  anak.stderr?.on("data", (data: Buffer) => {
    keluaran += data.toString();
  });

  const results: SmokeCheck[] = [];
  try {
    const siap = await tungguSiap(base, 15000, anak);
    if (!siap) {
      results.push({
        name: "server siap di /api/health",
        passed: false,
        detail: "tidak siap dalam 15 detik",
      });
    } else {
      results.push({
        name: "server siap di /api/health",
        passed: true,
        detail: `siap di ${base}`,
      });
      results.push(...(await periksaSemuanya({ base, versiPaket, binary })));
    }
  } finally {
    await hentikan(anak);
    await rm(induk, { recursive: true, force: true });
  }

  console.log("");
  for (const check of results) {
    console.log(`${check.passed ? "PASS" : "FAIL"} - ${check.name} (${check.detail})`);
  }
  if (results.some((check) => !check.passed)) {
    console.log("");
    console.log(`Keluaran server: ${keluaran.trim().slice(0, 2000)}`);
  }
  console.log("");
  const gagal = results.filter((check) => !check.passed);
  console.log(
    gagal.length === 0
      ? `Semua ${results.length} pemeriksaan lulus.`
      : `${gagal.length} dari ${results.length} pemeriksaan gagal.`,
  );
  return gagal.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
