import { Elysia } from "elysia";
import { VERSION } from "../shared/version";

export interface ServeOptions {
  host?: string;
  port?: number;
}

export function createApp() {
  return new Elysia()
    .get("/api/health", () => ({ ok: true, name: "jejak", version: VERSION }))
    .get(
      "/",
      () =>
        new Response(
          "<!doctype html><meta charset=utf-8><title>Jejak</title>" +
            "<body style=\"font-family:system-ui;margin:3rem\"><h1>Jejak</h1>" +
            `<p>Server berjalan. Versi ${VERSION}.</p></body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
}

export function startServer(options: ServeOptions = {}) {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const app = createApp().listen({ hostname: host, port });
  console.log(`Jejak berjalan di http://${host}:${port}`);
  return app;
}
