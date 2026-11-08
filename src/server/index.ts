import { Elysia } from "elysia";
import { VERSION } from "../shared/version";
import { createRunner, type AgentRunner } from "./agent";
import { localGuard } from "./guard";
import { defaultMemoryStore } from "./memory/memory-store";
import { MemoryService } from "./memory/memory-service";
import { resolveProvider as resolveRegistryProvider } from "./provider";
import { loadRegistry, providersPath } from "./provider-store";
import { clientRoutes, type ClientRoutesOptions } from "./routes/client";
import { fileRoutes } from "./routes/files";
import { infoRoutes } from "./routes/info";
import { memoryRoutes } from "./routes/memory";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { SessionManager } from "./sessions/session-manager";
import { defaultSessionStore, type SessionStore } from "./sessions/session-store";

export interface ServeOptions {
  host?: string;
  port?: number;
}

export interface CreateAppOptions {
  providersPath?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  fetch?: typeof fetch;
  runner?: AgentRunner;
  sessions?: SessionManager;
  sessionStore?: SessionStore;
  client?: ClientRoutesOptions;
  /** Direktori snapshot undo; default `<jejakHome(env)>/undo`. */
  undoDir?: string;
  /** Layanan memory; tanpa opsi ini semua rute `/api/memory*` menjawab 503. */
  memory?: MemoryService;
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
      store: options.sessionStore,
    });

  return new Elysia()
    .use(localGuard())
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch }))
    .use(sessionRoutes({ manager }))
    .use(fileRoutes({ manager, env: options.env, undoDir: options.undoDir }))
    .use(memoryRoutes({ service: options.memory }))
    .get("/api/health", () => ({ ok: true, name: "jejak", version: VERSION }))
    .use(
      infoRoutes({
        cwd: options.cwd,
        mock: env.MOCK?.trim().toLowerCase() === "true",
      }),
    )
    .use(clientRoutes(options.client));
}

export function startServer(options: ServeOptions = {}) {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const store = defaultSessionStore(process.env);
  const memoryStore = defaultMemoryStore(process.env);
  const memory =
    memoryStore === undefined
      ? undefined
      : new MemoryService({ store: memoryStore, cwd: process.cwd() });
  const app = createApp({ sessionStore: store, memory }).listen({ hostname: host, port });
  console.log(`Jejak berjalan di http://${host}:${port}`);
  const closers: Array<() => void> = [];
  if (store !== undefined) closers.push(() => store.close());
  if (memoryStore !== undefined) closers.push(() => memoryStore.close());
  if (closers.length > 0) {
    const close = (): void => {
      for (const closer of closers) closer();
    };
    process.once("exit", close);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        close();
        process.exit(0);
      });
    }
  }
  return app;
}
