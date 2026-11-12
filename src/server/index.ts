import { Elysia } from "elysia";
import { join } from "node:path";
import { VERSION } from "../shared/version";
import { createRunner, type AgentRunner } from "./agent";
import { defaultAuditStore, type AuditStore } from "./audit/audit-store";
import { authGuard } from "./auth/auth-guard";
import { createVerifier, type PasswordVerifier } from "./auth/password";
import { createSessionCodec } from "./auth/session-cookie";
import { createThrottle } from "./auth/throttle";
import { CheckpointService } from "./checkpoints/checkpoint-service";
import type { BudgetStore } from "./budget/budget-store";
import { defaultBudgetStore } from "./budget/budget-store";
import { defaultUsageLedger, type UsageLedger, usageRetentionDays } from "./budget/usage-ledger";
import {
  defaultClaudeConfigStore,
  type ClaudeConfigStore,
} from "./claude-config/config-store";
import { removeSessionUndo } from "./files/revert";
import { localGuard, DEFAULT_ALLOWED_HOSTS } from "./guard";
import { GoalReporterHolder } from "./goals/goal-reporter";
import { createMemoryBridge, type MemoryBridge } from "./memory/memory-bridge";
import { defaultMemoryStore } from "./memory/memory-store";
import { MemoryService } from "./memory/memory-service";
import { projectKeyFor } from "./memory/memory-tools";
import { buildSessionSummary } from "./memory/session-summary";
import type { McpServerService } from "./mcp/mcp-service";
import { fallbackSelection, resolveProvider as resolveRegistryProvider } from "./provider";
import { jejakHome, loadRegistry, providersPath } from "./provider-store";
import { loadEnvValuesFromDir } from "./security/env-values";
import {
  defaultSecretAllowStore,
  type SecretAllowStore,
} from "./security/secret-allow-store";
import { AttachmentStore } from "./attachments/store";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { checkpointRoutes } from "./routes/checkpoints";
import { auditRoutes } from "./routes/audit";
import { clientRoutes, type ClientRoutesOptions } from "./routes/client";
import { fileRoutes } from "./routes/files";
import { fsRoutes } from "./routes/fs";
import { goalRoutes } from "./routes/goal";
import { gitRoutes } from "./routes/git";
import { worktreeRoutes } from "./routes/worktree";
import { secretAllowRoutes } from "./routes/secret-allow";
import { budgetRoutes } from "./routes/budget";
import { usageRoutes } from "./routes/usage";
import { claudeConfigRoutes } from "./routes/claude-config";
import { sandboxRoutes } from "./routes/sandbox";
import { infoRoutes } from "./routes/info";
import { mcpServerRoutes, defaultMcpServerService } from "./routes/mcp-servers";
import { memoryRoutes } from "./routes/memory";
import { terminalRoutes } from "./routes/terminal";
import { TerminalManager } from "./terminal/terminal-manager";
import { runnerRoutes } from "./routes/runner";
import { RunnerService } from "./runner/runner-service";
import { FileRunnerStore, runnerPath as runnerStorePath } from "./runner/runner-store";
import { indexerRoutes } from "./routes/indexer";
import { wikiRoutes } from "./routes/wiki";
import { defaultGitProviderStore, type GitProviderStore } from "./gitprovider/provider-store";
import type { AdapterDeps } from "./gitprovider/adapters";
import { RepoIndexer, indexRoot } from "./indexer/repo-indexer";
import { WikiService, defaultResolveRepo, wikiRoot } from "./wiki/wiki-service";
import { questionRoutes } from "./routes/questions";
import { QuestionService } from "./questions/question-service";
import { defaultQuestionStore, type QuestionStore } from "./questions/question-store";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { defaultWorkspaceService, workspaceRoutes } from "./routes/workspaces";
import {
  SessionManager,
  type SessionManagerOptions,
  type WorkspaceResolver,
} from "./sessions/session-manager";
import { defaultSessionStore, type SessionStore } from "./sessions/session-store";
import { WorktreeService } from "./git/worktree-service";
import { defaultSandboxStore, type SandboxStore } from "./sandbox/sandbox-config";
import type { WorkspaceService } from "./workspaces/workspace-service";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Kata sandi aktif (atau verifier siap pakai); bila diisi, autentikasi aktif. */
  password?: string | PasswordVerifier;
  /** Host tambahan yang diizinkan (dari `--allow-host`). */
  allowHosts?: string[];
  /** Paksa penanda `Secure` pada cookie sesi. */
  secureCookie?: boolean;
  /** Sertifikat dan kunci TLS (isi PEM) untuk `Bun.serve`. */
  tls?: { cert: string; key: string };
}

/** Opsi autentikasi untuk `createApp`. */
export interface AuthOptions {
  /** Kata sandi aktif atau verifier siap pakai. */
  password: string | PasswordVerifier;
  /** Port server; dipakai pada nama cookie sesi. */
  port: number;
  /** Paksa penanda `Secure` pada cookie sesi. */
  secureCookie?: boolean;
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
  /** Folder lampiran pesan; default `<jejakHome(env)>/attachments`. */
  attachmentsDir?: string;
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
  /** Pengaturan sumber Claude (CLAUDE.md/skills/hooks); tanpa store rute 503. */
  claudeConfig?: ClaudeConfigStore;
  /** Sandbox Bash; tanpa store rute 503 dan `input.sandbox` tidak diisi. */
  sandbox?: SandboxStore;
  /** Antrean pertanyaan wawancara; tanpa store rute 503 dan tool question_ask tidak ada. */
  questions?: QuestionStore;
  /** Penyedia git dan indexer repo; tanpa keduanya rute 503 dan tool index_* tidak ada. */
  gitProviders?: GitProviderStore;
  indexer?: RepoIndexer;
  /** Layanan wiki proyek; tanpa ini rute wiki menjawab 503. */
  wikiService?: WikiService;
  /** Folder cache wiki; default `<jejakHome(env)>/cache/wikis`. */
  wikiRoot?: string;
  /** Dependensi adapter git (mis. fetch palsu untuk tes). */
  gitAdapterDeps?: AdapterDeps;
  /** Terminal PTY (akses shell penuh, tanpa sandbox); tanpa manajer rute 503. */
  terminal?: TerminalManager;
  /** Layanan peluncur perintah; tanpa opsi ini dibuat dari store bawaan. */
  runnerService?: RunnerService;
  /** Lokasi berkas `runner.json`; default `<jejakHome(env)>/runner.json`. */
  runnerPath?: string;
  /** Direktori home pengguna untuk `~/.claude`; default `os.homedir()`. */
  home?: string;
  /** Host yang diizinkan pada penjaga Host/Origin; default hanya loopback. */
  allowedHosts?: string[];
  /** Autentikasi opsional; bila diisi, guard dan rute auth dipasang. */
  auth?: AuthOptions;
}

/** Ringkasan otomatis akhir sesi menjadi usulan memory proyek (lapis episodik). */
function autoSummary(memory: MemoryService): NonNullable<SessionManagerOptions["onTurnEnd"]> {
  return async ({ sessionId, title, cwd, events }) => {
    const summary = buildSessionSummary(title, events);
    if (summary === undefined) return;
    await memory.upsertSessionSummary({
      sessionId,
      projectKey: await projectKeyFor(cwd),
      title: summary.title,
      body: summary.body,
    });
  };
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const path = options.providersPath ?? providersPath(env);

  const questionService =
    options.questions === undefined
      ? undefined
      : new QuestionService({
          store: options.questions,
          ...(options.memory === undefined ? {} : { memory: options.memory }),
        });

  // Jembatan MCP dibuat sebelum manajer sesi; pelapor tujuan ditautkan
  // begitu manajer siap (tool `goal_update` menolak sebelum itu).
  const goalReporter = new GoalReporterHolder();

  const memoryBridge =
    options.memory === undefined && options.workspaces === undefined
      ? undefined
      : createMemoryBridge({
          ...(options.memory === undefined ? {} : { service: options.memory }),
          ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
          ...(questionService === undefined ? {} : { questions: questionService }),
          ...(options.indexer === undefined ? {} : { indexer: options.indexer }),
          goalReporter: (sessionId, report) => goalReporter.report(sessionId, report),
          goalActive: (sessionId) => goalReporter.hasGoal(sessionId),
          mcpUrl: options.mcpUrl,
        });

  const attachments = new AttachmentStore({
    root: options.attachmentsDir ?? join(jejakHome(env), "attachments"),
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
      fallback: async (profileId) => {
        const registry = await loadRegistry(path, env);
        const selection = fallbackSelection(registry, profileId);
        return selection === undefined
          ? undefined
          : resolveRegistryProvider(registry, selection);
      },
      store: options.sessionStore,
      memoryBridge: memoryBridge?.bridge,
      ...(options.memory === undefined || env.JEJAK_AUTO_SUMMARY?.trim() === "0"
        ? {}
        : { onTurnEnd: autoSummary(options.memory) }),
      checkpoints,
      workspaces: workspaceResolver,
      extraDirectories: [attachments.root],
      mcpServers: options.mcpServers,
      worktrees,
      allowBypass: env.JEJAK_ALLOW_BYPASS?.trim() !== "0",
      audit: options.audit,
      ...(options.claudeConfig === undefined ? {} : { claude: options.claudeConfig }),
      ...(options.sandbox === undefined
        ? {}
        : {
            sandbox: {
              store: options.sandbox,
              ...(options.home === undefined ? {} : { home: options.home }),
            },
          }),
      ...(options.home === undefined ? {} : { home: options.home }),
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

  goalReporter.attach(
    (sessionId, report) => manager.reportGoal(sessionId, report),
    (sessionId) => manager.hasActiveGoal(sessionId),
  );

  // Folder yang boleh dipakai: folder sesi aktif (dan worktree miliknya).
  const sessionCwds = (): string[] => {
    const paths: string[] = [];
    for (const session of manager.list()) {
      if (session.archivedAt !== undefined) continue;
      paths.push(session.cwd);
      if (session.worktree?.path !== undefined) paths.push(session.worktree.path);
    }
    return paths;
  };

  // Peluncur perintah: folder yang boleh dipakai adalah folder sesi aktif
  // (dan worktree miliknya); perintah hanya dijalankan lewat terminal.
  const runnerService =
    options.runnerService ??
    new RunnerService({
      store: new FileRunnerStore(options.runnerPath ?? runnerStorePath(env)),
      terminal: options.terminal,
      allowedCwds: sessionCwds,
      audit: options.audit,
    });

  // Wiki proyek: hanya aktif bila ada penyedia git.
  const wikiService =
    options.wikiService ??
    (options.gitProviders === undefined
      ? undefined
      : new WikiService({
          root: options.wikiRoot ?? wikiRoot(env),
          providers: options.gitProviders,
          resolveRepo: defaultResolveRepo(options.gitProviders, options.gitAdapterDeps),
        }));

  // Autentikasi opsional: penjaga dipasang sesudah penjaga lokal (Host/Origin),
  // rute auth dipasang lebih dulu agar status dan login terjangkau.
  const authOptions = options.auth;
  const verifier: PasswordVerifier | undefined =
    authOptions === undefined
      ? undefined
      : typeof authOptions.password === "string"
        ? createVerifier(authOptions.password)
        : authOptions.password;
  const codec =
    authOptions === undefined ? undefined : createSessionCodec({ port: authOptions.port });
  const throttle = createThrottle();
  const authPlugins: Elysia[] = [];

  if (codec !== undefined) {
    authPlugins.push(authGuard({ codec }));
  }
  authPlugins.push(
    authRoutes({
      ...(verifier === undefined ? {} : { verifier }),
      ...(codec === undefined ? {} : { codec }),
      throttle,
      audit: options.audit,
      ...(authOptions?.secureCookie === undefined
        ? {}
        : { secureCookie: authOptions.secureCookie }),
    }),
  );

  let app = new Elysia()
    .use(
      localGuard(
        options.allowedHosts === undefined
          ? undefined
          : // Daftar host diizinkan diperluas, bukan mengganti daftar bawaan.
            { allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...options.allowedHosts] },
      ),
    )
    .use(authPlugins)
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch, audit: options.audit }))
    .use(sessionRoutes({ manager, workspaces: workspaceResolver, audit: options.audit }))
    .use(goalRoutes({ manager, audit: options.audit }))
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
    .use(attachmentRoutes({ store: attachments }))
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
    .use(terminalRoutes({ manager: options.terminal, audit: options.audit }))
    .use(runnerRoutes({ runner: runnerService }))
    .use(questionRoutes({ service: questionService, audit: options.audit }))
    .use(
      indexerRoutes({
        providers: options.gitProviders,
        indexer: options.indexer,
        audit: options.audit,
        adapterDeps: options.gitAdapterDeps,
      }),
    )
    .use(
      wikiRoutes({
        wiki: wikiService,
        providers: options.gitProviders,
        audit: options.audit,
        allowedCwds: sessionCwds,
      }),
    )
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
    .use(
      usageRoutes({
        ...(options.usageLedger === undefined ? {} : { ledger: options.usageLedger }),
        retentionDays: usageRetentionDays(env),
        // Judul sesi diambil dari manajer sesi; tanpa itu klien memakai daftarnya.
        titles: (ids) => {
          const wanted = new Set(ids);
          const found: Record<string, string> = {};
          for (const session of manager.list()) {
            if (!wanted.has(session.id)) continue;
            found[session.id] = session.title;
          }
          return found;
        },
      }),
    )
    .use(
      claudeConfigRoutes({
        store: options.claudeConfig,
        ...(options.home === undefined ? {} : { home: options.home }),
        audit: options.audit,
      }),
    )
    .use(sandboxRoutes({ store: options.sandbox, audit: options.audit }))
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

function mcpUrlFor(host: string, port: number, secure: boolean): string {
  const safeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `${secure ? "https" : "http"}://${safeHost}:${port}/mcp`;
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
  const mcpUrl = mcpUrlFor(host, port, options.tls !== undefined);
  const workspaces = defaultWorkspaceService(process.env);
  const mcpServers = defaultMcpServerService(process.env);
  const audit = defaultAuditStore(process.env);
  const secretAllow = defaultSecretAllowStore(process.env);
  const budget = defaultBudgetStore(process.env);
  const usageLedger = defaultUsageLedger(process.env);
  const claudeConfig = defaultClaudeConfigStore(process.env);
  const sandbox = defaultSandboxStore(process.env);
  const questions = defaultQuestionStore(process.env);
  const terminal =
    process.env.JEJAK_TERMINAL?.trim() === "1" ? new TerminalManager() : undefined;
  terminal?.start();
  const gitProviders = defaultGitProviderStore(process.env);
  const indexer =
    gitProviders === undefined ? undefined : new RepoIndexer({ root: indexRoot(process.env) });
  const app = createApp({
    sessionStore: store,
    memory,
    mcpUrl,
    checkpoints,
    workspaces,
    ...(options.allowHosts === undefined ? {} : { allowedHosts: options.allowHosts }),
    ...(options.password === undefined
      ? {}
      : {
          auth: {
            password: options.password,
            port,
            ...(options.secureCookie === undefined ? {} : { secureCookie: options.secureCookie }),
          },
        }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(audit === undefined ? {} : { audit }),
    ...(secretAllow === undefined ? {} : { secretAllow }),
    ...(budget === undefined ? {} : { budget }),
    ...(usageLedger === undefined ? {} : { usageLedger }),
    ...(claudeConfig === undefined ? {} : { claudeConfig }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(questions === undefined ? {} : { questions }),
    ...(gitProviders === undefined || indexer === undefined ? {} : { gitProviders, indexer }),
    ...(terminal === undefined ? {} : { terminal }),
  }).listen({
    hostname: host,
    port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  });
  console.log(
    `Jejak ${VERSION} siap di ${options.tls === undefined ? "http" : "https"}://${host}:${port}`,
  );
  const closers: Array<() => void> = [];
  if (store !== undefined) closers.push(() => store.close());
  if (memoryStore !== undefined) closers.push(() => memoryStore.close());
  if (audit !== undefined) closers.push(() => audit.close());
  if (usageLedger !== undefined) closers.push(() => usageLedger.close());
  if (terminal !== undefined) closers.push(() => terminal.closeAll());
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
