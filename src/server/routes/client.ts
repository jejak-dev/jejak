import { Elysia } from "elysia";
import { buildClientBundle, type ClientBundle } from "../client-bundle";
import {
  DARK_BG,
  ICON_MASKABLE_SVG,
  ICON_SVG,
  LIGHT_BG,
  MANIFEST,
  SERVICE_WORKER,
} from "../pwa";

export interface ClientRoutesOptions {
  dev?: boolean;
  entry?: string;
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

const HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><title>Jejak</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon.svg"><meta name="theme-color" content="${LIGHT_BG}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="${DARK_BG}" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`;

/** Nama berkas yang boleh disajikan: huruf, angka, titik, garis, dan strip saja. */
const FILE_NAME = /^[A-Za-z0-9._-]+$/;

function isServableFile(name: string): boolean {
  if (!FILE_NAME.test(name)) return false;
  // Tolak nama traversal ("..") walau karakternya lolos pola di atas.
  if (name.includes("..")) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clientRoutes(options: ClientRoutesOptions = {}): Elysia {
  const dev = options.dev ?? process.env.JEJAK_DEV === "1";
  const entry = options.entry;

  let cached: Promise<ClientBundle> | undefined;

  const bundle = (): Promise<ClientBundle> => {
    if (dev) {
      return buildClientBundle(entry);
    }
    if (cached === undefined) {
      cached = buildClientBundle(entry).catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };

  const bundleResponse = async (
    pick: (value: ClientBundle) => string,
    contentType: string,
  ): Promise<Response> => {
    try {
      const value = pick(await bundle());
      return new Response(value, {
        headers: {
          "content-type": contentType,
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: errorMessage(error) }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };

  const notFound = (): Response =>
    new Response(JSON.stringify({ error: "berkas tidak ditemukan" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  /** Aset statis PWA: isi tetap, tanpa data sesi. */
  const staticAsset = (body: string, contentType: string): Response =>
    new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });

  const plugin = new Elysia({ name: "jejak-client-routes" })
    .get(
      "/",
      () =>
        new Response(HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
            "content-security-policy": CSP,
            "x-content-type-options": "nosniff",
          },
        }),
    )
    .get("/app.js", () => bundleResponse((value) => value.js, "application/javascript; charset=utf-8"))
    .get("/app.css", () => bundleResponse((value) => value.css, "text/css; charset=utf-8"))
    /**
     * Aset PWA. Rute statis ini menang atas `/:file` supaya nama berkas
     * yang sama tidak tertimpa oleh rute chunk.
     */
    .get("/manifest.webmanifest", () => staticAsset(MANIFEST, "application/manifest+json"))
    .get("/icon.svg", () => staticAsset(ICON_SVG, "image/svg+xml"))
    .get("/icon-maskable.svg", () => staticAsset(ICON_MASKABLE_SVG, "image/svg+xml"))
    .get("/sw.js", () => staticAsset(SERVICE_WORKER, "application/javascript; charset=utf-8"))
    /**
     * Chunk hasil code-splitting (mis. mermaid) disajikan dari akar.
     * Hanya nama berkas yang benar-benar ada di bundle yang dilayani.
     */
    .get("/:file", async ({ params }: { params: { file: string } }) => {
      const name = params.file;
      if (!isServableFile(name)) return notFound();
      try {
        const file = (await bundle()).files.get(name);
        if (file === undefined) return notFound();
        return new Response(file.body, {
          headers: {
            "content-type": file.contentType,
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: errorMessage(error) }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    });

  return plugin as unknown as Elysia;
}
