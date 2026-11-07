import { Elysia } from "elysia";
import { VERSION } from "../shared/version";
import { createRunner, type AgentRunner } from "./agent";
import { localGuard } from "./guard";
import { resolveProvider as resolveRegistryProvider } from "./provider";
import { loadRegistry, providersPath } from "./provider-store";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { SessionManager } from "./sessions/session-manager";

export interface ServeOptions {
  host?: string;
  port?: number;
}

export interface CreateAppOptions {
  providersPath?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  runner?: AgentRunner;
  sessions?: SessionManager;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const path = options.providersPath ?? providersPath(env);

  const manager =
    options.sessions ??
    new SessionManager({
      runner: options.runner ?? createRunner(env),
      resolveProvider: async (selection) =>
        resolveRegistryProvider(await loadRegistry(path, env), selection),
    });

  return new Elysia()
    .use(localGuard())
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch }))
    .use(sessionRoutes({ manager }))
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
