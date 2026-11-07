import { Elysia } from "elysia";
import { buildClientBundle, type ClientBundle } from "../client-bundle";

export interface ClientRoutesOptions {
  dev?: boolean;
  entry?: string;
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

const HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jejak</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`;

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
    .get("/app.css", () => bundleResponse((value) => value.css, "text/css; charset=utf-8"));

  return plugin as unknown as Elysia;
}
