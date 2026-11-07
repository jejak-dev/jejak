import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  PERMISSION_EXPIRED_MESSAGE,
  PERMISSION_STOPPED_MESSAGE,
  type AgentEvent,
  type AgentRunner,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
} from "../agent";
import type { ModelPrice, ProviderSelection, ResolvedProvider } from "../provider";
import { estimateCostUsd } from "../pricing";
import type { SessionStore, StoredSession } from "./session-store";

export type SessionStatus = "berjalan" | "selesai" | "gagal" | "dibatalkan";

export type SessionPermissionMode = "default" | "acceptEdits" | "plan";

export interface SessionInfo {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  profileId: string;
  model?: string;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  pendingPermissions: number;
  queued: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd?: number; sdkCostUsd?: number };
}

export interface SequencedEvent {
  seq: number;
  event: AgentEvent;
}

export interface CreateSessionInput {
  prompt: string;
  cwd: string;
  title?: string;
  selection?: ProviderSelection;
  permissionMode?: string;
}

export interface SessionManagerOptions {
  runner: AgentRunner;
  resolveProvider: (selection: ProviderSelection) => Promise<ResolvedProvider>;
  maxConcurrent?: number;
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxPromptLength?: number;
  now?: () => Date;
  permissionTimeoutMs?: number;
  store?: SessionStore;
}

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: "tidak-valid" | "tidak-ditemukan" | "penuh",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

interface Pending {
  resolve: (value: PermissionDecision) => void;
  name: string;
}

interface SessionRecord {
  info: SessionInfo;
  apiKey?: string;
  controller: AbortController;
  buffer: SequencedEvent[];
  nextSeq: number;
  version: number;
  listeners: Set<() => void>;
  done: Promise<void>;
  settle: () => void;
  pending: Map<string, Pending>;
  permissionTimeoutMs: number;
  price?: ModelPrice;
  resolved?: ResolvedProvider;
  sdkSessionId?: string;
  queue: string[];
}

const MAX_QUEUED_MESSAGES = 5;

const PERMISSION_MODES: readonly SessionPermissionMode[] = ["default", "acceptEdits", "plan"];

const DEFAULTS = {
  maxConcurrent: 4,
  maxSessions: 100,
  maxEventsPerSession: 5000,
  maxPromptLength: 20000,
  permissionTimeoutMs: 600_000,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeText(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    return text;
  }
  return text.split(apiKey).join("***");
}

function sanitizeValue(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === "string") {
    return sanitizeText(value, apiKey);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, apiKey));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeValue(item, apiKey);
    }
    return result;
  }
  return value;
}

function sanitizeEvent(event: AgentEvent, apiKey: string | undefined): AgentEvent {
  return sanitizeValue(event, apiKey) as AgentEvent;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitForChange(
  record: SessionRecord,
  version: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (record.version !== version || isAborted(signal)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      record.listeners.delete(finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    record.listeners.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class SessionManager {
  private readonly runner: AgentRunner;
  private readonly resolveProvider: (selection: ProviderSelection) => Promise<ResolvedProvider>;
  private readonly maxConcurrent: number;
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly maxPromptLength: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly permissionTimeoutMs: number;
  private readonly store: SessionStore | undefined;
  private storeWarned = false;

  constructor(options: SessionManagerOptions) {
    this.runner = options.runner;
    this.resolveProvider = options.resolveProvider;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    this.maxEventsPerSession = options.maxEventsPerSession ?? DEFAULTS.maxEventsPerSession;
    this.maxPromptLength = options.maxPromptLength ?? DEFAULTS.maxPromptLength;
    this.now = options.now ?? (() => new Date());
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULTS.permissionTimeoutMs;
    this.store = options.store;
    if (this.store !== undefined) {
      this.restore();
    }
  }

  private storeGuard(action: () => void): void {
    if (this.store === undefined) return;
    try {
      action();
    } catch (error) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        console.warn(`Penyimpanan sesi gagal: ${errorMessage(error)}`);
      }
    }
  }

  private persistSession(record: SessionRecord): void {
    const info = { ...record.info };
    const sdkSessionId = record.sdkSessionId;
    this.storeGuard(() => this.store?.saveSession(info, sdkSessionId));
  }

  private restore(): void {
    const store = this.store;
    if (store === undefined) return;

    let stored: StoredSession[];
    try {
      stored = store.loadSessions();
    } catch (error) {
      this.storeWarned = true;
      console.warn(`Penyimpanan sesi gagal dimuat: ${errorMessage(error)}`);
      return;
    }

    for (const item of stored) {
      let buffer: SequencedEvent[] = [];
      try {
        buffer = store.loadEvents(item.info.id).slice(-this.maxEventsPerSession);
      } catch (error) {
        if (!this.storeWarned) {
          this.storeWarned = true;
          console.warn(`Penyimpanan sesi gagal: ${errorMessage(error)}`);
        }
      }

      const lastSeq = buffer.reduce((max, event) => Math.max(max, event.seq), 0);
      const nextSeq = Math.max(item.nextSeq, lastSeq + 1);

      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });

      const record: SessionRecord = {
        info: { ...item.info, queued: 0, pendingPermissions: 0 },
        controller: new AbortController(),
        buffer,
        nextSeq,
        version: 0,
        listeners: new Set(),
        done,
        settle,
        pending: new Map(),
        permissionTimeoutMs: this.permissionTimeoutMs,
        queue: [],
      };
      if (item.sdkSessionId !== undefined) {
        record.sdkSessionId = item.sdkSessionId;
      }
      this.sessions.set(record.info.id, record);

      if (record.info.status === "berjalan") {
        record.info.status = "gagal";
        this.append(record, { type: "error", message: "server dimulai ulang saat sesi berjalan" });
        this.append(record, {
          type: "result",
          ok: false,
          error: "server dimulai ulang saat sesi berjalan",
        });
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
      }
    }

    // Urutkan agar eviksi (paling lama) bekerja seperti urutan createdAt.
    const ordered = Array.from(this.sessions.values()).sort((a, b) =>
      a.info.createdAt.localeCompare(b.info.createdAt),
    );
    this.sessions.clear();
    for (const record of ordered) {
      this.sessions.set(record.info.id, record);
    }

    while (this.sessions.size > this.maxSessions) {
      const victim = this.sessions.values().next().value as SessionRecord | undefined;
      if (victim === undefined) break;
      this.sessions.delete(victim.info.id);
      this.storeGuard(() => store.deleteSession(victim.info.id));
    }
  }

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    const validated = await this.validate(input);
    this.ensureCapacity();

    let resolved: ResolvedProvider;
    try {
      resolved = await this.resolveProvider(input.selection ?? {});
    } catch (error) {
      throw new SessionError(errorMessage(error), "tidak-valid");
    }

    // Periksa lagi setelah await agar pembuatan serentak tidak melewati batas.
    this.ensureCapacity();

    const timestamp = this.now().toISOString();
    const info: SessionInfo = {
      id: `s_${crypto.randomUUID().slice(0, 8)}`,
      title: validated.title,
      prompt: validated.prompt,
      cwd: validated.cwd,
      profileId: resolved.profileId,
      permissionMode: validated.permissionMode,
      status: "berjalan",
      createdAt: timestamp,
      updatedAt: timestamp,
      eventCount: 0,
      pendingPermissions: 0,
      queued: 0,
    };
    if (resolved.model !== undefined) {
      info.model = resolved.model;
    }

    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const record: SessionRecord = {
      info,
      apiKey: resolved.apiKey,
      controller: new AbortController(),
      buffer: [],
      nextSeq: 1,
      version: 0,
      listeners: new Set(),
      done,
      settle,
      pending: new Map(),
      permissionTimeoutMs: this.permissionTimeoutMs,
      price: resolved.price,
      resolved,
      queue: [],
    };
    this.sessions.set(info.id, record);
    this.persistSession(record);

    this.startTurn(record, validated.prompt, false);

    return { ...info };
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .reverse()
      .map((record) => ({ ...record.info }));
  }

  get(id: string): SessionInfo | undefined {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : { ...record.info };
  }

  async *events(
    id: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<SequencedEvent> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }

    const requested = options.after ?? 0;
    let cursor = Number.isFinite(requested) ? requested : 0;
    const signal = options.signal;

    while (true) {
      if (isAborted(signal)) return;
      const version = record.version;

      for (const item of record.buffer) {
        if (item.seq <= cursor) continue;
        cursor = item.seq;
        yield item;
        if (isAborted(signal)) return;
      }

      if (record.info.status !== "berjalan") return;
      await waitForChange(record, version, signal);
    }
  }

  async send(id: string, text: string): Promise<{ queued: boolean }> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }

    const message = this.validateMessage(text);

    if (record.info.status === "berjalan") {
      if (record.queue.length >= MAX_QUEUED_MESSAGES) {
        throw new SessionError(
          `Antrean pesan penuh; maksimal ${MAX_QUEUED_MESSAGES} pesan.`,
          "penuh",
        );
      }
      record.queue.push(message);
      record.info.queued = record.queue.length;
      this.persistSession(record);
      this.notify(record);
      return { queued: true };
    }

    if (record.sdkSessionId === undefined) {
      throw new SessionError(
        "Sesi ini belum punya riwayat untuk dilanjutkan.",
        "tidak-valid",
      );
    }

    if (record.resolved === undefined) {
      let resolved: ResolvedProvider;
      try {
        resolved = await this.resolveProvider({
          profileId: record.info.profileId,
          model: record.info.model,
        });
      } catch (error) {
        throw new SessionError(errorMessage(error), "tidak-valid");
      }
      record.resolved = resolved;
      record.apiKey = resolved.apiKey;
      record.price = resolved.price;
    }

    this.assertConcurrencyCapacity();
    this.startTurn(record, message, true);
    return { queued: false };
  }

  interrupt(id: string): boolean {
    const record = this.sessions.get(id);
    if (record === undefined || record.info.status !== "berjalan") {
      return false;
    }
    record.controller.abort();
    this.clearQueue(record);
    return true;
  }

  done(id: string): Promise<void> {
    const record = this.sessions.get(id);
    return record === undefined ? Promise.resolve() : record.done;
  }

  private async validate(input: CreateSessionInput): Promise<{
    prompt: string;
    cwd: string;
    title: string;
    permissionMode: SessionPermissionMode;
  }> {
    if (typeof input.prompt !== "string") {
      throw new SessionError("Prompt harus berupa teks.", "tidak-valid");
    }
    const prompt = input.prompt.trim();
    if (prompt === "") {
      throw new SessionError("Prompt tidak boleh kosong.", "tidak-valid");
    }
    if (prompt.length > this.maxPromptLength) {
      throw new SessionError(
        `Prompt terlalu panjang; maksimal ${this.maxPromptLength} karakter.`,
        "tidak-valid",
      );
    }

    if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
      throw new SessionError("cwd harus berupa path absolut yang ada.", "tidak-valid");
    }
    const cwd = input.cwd.trim();
    if (!isAbsolute(cwd)) {
      throw new SessionError("cwd harus berupa path absolut.", "tidak-valid");
    }
    let cwdIsDirectory = false;
    try {
      cwdIsDirectory = (await stat(cwd)).isDirectory();
    } catch {
      cwdIsDirectory = false;
    }
    if (!cwdIsDirectory) {
      throw new SessionError(`cwd "${cwd}" tidak ditemukan atau bukan direktori.`, "tidak-valid");
    }

    let permissionMode: SessionPermissionMode = "default";
    if (input.permissionMode !== undefined) {
      const requested = input.permissionMode;
      if (!PERMISSION_MODES.includes(requested as SessionPermissionMode)) {
        throw new SessionError(`Mode izin "${String(requested)}" belum didukung.`, "tidak-valid");
      }
      permissionMode = requested as SessionPermissionMode;
    }

    let title = "";
    if (typeof input.title === "string") {
      title = input.title.trim();
    }
    if (title === "") {
      title = collapseWhitespace(prompt).slice(0, 60).trimEnd();
    }

    return { prompt, cwd, title, permissionMode };
  }

  private validateMessage(text: string): string {
    if (typeof text !== "string") {
      throw new SessionError("Pesan harus berupa teks.", "tidak-valid");
    }
    const message = text.trim();
    if (message === "") {
      throw new SessionError("Pesan tidak boleh kosong.", "tidak-valid");
    }
    if (message.length > this.maxPromptLength) {
      throw new SessionError(
        `Pesan terlalu panjang; maksimal ${this.maxPromptLength} karakter.`,
        "tidak-valid",
      );
    }
    return message;
  }

  private assertConcurrencyCapacity(): void {
    const running = Array.from(this.sessions.values()).filter(
      (record) => record.info.status === "berjalan",
    ).length;
    if (running >= this.maxConcurrent) {
      throw new SessionError("Terlalu banyak sesi berjalan; coba lagi nanti.", "penuh");
    }
  }

  private ensureCapacity(): void {
    this.assertConcurrencyCapacity();

    while (this.sessions.size >= this.maxSessions) {
      const victim = Array.from(this.sessions.values()).find(
        (record) => record.info.status !== "berjalan",
      );
      if (victim === undefined) {
        throw new SessionError("Kapasitas sesi penuh; tidak ada sesi selesai untuk dibuang.", "penuh");
      }
      this.sessions.delete(victim.info.id);
      const id = victim.info.id;
      this.storeGuard(() => this.store?.deleteSession(id));
    }
  }

  private clearQueue(record: SessionRecord): void {
    if (record.queue.length === 0 && record.info.queued === 0) {
      return;
    }
    record.queue.length = 0;
    record.info.queued = 0;
    this.persistSession(record);
    this.notify(record);
  }

  private startTurn(record: SessionRecord, text: string, isFollowUp: boolean): void {
    record.controller = new AbortController();
    let settle: () => void = () => {};
    record.done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    record.settle = settle;

    this.setStatus(record, "berjalan");
    if (isFollowUp) {
      this.append(record, { type: "user_message", text });
    }

    const resolved = record.resolved;
    if (resolved === undefined) {
      this.append(record, { type: "error", message: "provider belum diselesaikan" });
      this.append(record, { type: "result", ok: false, error: "provider belum diselesaikan" });
      this.setStatus(record, "gagal");
      record.settle();
      return;
    }

    void this.execute(
      record,
      text,
      resolved,
      record.info.permissionMode,
      record.sdkSessionId,
    );
  }

  private async execute(
    record: SessionRecord,
    prompt: string,
    provider: ResolvedProvider,
    permissionMode: SessionPermissionMode,
    resumeSessionId: string | undefined,
  ): Promise<void> {
    let sawResult = false;
    const input: Parameters<AgentRunner["run"]>[0] = {
      prompt,
      cwd: record.info.cwd,
      provider,
      permissionMode: permissionMode as PermissionMode,
      signal: record.controller.signal,
      requestPermission: (request) => this.requestPermission(record, request),
    };
    if (resumeSessionId !== undefined) {
      input.resumeSessionId = resumeSessionId;
    }
    try {
      const events = this.runner.run(input);

      for await (const event of events) {
        if (event.type === "session" && record.sdkSessionId === undefined) {
          record.sdkSessionId = event.sessionId;
          this.persistSession(record);
        }
        if (event.type === "result") {
          sawResult = true;
          if (record.price !== undefined) {
            event.estimatedCostUsd = estimateCostUsd(event, record.price);
          }
          this.append(record, event);
          this.setStatus(
            record,
            event.ok ? "selesai" : event.error === "dibatalkan" ? "dibatalkan" : "gagal",
          );
          return;
        }
        this.append(record, event);
      }

      if (!sawResult) {
        sawResult = true;
        this.append(record, { type: "error", message: "sesi berakhir tanpa hasil" });
        this.append(record, { type: "result", ok: false, error: "sesi berakhir tanpa hasil" });
        this.setStatus(record, "gagal");
      }
    } catch (error) {
      if (!sawResult) {
        sawResult = true;
        const message = sanitizeText(errorMessage(error), record.apiKey) || "sesi gagal";
        this.append(record, { type: "error", message });
        this.append(record, { type: "result", ok: false, error: message });
        this.setStatus(record, "gagal");
      }
    } finally {
      if (record.info.status === "berjalan") {
        this.setStatus(record, "gagal");
      }
      record.settle();
      this.notify(record);

      if (record.info.status === "dibatalkan" || record.info.status === "gagal") {
        this.clearQueue(record);
      } else if (record.queue.length > 0) {
        const next = record.queue.shift()!;
        record.info.queued = record.queue.length;
        this.startTurn(record, next, true);
      }
    }
  }

  private append(record: SessionRecord, event: AgentEvent): void {
    const stored: SequencedEvent = {
      seq: record.nextSeq,
      event: sanitizeEvent(event, record.apiKey),
    };
    record.nextSeq += 1;
    record.buffer.push(stored);
    const trimmed = record.buffer.length > this.maxEventsPerSession;
    if (trimmed) {
      record.buffer.splice(0, record.buffer.length - this.maxEventsPerSession);
    }
    record.info.eventCount += 1;
    record.info.updatedAt = this.now().toISOString();
    this.storeGuard(() => this.store?.appendEvent(record.info.id, stored));
    if (trimmed) {
      const oldest = record.buffer[0]?.seq ?? record.nextSeq;
      this.storeGuard(() => this.store?.trimEvents(record.info.id, oldest));
    }

    // Accumulate usage for result events
    if (event.type === "result") {
      if (event.inputTokens !== undefined || event.outputTokens !== undefined || event.cacheReadTokens !== undefined || event.cacheWriteTokens !== undefined) {
        if (record.info.usage === undefined) {
          record.info.usage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
        }
        if (event.inputTokens !== undefined) {
          record.info.usage.inputTokens += event.inputTokens;
        }
        if (event.outputTokens !== undefined) {
          record.info.usage.outputTokens += event.outputTokens;
        }
        if (event.cacheReadTokens !== undefined) {
          record.info.usage.cacheReadTokens += event.cacheReadTokens;
        }
        if (event.cacheWriteTokens !== undefined) {
          record.info.usage.cacheWriteTokens += event.cacheWriteTokens;
        }
        if (event.estimatedCostUsd !== undefined) {
          if (record.info.usage.estimatedCostUsd === undefined) {
            record.info.usage.estimatedCostUsd = 0;
          }
          record.info.usage.estimatedCostUsd += event.estimatedCostUsd;
        }
        if (event.costUsd !== undefined) {
          if (record.info.usage.sdkCostUsd === undefined) {
            record.info.usage.sdkCostUsd = 0;
          }
          record.info.usage.sdkCostUsd += event.costUsd;
        }
      }
    }

    this.persistSession(record);
    this.notify(record);
  }

  private setStatus(record: SessionRecord, status: SessionStatus): void {
    record.info.status = status;
    this.persistSession(record);
    this.notify(record);
  }

  private notify(record: SessionRecord): void {
    record.version += 1;
    for (const listener of Array.from(record.listeners)) {
      listener();
    }
  }

  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  private async requestPermission(
    record: SessionRecord,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const requestId = this.generateRequestId();

    // Create a promise that resolves when the permission is granted or denied
    const pending: Pending = {
      resolve: () => {},
      name: request.name,
    };

    const promise = new Promise<PermissionDecision>((resolve) => {
      pending.resolve = resolve;
      record.pending.set(requestId, pending);

      // Update pendingPermissions count
      record.info.pendingPermissions += 1;
      record.info.updatedAt = this.now().toISOString();
      this.persistSession(record);
      this.notify(record);
    });

    // Add event to buffer
    const permissionRequestEvent: AgentEvent = {
      type: "permission_request",
      id: requestId,
      toolUseId: request.toolUseId,
      name: request.name,
      input: request.input,
      expiresAt: new Date(this.now().getTime() + record.permissionTimeoutMs).toISOString(),
    };

    this.append(record, permissionRequestEvent);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (record.pending.has(requestId)) {
        const denyEvent: AgentEvent = {
          type: "permission_resolved",
          id: requestId,
          decision: "deny",
          message: PERMISSION_EXPIRED_MESSAGE,
        };

        record.pending.delete(requestId);
        record.info.pendingPermissions -= 1;
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
        this.notify(record);

        this.append(record, denyEvent);

        pending.resolve({ behavior: "deny", message: PERMISSION_EXPIRED_MESSAGE });
      }
    }, record.permissionTimeoutMs);

    // Set up abort handler
    const abortHandler = (): void => {
      if (record.pending.has(requestId)) {
        const denyEvent: AgentEvent = {
          type: "permission_resolved",
          id: requestId,
          decision: "deny",
          message: PERMISSION_STOPPED_MESSAGE,
        };

        record.pending.delete(requestId);
        record.info.pendingPermissions -= 1;
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
        this.notify(record);

        this.append(record, denyEvent);

        pending.resolve({ behavior: "deny", message: PERMISSION_STOPPED_MESSAGE });
      }
      clearTimeout(timeoutId);
    };

    record.controller.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      return await promise;
    } finally {
      // Clean up abort handler
      record.controller.signal.removeEventListener("abort", abortHandler);
      clearTimeout(timeoutId);
    }
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
  ): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionError("sesi tidak ditemukan", "tidak-ditemukan");
    }

    const pending = record.pending.get(requestId);
    if (pending === undefined) {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }

    // Remove from pending map
    record.pending.delete(requestId);

    // Update pendingPermissions count
    record.info.pendingPermissions -= 1;
    record.info.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);

    // Create resolved event
    const resolvedEvent: AgentEvent = {
      type: "permission_resolved",
      id: requestId,
      decision,
      message: message ? collapseWhitespace(message).substring(0, 200) : undefined,
    };

    this.append(record, resolvedEvent);

    // Resolve the pending promise
    if (decision === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({
        behavior: "deny",
        message: message ? collapseWhitespace(message).substring(0, 200) : "ditolak pengguna",
      });
    }
  }
}
