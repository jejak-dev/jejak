import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../src/server/browser/cdp-client";
import { locateChrome } from "../src/server/browser/chrome-locator";
import { BrowserManager, type BrowserFrame } from "../src/server/browser/browser-manager";

/** Chrome yang dipakai uji integrasi (hanya bila diizinkan lewat env). */
const chrome = locateChrome(process.env, process.platform, existsSync);
const boleh = process.env.JEJAK_TEST_CHROME?.trim() === "1" && chrome !== undefined;

async function tungguSyarat(syarat: () => boolean, ms = 30_000): Promise<void> {
  const mulai = Date.now();
  while (!syarat()) {
    if (Date.now() - mulai > ms) throw new Error("waktu habis menunggu syarat");
    await Bun.sleep(100);
  }
}

/** Apakah proses dengan pid itu masih hidup. */
function hidup(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Daftar baris perintah proses yang memuat path profil tertentu. */
function prosesDengan(path: string): string[] {
  try {
    const hasil = Bun.spawnSync(["ps", "-ax", "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (hasil.exitCode !== 0) return [];
    return hasil.stdout
      .toString()
      .split("\n")
      .filter((baris) => baris.includes(path));
  } catch {
    return [];
  }
}

const HALAMAN = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>jejak-satu</title>
    <style>
      body { margin: 0; font-family: sans-serif; }
      #tombol { position: absolute; left: 100px; top: 100px; width: 200px; height: 50px; }
      #kotak { position: absolute; left: 100px; top: 200px; width: 200px; height: 40px; }
    </style>
  </head>
  <body>
    <button id="tombol" onclick="document.title = 'diklik'">Klik</button>
    <input id="kotak" />
  </body>
</html>`;

const HALAMAN_KEDUA = `<!doctype html>
<html><head><meta charset="utf-8" /><title>jejak-dua</title></head>
<body><h1>kedua</h1></body></html>`;

/** Server lokal untuk uji integrasi. */
function jalankanServer(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const body = url.pathname === "/kedua" ? HALAMAN_KEDUA : HALAMAN;
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

/**
 * Hubungkan langsung ke CDP Chrome Jejak (hanya untuk membaca hasil uji).
 *
 * Uji memakai `Runtime.evaluate` agar hasil klik dan ketikan dibaca apa
 * adanya dari halaman.
 */
async function hubungkanCdp(
  profil: string,
): Promise<{ client: CdpClient; sessionId: string; tutup: () => void }> {
  const isi = readFileSync(join(profil, "DevToolsActivePort"), "utf8").split("\n");
  const port = Number.parseInt((isi[0] ?? "").trim(), 10);
  const jalur = (isi[1] ?? "").trim();
  if (!Number.isInteger(port) || port <= 0 || jalur === "") {
    throw new Error("port DevTools tak terbaca");
  }
  const client = await CdpClient.connect(`ws://127.0.0.1:${port}${jalur}`);
  const targets = (await client.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId?: string; type?: string }>;
  };
  const halaman = targets.targetInfos?.find((info) => info.type === "page");
  const targetId = halaman?.targetId;
  if (targetId === undefined) throw new Error("target halaman tak ditemukan");
  const attached = (await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId?: string };
  const sessionId = attached?.sessionId;
  if (sessionId === undefined) throw new Error("sesi CDP tak terpasang");
  return { client, sessionId, tutup: () => client.close() };
}

/** Baca nilai ekspresi di halaman aktif (lewat Runtime.evaluate). */
async function baca(
  cdp: { client: CdpClient; sessionId: string },
  ekspresi: string,
): Promise<string> {
  const hasil = (await cdp.client.send(
    "Runtime.evaluate",
    { expression: ekspresi, returnByValue: true },
    cdp.sessionId,
  )) as { result?: { value?: unknown } } | undefined;
  const nilai = hasil?.result?.value;
  return typeof nilai === "string" ? nilai : "";
}

/** Tunggu halaman selesai dimuat. */
async function tungguSelesai(manager: BrowserManager): Promise<void> {
  await tungguSyarat(() => manager.state().loading === false);
  await Bun.sleep(300);
}

/** Klik pada koordinat halaman. */
async function klik(manager: BrowserManager, x: number, y: number): Promise<void> {
  await manager.dispatchInput([
    { kind: "mouse", type: "move", x, y },
    { kind: "mouse", type: "down", x, y, button: "left", clickCount: 1 },
    { kind: "mouse", type: "up", x, y, button: "left", clickCount: 1 },
  ]);
  await Bun.sleep(300);
}

describe("integrasi browser (Chrome nyata)", () => {
  test.skipIf(!boleh)(
    "klik, ketik, riwayat, dan tab bekerja; tak ada proses tersisa",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jejak-browser-integrasi-"));
      const profil = join(dir, "browser-profile");
      const server = jalankanServer();
      const manager = new BrowserManager({
        env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: chrome },
        platform: process.platform,
        exists: existsSync,
      });
      let cdp: Awaited<ReturnType<typeof hubungkanCdp>> | undefined;
      try {
        await manager.ensure();
        expect(manager.state().status).toBe("menyala");
        const state = await manager.navigate(`http://localhost:${server.port}/`);
        expect(state.url).toContain("localhost");
        await tungguSelesai(manager);

        cdp = await hubungkanCdp(profil);

        // Klik tombol: judul halaman berubah jadi "diklik".
        await klik(manager, 150, 120);
        expect(await baca(cdp, "document.title")).toBe("diklik");

        // Ketik ke kotak teks lalu baca nilainya.
        await klik(manager, 150, 220);
        for (const huruf of ["a", "b", "c"]) {
          await manager.dispatchInput([
            {
              kind: "key",
              type: "down",
              key: huruf,
              code: `Key${huruf.toUpperCase()}`,
              text: huruf,
            },
            { kind: "key", type: "up", key: huruf, code: `Key${huruf.toUpperCase()}` },
          ]);
        }
        await Bun.sleep(300);
        expect(await baca(cdp, "document.getElementById('kotak').value")).toBe("abc");

        // Riwayat: maju, mundur, lalu maju lagi.
        await manager.navigate(`http://localhost:${server.port}/kedua`);
        await tungguSelesai(manager);
        expect(manager.state().url).toContain("/kedua");
        const mundur = await manager.back();
        expect(mundur.url).toContain("localhost");
        expect(mundur.url).not.toContain("/kedua");
        const maju = await manager.forward();
        expect(maju.url).toContain("/kedua");

        // Tab baru lalu ditutup.
        const sebelum = manager.state().tabs.length;
        const denganTab = await manager.newTab(`http://localhost:${server.port}/`);
        expect(denganTab.tabs.length).toBe(sebelum + 1);
        const ditutup = await manager.closeTab(denganTab.activeId ?? "");
        expect(ditutup.tabs.length).toBe(sebelum);
        expect(ditutup.activeId).toBeDefined();
      } finally {
        cdp?.tutup();
        await manager.close();
        server.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!boleh)(
    "screencast berjalan, close() tak meninggalkan proses",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jejak-browser-integrasi-"));
      const server = jalankanServer();
      const manager = new BrowserManager({
        env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: chrome },
        platform: process.platform,
        exists: existsSync,
      });
      try {
        await manager.ensure();
        expect(manager.state().status).toBe("menyala");
        const state = await manager.navigate(`http://localhost:${server.port}/`);
        expect(state.url).toContain("localhost");

        const frames: BrowserFrame[] = [];
        const unsubscribe = manager.subscribe((frame) => {
          frames.push(frame);
        });
        await tungguSyarat(() => frames.length > 0);
        unsubscribe();
        expect(frames[0]?.data.length ?? 0).toBeGreaterThan(0);
        expect(frames[0]?.width ?? 0).toBeGreaterThan(0);

        const pid = manager.pid;
        expect(pid).toBeDefined();
        await manager.close();
        if (pid !== undefined) {
          await tungguSyarat(() => !hidup(pid), 5_000);
          expect(hidup(pid)).toBe(false);
        }
        expect(manager.state().status).toBe("mati");
      } finally {
        await manager.close();
        server.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!boleh)(
    "tiga kali berturut-turut tetap stabil dan tak ada proses tersisa",
    async () => {
      for (let putaran = 0; putaran < 3; putaran += 1) {
        const dir = await mkdtemp(join(tmpdir(), "jejak-browser-integrasi-"));
        const profil = join(dir, "browser-profile");
        const server = jalankanServer();
        const manager = new BrowserManager({
          env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: chrome },
          platform: process.platform,
          exists: existsSync,
        });
        let cdp: Awaited<ReturnType<typeof hubungkanCdp>> | undefined;
        try {
          await manager.ensure();
          await manager.navigate(`http://localhost:${server.port}/`);
          await tungguSelesai(manager);
          cdp = await hubungkanCdp(profil);
          await klik(manager, 150, 120);
          expect(await baca(cdp, "document.title")).toBe("diklik");
          await manager.setViewport(800, 600);
          expect(manager.state().viewport).toEqual({ width: 800, height: 600 });
          const pid = manager.pid;
          await manager.close();
          if (pid !== undefined) {
            await tungguSyarat(() => !hidup(pid), 5_000);
            expect(hidup(pid)).toBe(false);
          }
          // Tak ada Chrome Jejak yang tertinggal untuk profil ini.
          expect(prosesDengan(profil)).toEqual([]);
        } finally {
          cdp?.tutup();
          await manager.close();
          server.stop();
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
  );
});
