import { Elysia } from "elysia";
import { join } from "node:path";
import { VERSION } from "../shared/version";
import { createRunner, type AgentRunner } from "./agent";
import { defaultAuditStore, type AuditStore } from "./audit/audit-store";
import { CheckpointService } from "./checkpoints/checkpoint-service";
import type { BudgetStore } from "./budget/budget-store";
import { defaultBudgetStore } from "./budget/budget-store";
import { defaultUsageLedger, type UsageLedger } from "./budget/usage-ledger";
import { removeSessionUndo } from "./files/revert";
import { localGuard } from "./guard";
import { createMemoryBridge, type MemoryBridge } from "./memory/memory-bridge";
import { defaultMemoryStore } from "./memory/memory-store";
import { MemoryService } from "./memory/memory-service";
import type { McpServerService } from "./mcp/mcp-service";
import { resolveProvider as resolveRegistryProvider } from "./provider";
import { jejakHome, loadRegistry, providersPath } from "./provider-store";
import { loadEnvValuesFromDir } from "./security/env-values";
import {
  defaultSecretAllowStore,
  type SecretAllowStore,
} from "./security/secret-allow-store";
import { checkpointRoutes } from "./routes/checkpoints";
import { auditRoutes } from "./routes/audit";
import { clientRoutes, type ClientRoutesOptions } from "./routes/client";
import { fileRoutes } from "./routes/files";
import { fsRoutes } from "./routes/fs";
import { gitRoutes } from "./routes/git";
import { worktreeRoutes } from "./routes/worktree";
import { secretAllowRoutes } from "./routes/secret-allow";
import { budgetRoutes } from "./routes/budget";
import { infoRoutes } from "./routes/info";
import { mcpServerRoutes, defaultMcpServerService } from "./routes/mcp-servers";
import { memoryRoutes } from "./routes/memory";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { defaultWorkspaceService, workspaceRoutes } from "./routes/workspaces";
import { SessionManager, type WorkspaceResolver } from "./sessions/session-manager";
import { defaultSessionStore, type SessionStore } from "./sessions/session-store";
import { WorktreeService } from "./git/worktree-service";
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
  /** Layanan worktree; default dibuat kecuali `JEJAK_WORKTREES=0`. */
  worktrees?: WorktreeService;
  /** Folder awal penelusur folder; default `os.homedir()`. */
  fsHome?: string;
  /** Penyimpanan log audit; tanpa opsi ini semua rute `/api/audit*` menjawab 503. */
  audit?: AuditStore;
  /** Daftar izin berkas rahasia; tanpa opsi ini rute `secret-allow` menjawab 503. */
  secretAllow?: SecretAllowStore;
  /** Pengaturan anggaran; tanpa opsi ini semua rute `/api/budget*` menjawab 503. */
  budget?: BudgetStore;
  /** Buku pemakaian biaya untuk status anggaran dan peringatan sesi. */
  usageLedger?: UsageLedger;
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

  const worktrees =
    options.worktrees ??
    (env.JEJAK_WORKTREES?.trim() === "0"
      ? undefined
      : new WorktreeService({ root: join(jejakHome(env), "worktrees") }));

  const secretsMode = env.JEJAK_SECRETS?.trim();
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
      worktrees,
      allowBypass: env.JEJAK_ALLOW_BYPASS?.trim() !== "0",
      audit: options.audit,
      ...(options.budget === undefined
        ? {}
        : {
            budget: {
              ...(options.usageLedger === undefined ? {} : { ledger: options.usageLedger }),
              store: options.budget,
            },
          }),
      secrets: {
        mode: secretsMode === "off" || secretsMode === "warn" ? secretsMode : "redact",
        blockPaths: env.JEJAK_SECRET_BLOCK?.trim() !== "0",
        ...(options.secretAllow === undefined ? {} : { allow: options.secretAllow }),
        ...(env.JEJAK_SECRETS_ENV?.trim() === "1"
          ? { loadEnvValues: loadEnvValuesFromDir }
          : {}),
      },
      onSessionDeleted: (id) =>
        removeSessionUndo(
          options.undoDir ?? join(jejakHome(env), "undo"),
          id,
        ),
    });

  let app = new Elysia()
    .use(localGuard())
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch, audit: options.audit }))
    .use(sessionRoutes({ manager, workspaces: workspaceResolver, audit: options.audit }))
    .use(worktreeRoutes({ manager, service: worktrees, audit: options.audit }))
    .use(
      secretAllowRoutes({
        manager,
        store: options.secretAllow,
        audit: options.audit,
      }),
    )
    .use(
      fileRoutes({
        manager,
        workspaces: workspaceResolver,
        env: options.env,
        undoDir: options.undoDir,
        editEnabled: env.JEJAK_FILE_EDIT?.trim() !== "0",
        audit: options.audit,
      }),
    )
    .use(checkpointRoutes({ manager, service: checkpoints, audit: options.audit }))
    .use(
      gitRoutes({
        manager,
        workspaces: workspaceResolver,
        enabled: env.JEJAK_GIT?.trim() !== "0",
        writeEnabled: env.JEJAK_GIT_WRITE?.trim() !== "0",
        audit: options.audit,
      }),
    )
    .use(memoryRoutes({ service: options.memory, audit: options.audit }))
    .use(workspaceRoutes({ service: options.workspaces, audit: options.audit }))
    .use(
      fsRoutes({
        ...(options.fsHome === undefined ? {} : { home: options.fsHome }),
        enabled: env.JEJAK_FS_BROWSE?.trim() !== "0",
      }),
    )
    .use(mcpServerRoutes({ service: options.mcpServers, fetch: options.fetch, audit: options.audit }))
    .use(auditRoutes({ store: options.audit }))
    .use(
      budgetRoutes({
        store: options.budget,
        ledger: options.usageLedger,
        audit: options.audit,
      }),
    )
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
  const audit = defaultAuditStore(process.env);
  const secretAllow = defaultSecretAllowStore(process.env);
  const budget = defaultBudgetStore(process.env);
  const usageLedger = defaultUsageLedger(process.env);
  const app = createApp({
    sessionStore: store,
    memory,
    mcpUrl,
    checkpoints,
    workspaces,
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(audit === undefined ? {} : { audit }),
    ...(secretAllow === undefined ? {} : { secretAllow }),
    ...(budget === undefined ? {} : { budget }),
    ...(usageLedger === undefined ? {} : { usageLedger }),
  }).listen({
    hostname: host,
    port,
  });
  console.log(`Jejak berjalan di http://${host}:${port}`);
  const closers: Array<() => void> = [];
  if (store !== undefined) closers.push(() => store.close());
  if (memoryStore !== undefined) closers.push(() => memoryStore.close());
  if (audit !== undefined) closers.push(() => audit.close());
  if (usageLedger !== undefined) closers.push(() => usageLedger.close());
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
