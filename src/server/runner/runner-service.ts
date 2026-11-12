import { resolve } from "node:path";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { redactSecrets } from "../security/redact";
import { TerminalError } from "../terminal/terminal-manager";
import { readPackageScripts } from "./package-scripts";
import {
  hasControlChar,
  hashCommand,
  newCustomId,
  RUNNER_COMMAND_MAX,
  RUNNER_CUSTOM_MAX,
  RUNNER_GROUP_MAX,
  RUNNER_LABEL_MAX,
  type RunnerCustomCommand,
  type RunnerStore,
} from "./runner-store";

export type RunnerErrorCode =
  | "tidak-valid"
  | "tidak-ditemukan"
  | "konflik"
  | "nonaktif"
  | "batas";

export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly code: RunnerErrorCode,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

/** Pesan sama dengan rute terminal; dipakai saat terminal dimatikan. */
export const TERMINAL_DISABLED =
  "Terminal dimatikan. Jalankan Jejak dengan JEJAK_TERMINAL=1 untuk menyalakannya.";

export type RunnerSource = "package" | "custom";

export interface RunnerCommand {
  id: string;
  label: string;
  command: string;
  group?: string;
  source: RunnerSource;
  confirmed: boolean;
  /** Isi script package apa adanya (yang benar-benar dijalankan), untuk konfirmasi. */
  detail?: string;
}

/** Bagian terminal yang dipakai; `TerminalManager` memenuhi kontrak ini. */
export interface RunnerTerminal {
  create(input: { cwd: unknown; cols?: unknown; rows?: unknown }): { id: string; cwd: string };
  write(id: string, data: unknown): void;
}

export interface RunnerServiceOptions {
  store: RunnerStore;
  terminal?: RunnerTerminal;
  /** Daftar folder yang boleh dipakai (cwd sesi dan worktree). */
  allowedCwds: () => string[];
  audit?: AuditStore;
}

function invalid(message: string): RunnerError {
  return new RunnerError(message, "tidak-valid");
}

function notFound(message: string): RunnerError {
  return new RunnerError(message, "tidak-ditemukan");
}

/** Normalisasi path tanpa menyentuh berkas (tanpa symlink). */
function normalizePath(value: string): string {
  return resolve(value);
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string") throw invalid("Field label harus berupa teks.");
  if (hasControlChar(value)) throw invalid("Field label tidak boleh memuat karakter kontrol.");
  const label = value.trim();
  if (label === "") throw invalid("Field label wajib diisi.");
  if (label.length > RUNNER_LABEL_MAX) {
    throw invalid(`Field label maksimal ${RUNNER_LABEL_MAX} karakter.`);
  }
  return label;
}

function validateCommand(value: unknown): string {
  if (typeof value !== "string") throw invalid("Field command harus berupa teks.");
  // Karakter kontrol diperiksa pada teks mentah: `trim` membuang newline di tepi.
  if (hasControlChar(value)) {
    throw invalid("Field command harus satu baris tanpa karakter kontrol.");
  }
  const command = value.trim();
  if (command === "") throw invalid("Field command wajib diisi.");
  if (command.length > RUNNER_COMMAND_MAX) {
    throw invalid(`Field command maksimal ${RUNNER_COMMAND_MAX} karakter.`);
  }
  return command;
}

function validateGroup(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalid("Field group harus berupa teks.");
  if (hasControlChar(value)) throw invalid("Field group tidak boleh memuat karakter kontrol.");
  const group = value.trim();
  if (group === "") return undefined;
  if (group.length > RUNNER_GROUP_MAX) {
    throw invalid(`Field group maksimal ${RUNNER_GROUP_MAX} karakter.`);
  }
  return group;
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("Field id wajib diisi.");
  }
  return value.trim();
}

/** Terjemahkan galat terminal ke galat runner. */
function fromTerminalError(error: unknown): RunnerError {
  if (error instanceof TerminalError) {
    if (error.code === "batas") return new RunnerError(error.message, "batas");
    if (error.code === "tidak-ditemukan") return notFound(error.message);
    return invalid(error.message);
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return invalid(message);
}

/**
 * Hash konfirmasi. Perintah kustom memakai teks perintahnya; script package
 * ikut memuat isi script sehingga edit `package.json` membatalkan konfirmasi.
 */
function confirmationHash(command: string, body?: string): string {
  return body === undefined ? hashCommand(command) : hashCommand(`${command}\n${body}`);
}

export class RunnerService {
  private readonly store: RunnerStore;
  private readonly terminal: RunnerTerminal | undefined;
  private readonly allowedCwds: () => string[];
  private readonly audit: AuditStore | undefined;

  constructor(options: RunnerServiceOptions) {
    this.store = options.store;
    this.terminal = options.terminal;
    this.allowedCwds = options.allowedCwds;
    this.audit = options.audit;
  }

  /** Folder yang diminta harus ada di daftar folder sesi. */
  private requireCwd(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid("Field cwd wajib diisi.");
    }
    const cwd = normalizePath(value.trim());
    const allowed = this.allowedCwds().map((path) => normalizePath(path));
    if (!allowed.includes(cwd)) {
      throw notFound("Folder tidak dikenal.");
    }
    return cwd;
  }

  /** Daftar perintah folder: script package lebih dulu, lalu perintah kustom. */
  list(cwd: unknown): RunnerCommand[] {
    return this.resolve(cwd).map((item) => {
      const copy: RunnerCommand = {
        id: item.id,
        label: item.label,
        command: item.command,
        source: item.source,
        confirmed: item.confirmed,
      };
      if (item.group !== undefined) copy.group = item.group;
      if (item.body !== undefined) copy.detail = item.body;
      return copy;
    });
  }

  /** Daftar lengkap; script package membawa isi script untuk hash konfirmasi. */
  private resolve(cwd: unknown): Array<RunnerCommand & { body?: string }> {
    const path = this.requireCwd(cwd);
    const folder = this.store.read(path);
    const result: Array<RunnerCommand & { body?: string }> = [];
    for (const script of readPackageScripts(path)) {
      result.push({
        id: script.id,
        label: script.label,
        command: script.command,
        source: "package",
        confirmed:
          folder.confirmed[script.id] === confirmationHash(script.command, script.body),
        body: script.body,
      });
    }
    for (const item of folder.custom) {
      result.push({
        id: item.id,
        label: item.label,
        command: item.command,
        ...(item.group === undefined ? {} : { group: item.group }),
        source: "custom",
        confirmed: folder.confirmed[item.id] === hashCommand(item.command),
      });
    }
    return result;
  }

  addCustom(input: {
    cwd: unknown;
    label: unknown;
    command: unknown;
    group?: unknown;
  }): RunnerCommand {
    const cwd = this.requireCwd(input.cwd);
    const label = validateLabel(input.label);
    const command = validateCommand(input.command);
    const group = validateGroup(input.group);
    const folder = this.store.read(cwd);
    if (folder.custom.length >= RUNNER_CUSTOM_MAX) {
      throw new RunnerError(
        `Batas ${RUNNER_CUSTOM_MAX} perintah kustom per folder tercapai.`,
        "batas",
      );
    }
    const item: RunnerCustomCommand = {
      id: newCustomId(),
      label,
      command,
      ...(group === undefined ? {} : { group }),
    };
    folder.custom.push(item);
    this.store.write(cwd, folder);
    this.note("runner-tambah", "Perintah ditambah", item, "custom", cwd);
    return {
      id: item.id,
      label: item.label,
      command: item.command,
      ...(group === undefined ? {} : { group }),
      source: "custom",
      confirmed: false,
    };
  }

  updateCustom(input: {
    cwd: unknown;
    id: unknown;
    label?: unknown;
    command?: unknown;
    group?: unknown;
  }): RunnerCommand {
    const cwd = this.requireCwd(input.cwd);
    const id = validateId(input.id);
    const folder = this.store.read(cwd);
    const item = folder.custom.find((candidate) => candidate.id === id);
    if (item === undefined) throw notFound(`Perintah "${id}" tidak ditemukan.`);

    if (input.label !== undefined) item.label = validateLabel(input.label);
    if (input.command !== undefined) {
      const command = validateCommand(input.command);
      // Teks perintah berubah: konfirmasi lama tidak berlaku lagi.
      if (command !== item.command) delete folder.confirmed[id];
      item.command = command;
    }
    if (input.group !== undefined) {
      const group = validateGroup(input.group);
      if (group === undefined) delete item.group;
      else item.group = group;
    }
    this.store.write(cwd, folder);
    this.note("runner-ubah", "Perintah diubah", item, "custom", cwd);
    return {
      id: item.id,
      label: item.label,
      command: item.command,
      ...(item.group === undefined ? {} : { group: item.group }),
      source: "custom",
      confirmed: folder.confirmed[id] === hashCommand(item.command),
    };
  }

  deleteCustom(input: { cwd: unknown; id: unknown }): void {
    const cwd = this.requireCwd(input.cwd);
    const id = validateId(input.id);
    const folder = this.store.read(cwd);
    const index = folder.custom.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw notFound(`Perintah "${id}" tidak ditemukan.`);
    const [item] = folder.custom.splice(index, 1);
    delete folder.confirmed[id];
    this.store.write(cwd, folder);
    if (item !== undefined) {
      this.note("runner-hapus", "Perintah dihapus", item, "custom", cwd);
    }
  }

  /** Jalankan perintah: teks perintah selalu berasal dari daftar server. */
  run(input: { cwd: unknown; id: unknown; confirm?: unknown }): { terminalId: string } {
    const cwd = this.requireCwd(input.cwd);
    const id = validateId(input.id);
    if (input.confirm !== undefined && typeof input.confirm !== "boolean") {
      throw invalid("Field confirm harus berupa boolean.");
    }

    const target = this.resolve(cwd).find((command) => command.id === id);
    if (target === undefined) throw notFound(`Perintah "${id}" tidak ditemukan.`);

    const hash = confirmationHash(target.command, target.body);
    const folder = this.store.read(cwd);
    if (folder.confirmed[id] !== hash && input.confirm !== true) {
      throw new RunnerError("Perintah belum dikonfirmasi.", "konflik");
    }
    if (input.confirm === true && folder.confirmed[id] !== hash) {
      folder.confirmed[id] = hash;
      this.store.write(cwd, folder);
    }

    const terminal = this.terminal;
    if (terminal === undefined) throw new RunnerError(TERMINAL_DISABLED, "nonaktif");

    let terminalId: string;
    try {
      const info = terminal.create({ cwd });
      terminalId = info.id;
      terminal.write(info.id, `${target.command}\n`);
    } catch (error) {
      throw fromTerminalError(error);
    }

    this.note(
      "runner-jalankan",
      "Perintah dijalankan",
      { id: target.id, label: target.label, command: target.command },
      target.source,
      cwd,
      hash,
    );
    return { terminalId };
  }

  /** Catat audit; teks perintah dipotong dan melewati redaksi rahasia. */
  private note(
    aksi: string,
    summary: string,
    item: { id: string; label: string; command: string },
    source: RunnerSource,
    cwd: string,
    hash: string = hashCommand(item.command),
  ): void {
    recordAudit(this.audit, {
      kind: "pengaturan",
      summary,
      meta: {
        aksi,
        id: item.id,
        source,
        hash,
        cwd,
        perintah: redactSecrets(item.command).text.slice(0, 200),
      },
    });
  }
}
