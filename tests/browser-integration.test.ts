import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("integrasi browser (Chrome nyata)", () => {
  test.skipIf(!boleh)(
    "navigasi ke server lokal, screencast berjalan, close() tak meninggalkan proses",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jejak-browser-integrasi-"));
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response("<!doctype html><html><body><h1>halo-jejak</h1></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      });
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
        server.stop(true);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
