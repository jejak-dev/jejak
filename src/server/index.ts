import { Elysia } from "elysia";
import { join } from "node:path";
import { VERSION } from "../shared/version";
import { createRunner, type AgentRunner } from "./agent";
import { CheckpointService } from "./checkpoints/checkpoint-service";
import { localGuard } from "./guard";
import { createMemoryBridge, type MemoryBridge } from "./memory/memory-bridge";
import { defaultMemoryStore } from "./memory/memory-store";
import { MemoryService } from "./memory/memory-service";
import type { McpServerService } from "./mcp/mcp-service";
import { resolveProvider as resolveRegistryProvider } from "./provider";
import { jejakHome, loadRegistry, providersPath } from "./provider-store";
import { checkpointRoutes } from "./routes/checkpoints";
import { clientRoutes, type ClientRoutesOptions } from "./routes/client";
import { fileRoutes } from "./routes/files";
import { infoRoutes } from "./routes/info";
import { mcpServerRoutes, defaultMcpServerService } from "./routes/mcp-servers";
import { memoryRoutes } from "./routes/memory";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { defaultWorkspaceService, workspaceRoutes } from "./routes/workspaces";
import { SessionManager, type WorkspaceResolver } from "./sessions/session-manager";
import { defaultSessionStore, type SessionStore } from "./sessions/session-store";
import type { WorkspaceService } from "./workspaces/workspace-service";

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
  /** URL publik `/mcp` yang dipakai agent untuk menjangkau tool memory. */
  mcpUrl?: string;
  /** Layanan checkpoint; tanpa opsi ini rute checkpoint menjawab 503. */
  checkpoints?: CheckpointService;
  /** Direktori checkpoint; default `<jejakHome(env)>/checkpoints`. */
  checkpointDir?: string;
  /** Layanan workspace; tanpa opsi ini semua rute `/api/workspaces*` menjawab 503. */
  workspaces?: WorkspaceService;
  /** Layanan server MCP; tanpa opsi ini semua rute `/api/mcp-servers*` menjawab 503. */
  mcpServers?: McpServerService;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const path = options.providersPath ?? providersPath(env);

  const memoryBridge =
    options.memory === undefined && options.workspaces === undefined
      ? undefined
      : createMemoryBridge({
          ...(options.memory === undefined ? {} : { service: options.memory }),
          ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
          mcpUrl: options.mcpUrl,
        });

  const checkpoints =
    options.checkpoints ??
    (options.checkpointDir === undefined
      ? undefined
      : new CheckpointService({ root: options.checkpointDir }));

  const workspaceResolver: WorkspaceResolver | undefined =
    options.workspaces === undefined
      ? undefined
      : {
          get: async (id) => {
            const view = await options.workspaces!.get(id);
            if (view === undefined || view === null) return undefined;
            return {
              id: view.id,
              name: view.name,
              repos: view.repos.map((repo) => ({
                name: repo.name,
                path: repo.path,
                kind: repo.card.kind,
                missing: repo.missing,
              })),
            };
          },
        };

  const manager =
    options.sessions ??
    new SessionManager({
      runner: options.runner ?? createRunner(env),
      resolveProvider: async (selection) =>
        resolveRegistryProvider(await loadRegistry(path, env), selection),
      store: options.sessionStore,
      memoryBridge: memoryBridge?.bridge,
      checkpoints,
      workspaces: workspaceResolver,
      mcpServers: options.mcpServers,
      allowBypass: env.JEJAK_ALLOW_BYPASS?.trim() !== "0",
    });

  let app = new Elysia()
    .use(localGuard())
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch }))
    .use(sessionRoutes({ manager, workspaces: workspaceResolver }))
    .use(
      fileRoutes({
        manager,
        workspaces: workspaceResolver,
        env: options.env,
        undoDir: options.undoDir,
      }),
    )
    .use(checkpointRoutes({ manager, service: checkpoints }))
    .use(memoryRoutes({ service: options.memory }))
    .use(workspaceRoutes({ service: options.workspaces }))
    .use(mcpServerRoutes({ service: options.mcpServers, fetch: options.fetch }))
    .get("/api/health", () => ({ ok: true, name: "jejak", version: VERSION }))
    .use(
      infoRoutes({
        cwd: options.cwd,
        mock: env.MOCK?.trim().toLowerCase() === "true",
      }),
    );
  if (memoryBridge !== undefined) {
    app = app.use(memoryBridge.routes);
  }
  const result = app.use(clientRoutes(options.client));
  if (memoryBridge !== undefined) {
    // Seam untuk tes dan integrasi in-process: membuka sesi memory tanpa HTTP.
    (result as unknown as { memoryBridge?: MemoryBridge }).memoryBridge =
      memoryBridge.bridge;
  }
  return result;
}

function mcpUrlFor(host: string, port: number): string {
  const safeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${safeHost}:${port}/mcp`;
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
  const checkpointsDisabled = process.env.JEJAK_CHECKPOINTS?.trim() === "0";
  const checkpoints = checkpointsDisabled
    ? undefined
    : new CheckpointService({ root: join(jejakHome(), "checkpoints") });
  const mcpUrl = mcpUrlFor(host, port);
  const workspaces = defaultWorkspaceService(process.env);
  const mcpServers = defaultMcpServerService(process.env);
  const app = createApp({
    sessionStore: store,
    memory,
    mcpUrl,
    checkpoints,
    workspaces,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  }).listen({
    hostname: host,
    port,
  });
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
