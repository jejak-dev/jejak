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
import {
  desktopEnterRoutes,
  DESKTOP_ENTER_PATH,
  DESKTOP_SESSION_TTL_MS,
} from "./desktop";
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
import { claudeMemoryRoutes } from "./routes/claude-memory";
import { claudeMemorySyncRoutes } from "./routes/claude-memory-sync";
import { ClaudeMemorySync } from "./memory/claude-memory-sync";
import {
  defaultMemorySyncStore,
  resolveMemorySync,
  type MemorySyncStore,
} from "./memory/memory-sync-store";
import {
  claudeConfigRoot,
  claudeProjectEntries,
  type ClaudeProjectEntry,
  type ClaudeProjectSeed,
} from "./memory/claude-memory";
import { featuresRoutes } from "./routes/features";
import { terminalRoutes } from "./routes/terminal";
import { TerminalManager } from "./terminal/terminal-manager";
import { browserRoutes } from "./routes/browser";
import { BrowserManager } from "./browser/browser-manager";
import { runnerRoutes } from "./routes/runner";
import { RunnerService } from "./runner/runner-service";
import { FileRunnerStore, runnerPath as runnerStorePath } from "./runner/runner-store";
import { indexerRoutes } from "./routes/indexer";
import { wikiRoutes } from "./routes/wiki";
import { defaultGitProviderStore, type GitProviderStore } from "./gitprovider/provider-store";
import { FeatureGate } from "./features/feature-gate";
import {
  defaultFeatureStore,
  resolveFeature,
  type FeatureName,
  type FeatureState,
  type FeatureStore,
} from "./features/feature-store";
import type { AdapterDeps } from "./gitprovider/adapters";
import { RepoIndexer, indexRoot } from "./indexer/repo-indexer";
import { WikiService, defaultResolveRepo, wikiRoot } from "./wiki/wiki-service";
import { questionRoutes } from "./routes/questions";
import { QuestionService } from "./questions/question-service";
import { defaultQuestionStore, type QuestionStore } from "./questions/question-store";
import { providerRoutes } from "./routes/providers";
import { sessionRoutes } from "./routes/sessions";
import { sdkRoutes } from "./routes/sdk";
import type { LocateOptions } from "./sdk/claude-locator";
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
  /** Mode desktop: token masuk sekali pakai untuk rute `/__desktop/enter`. */
  desktopToken?: string;
  /** Masa berlaku cookie sesi (ms); mode desktop memakai 30 hari. */
  sessionTtlMs?: number;
}

/** Hasil `startServer`: aplikasi, alamat nyata, dan cara menghentikannya. */
export interface ServeHandle {
  /** Aplikasi Elysia yang melayani permintaan. */
  app: ReturnType<typeof createApp>;
  /** Host binding yang dipakai. */
  host: string;
  /** Port nyata (berbeda dari yang diminta bila diminta port 0). */
  port: number;
  /** Hentikan server. */
  stop(): Promise<void>;
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
  /** Terminal PTY (akses shell penuh, tanpa sandbox); disuntikkan berarti fitur menyala. */
  terminal?: TerminalManager;
  /** Browser headless (satu Chromium per proses); disuntikkan berarti fitur menyala. */
  browser?: BrowserManager;
  /** Penyimpanan status fitur (terminal, browser); default berkas di JEJAK_HOME. */
  features?: FeatureStore;
  /** Penyimpanan status sinkron memory ke Claude Code; default berkas di JEJAK_HOME. */
  memorySync?: MemorySyncStore;
  /** Layanan peluncur perintah; tanpa opsi ini dibuat dari store bawaan. */
  runnerService?: RunnerService;
  /** Lokasi berkas `runner.json`; default `<jejakHome(env)>/runner.json`. */
  runnerPath?: string;
  /** Direktori home pengguna untuk `~/.claude`; default `os.homedir()`. */
  home?: string;
  /** Host yang diizinkan pada penjaga Host/Origin; default hanya loopback. */
  allowedHosts?: string[];
  /** Pengaturan SDK terpasang; `root` menimpa folder penyimpanan bawaan. */
  sdk?: { root?: string; locate?: LocateOptions };
  /** Autentikasi opsional; bila diisi, guard dan rute auth dipasang. */
  auth?: AuthOptions;
  /** Mode desktop: rute masuk sekali pakai dan cookie sesi 30 hari. */
  desktop?: DesktopOptions;
}

/** Opsi mode desktop untuk `createApp`. */
export interface DesktopOptions {
  /** Token masuk sekali pakai. */
  token: string;
  /** Masa berlaku cookie sesi; default 30 hari. */
  sessionTtlMs?: number;
}

/** Gerbang fitur yang dipakai aplikasi; dipakai untuk menutup saat berhenti. */
export interface FeatureGates {
  terminal: FeatureGate<TerminalManager>;
  browser: FeatureGate<BrowserManager>;
}

/** Ringkasan otomatis akhir sesi menjadi usulan memory proyek (lapis episodik). */
function autoSummary(memory: MemoryService): NonNullable<SessionManagerOptions["onTurnEnd"]> {
  return async ({ sessionId, title, cwd, events }) => {
    const summary = buildSessionSummary(title, events, cwd);
    if (summary === undefined) return;
    try {
      await memory.upsertSessionSummary({
        sessionId,
        projectKey: await projectKeyFor(cwd),
        title: summary.title,
        body: summary.body,
      });
    } catch (error) {
      // Kegagalan tak boleh menggagalkan giliran; tapi tak boleh hilang tanpa
      // jejak juga. Isi ringkasan tak pernah ikut dicetak.
      const alasan = error instanceof Error ? error.message : "alasan tak diketahui";
      console.warn("Ringkasan sesi tidak disimpan:", alasan);
    }
  };
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const path = options.providersPath ?? providersPath(env);

  // Fitur (terminal, browser) mati secara default. Saklar ada di Pengaturan;
  // env `JEJAK_TERMINAL`/`JEJAK_BROWSER` tetap menang atas berkas.
  const featureStore = options.features ?? defaultFeatureStore(env);
  const storedFeatures = featureStore.get();
  const terminalGate = new FeatureGate<TerminalManager>({
    create: () => {
      if (options.terminal !== undefined) return options.terminal;
      const manager = new TerminalManager();
      manager.start();
      return manager;
    },
    close: (manager) => manager.closeAll(),
  });
  const browserGate = new FeatureGate<BrowserManager>({
    create: () => {
      if (options.browser !== undefined) return options.browser;
      return new BrowserManager();
    },
    close: (manager) => manager.close(),
  });
  if (options.terminal !== undefined) {
    terminalGate.enable();
  } else if (resolveFeature("terminal", env, storedFeatures).enabled) {
    terminalGate.enable();
  }
  if (options.browser !== undefined) {
    browserGate.enable();
  } else if (resolveFeature("browser", env, storedFeatures).enabled) {
    browserGate.enable();
  }
  // Env mengunci fitur: nilainya menang, juga saat manajer disuntikkan.
  const envLocked = (name: FeatureName): "1" | "0" | undefined => {
    const raw = env[name === "terminal" ? "JEJAK_TERMINAL" : "JEJAK_BROWSER"]?.trim();
    return raw === "1" || raw === "0" ? raw : undefined;
  };
  if (envLocked("terminal") === "0") void terminalGate.disable().catch(() => undefined);
  if (envLocked("browser") === "0") void browserGate.disable().catch(() => undefined);
  /** Status efektif fitur: gerbang menentukan menyala, env menentukan terkunci. */
  const featureState = (name: FeatureName): FeatureState => {
    const locked =
      env[name === "terminal" ? "JEJAK_TERMINAL" : "JEJAK_BROWSER"]?.trim() === "1" ||
      env[name === "terminal" ? "JEJAK_TERMINAL" : "JEJAK_BROWSER"]?.trim() === "0";
    const enabled = name === "terminal" ? terminalGate.isEnabled : browserGate.isEnabled;
    return { enabled, locked };
  };
  /** Terapkan status fitur: mematikan menutup sesi atau proses berjalan. */
  const applyFeature = async (name: FeatureName, enabled: boolean): Promise<void> => {
    if (name === "terminal") {
      if (enabled) terminalGate.enable();
      else await terminalGate.disable();
      return;
    }
    if (enabled) browserGate.enable();
    else await browserGate.disable();
  };

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

  // Tool browser ikut jembatan supaya agent memakai browser yang sama dengan
  // panel. Sumber manajer dibaca setiap permintaan: saklar fitur berlaku
  // seketika (tool tak tampil dan panggilan ditolak saat browser mati).
  // Jembatan selalu dibuat; Mode Goal tetap butuh tool `goal_update` yang
  // hanya ada bila layanan memory tersedia.
  const memoryBridge = createMemoryBridge({
    ...(options.memory === undefined ? {} : { service: options.memory }),
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(questionService === undefined ? {} : { questions: questionService }),
    ...(options.indexer === undefined ? {} : { indexer: options.indexer }),
    browser: {
      resolve: () => browserGate.get(),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    },
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

  // Proyek yang dikenal untuk pembacaan memory Claude Code (baca-saja):
  // folder kerja sesi beserta repo asal worktree miliknya. Daftar ini
  // harus sama dengan daftar proyek yang dilihat klien.
  const claudeProjects = (): ClaudeProjectEntry[] => {
    const seeds: ClaudeProjectSeed[] = [];
    for (const session of manager.list()) {
      const worktree = session.worktree;
      seeds.push({
        cwd: session.cwd,
        ...(worktree === undefined
          ? {}
          : { worktree: { path: worktree.path, repoRoot: worktree.repoRoot } }),
      });
    }
    return claudeProjectEntries(seeds, [options.cwd ?? process.cwd()]);
  };

  // Sinkron memory proyek Jejak ke folder memory Claude Code. Saklar default
  // mati; env `JEJAK_CLAUDE_SYNC` mengunci nilainya.
  const memorySyncStore = options.memorySync ?? defaultMemorySyncStore(env);
  const claudeSync = new ClaudeMemorySync({
    configRoot: claudeConfigRoot(env, options.home),
    enabled: () => resolveMemorySync(env, memorySyncStore.get()).enabled,
    projects: claudeProjects,
    ...(options.memory === undefined
      ? {}
      : { memories: () => options.memory?.listProjectMemories() ?? Promise.resolve([]) }),
  });
  // Perubahan memory memicu sinkron per peristiwa; kegagalannya tak pernah
  // menggagalkan operasi memory Jejak.
  const memoryService = options.memory;
  if (memoryService !== undefined) {
    memoryService.setChangeListener((event) =>
      event.kind === "simpan"
        ? claudeSync.apply(event.memory).then(() => undefined)
        : claudeSync.remove(event.memory).then(() => undefined),
    );
  }

  // Peluncur perintah: folder yang boleh dipakai adalah folder sesi aktif
  // (dan worktree miliknya); perintah hanya dijalankan lewat terminal.
  const runnerService =
    options.runnerService ??
    new RunnerService({
      store: new FileRunnerStore(options.runnerPath ?? runnerStorePath(env)),
      terminal: () => terminalGate.get(),
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
  const desktop = options.desktop;
  const verifier: PasswordVerifier | undefined =
    authOptions === undefined
      ? undefined
      : typeof authOptions.password === "string"
        ? createVerifier(authOptions.password)
        : authOptions.password;
  const codec =
    authOptions === undefined
      ? undefined
      : createSessionCodec({
          port: authOptions.port,
          ...(desktop === undefined
            ? {}
            : { ttlMs: desktop.sessionTtlMs ?? DESKTOP_SESSION_TTL_MS }),
        });
  const throttle = createThrottle();
  const authPlugins: Elysia[] = [];

  if (codec !== undefined) {
    authPlugins.push(
      authGuard({
        codec,
        ...(desktop === undefined ? {} : { openPaths: [DESKTOP_ENTER_PATH] }),
      }),
    );
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
  // Rute masuk sekali pakai hanya ada pada mode desktop.
  if (desktop !== undefined && codec !== undefined) {
    authPlugins.push(
      desktopEnterRoutes({
        token: desktop.token,
        codec,
        throttle,
        ...(authOptions?.secureCookie === undefined
          ? {}
          : { secureCookie: authOptions.secureCookie }),
      }),
    );
  }

  let app = new Elysia()
    .use(
      localGuard({
        ...(options.allowedHosts === undefined
          ? {}
          : // Daftar host diizinkan diperluas, bukan mengganti daftar bawaan.
            { allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...options.allowedHosts] }),
        // Rute masuk desktop juga wajib lolos penjaga Host/Origin.
        ...(desktop === undefined ? {} : { guardedPrefixes: ["/api/", "/__desktop/"] }),
      }),
    )
    .use(authPlugins)
    .use(providerRoutes({ path: options.providersPath, env: options.env, fetch: options.fetch, audit: options.audit }))
    .use(
      sdkRoutes({
        ...(options.sdk?.root === undefined ? {} : { root: options.sdk.root }),
        ...(options.sdk?.locate === undefined ? {} : { locate: options.sdk.locate }),
        env: options.env,
        fetch: options.fetch,
        audit: options.audit,
      }),
    )
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
    .use(
      claudeMemoryRoutes({
        projects: claudeProjects,
        env,
        ...(options.home === undefined ? {} : { home: options.home }),
      }),
    )
    .use(
      claudeMemorySyncRoutes({
        store: memorySyncStore,
        env,
        sync: claudeSync,
        audit: options.audit,
      }),
    )
    .use(
      featuresRoutes({
        store: featureStore,
        env,
        state: featureState,
        apply: applyFeature,
        audit: options.audit,
      }),
    )
    .use(terminalRoutes({ manager: () => terminalGate.get(), audit: options.audit }))
    .use(browserRoutes({ manager: () => browserGate.get(), audit: options.audit }))
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
  // Seam untuk penutupan: manajer fitur ditutup saat server berhenti.
  (result as unknown as { featureGates?: FeatureGates }).featureGates = {
    terminal: terminalGate,
    browser: browserGate,
  };
  return result;
}

function mcpUrlFor(host: string, port: number, secure: boolean): string {
  const safeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `${secure ? "https" : "http"}://${safeHost}:${port}/mcp`;
}

export function startServer(options: ServeOptions = {}): ServeHandle {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const requestedPort = options.port ?? Number(process.env.PORT ?? 3000);
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
  const workspaces = defaultWorkspaceService(process.env);
  const mcpServers = defaultMcpServerService(process.env);
  const audit = defaultAuditStore(process.env);
  const secretAllow = defaultSecretAllowStore(process.env);
  const budget = defaultBudgetStore(process.env);
  const usageLedger = defaultUsageLedger(process.env);
  const claudeConfig = defaultClaudeConfigStore(process.env);
  const sandbox = defaultSandboxStore(process.env);
  const questions = defaultQuestionStore(process.env);
  // Terminal dan browser dibuat malas oleh gerbang fitur: statusnya berasal
  // dari env dan saklar di Pengaturan, bukan dari pembuatan di awal.
  const gitProviders = defaultGitProviderStore(process.env);
  const indexer =
    gitProviders === undefined ? undefined : new RepoIndexer({ root: indexRoot(process.env) });

  // Server diikat lebih dulu supaya port NYATA diketahui (mode desktop memakai
  // port acak dari OS). Aplikasi dirakit sesudah port diketahui, sehingga nama
  // cookie sesi, URL MCP, dan pesan log memakai port yang benar.
  const holder: { app?: ReturnType<typeof createApp> } = {};
  const server = Bun.serve({
    hostname: host,
    port: requestedPort,
    // Sama dengan bawaan `.listen` Elysia (30 dtk); bawaan Bun (10 dtk) lebih pendek
    // dari jeda ping SSE (15 dtk) sehingga aliran sesi bisa terputus.
    idleTimeout: 30,
    fetch: (request) => {
      const pending = holder.app;
      if (pending === undefined) {
        return new Response("Jejak belum siap", { status: 503 });
      }
      return pending.handle(request);
    },
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  });
  const port = server.port ?? requestedPort;
  const mcpUrl = mcpUrlFor(host, port, options.tls !== undefined);

  const app = createApp({
    sessionStore: store,
    memory,
    mcpUrl,
    checkpoints,
    workspaces,
    ...(options.allowHosts === undefined ? {} : { allowHosts: options.allowHosts }),
    ...(options.password === undefined
      ? {}
      : {
          auth: {
            password: options.password,
            port,
            ...(options.secureCookie === undefined ? {} : { secureCookie: options.secureCookie }),
          },
        }),
    ...(options.desktopToken === undefined
      ? {}
      : {
          desktop: {
            token: options.desktopToken,
            ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
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
  });
  holder.app = app;
  // Supaya konteks permintaan punya `server` (alamat socket untuk throttle).
  app.server = server;
  const gates = (app as unknown as { featureGates?: FeatureGates }).featureGates;

  console.log(
    `Jejak ${VERSION} siap di ${options.tls === undefined ? "http" : "https"}://${host}:${port}`,
  );
  const closers: Array<() => void> = [];
  if (store !== undefined) closers.push(() => store.close());
  if (memoryStore !== undefined) closers.push(() => memoryStore.close());
  if (audit !== undefined) closers.push(() => audit.close());
  if (usageLedger !== undefined) closers.push(() => usageLedger.close());
  // Jalur keluar proses (sinyal/`exit`) tak boleh menunggu: bunuh Chrome seketika.
  if (gates !== undefined) {
    closers.push(() => {
      void gates.terminal.shutdown().catch(() => undefined);
      // Manajer diambil lebih dulu: `shutdown()` melepasnya dari gerbang.
      const browser = gates.browser.peek();
      void gates.browser.shutdown().catch(() => undefined);
      // Penanda permanen: setelah keluar, browser tak boleh menyalakan
      // Chrome lagi (Chrome yang baru luncur tak boleh jadi yatim).
      browser?.shutdownSync();
    });
  }
  // Penutup yang boleh menunggu (dipakai `stop()`).
  const asyncClosers: Array<() => Promise<void>> = [];
  if (gates !== undefined) {
    asyncClosers.push(async () => {
      await gates.terminal.shutdown();
      await gates.browser.shutdown();
    });
  }
  let sudahTutup = false;
  const close = (): void => {
    if (sudahTutup) return;
    sudahTutup = true;
    for (const closer of closers) closer();
  };
  if (closers.length > 0) {
    process.once("exit", close);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        close();
        process.exit(0);
      });
    }
  }
  return {
    app,
    host,
    port,
    async stop(): Promise<void> {
      close();
      await server.stop(true);
      for (const closer of asyncClosers) await closer();
    },
  };
}
