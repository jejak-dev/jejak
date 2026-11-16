import { Elysia } from "elysia";
import type { ProviderSelection } from "../provider";
import type { ScheduledTask, ScheduledTaskService } from "../sessions/scheduled-tasks";
import {
  SessionError,
  type CreateSessionInput,
} from "../sessions/session-manager";
import { parseCreateBody, parseJsonBody } from "./sessions";

export interface ScheduleRoutesOptions {
  service: ScheduledTaskService;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SessionError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "penuh"
          ? 429
          : error.code === "konflik"
            ? 409
            : 400;
    return jsonResponse(status, { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function invalid(message: string): SessionError {
  return new SessionError(message, "tidak-valid");
}

/** Body permintaan harus berupa objek JSON. */
function parseObject(body: unknown): Record<string, unknown> {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Body permintaan harus berupa objek.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Bagian input sesi yang boleh dikirim pada perubahan tugas: hanya field
 * yang disebut yang berubah; sisanya tetap.
 */
function parsePatchInput(record: Record<string, unknown>): Partial<CreateSessionInput> {
  const input: Partial<CreateSessionInput> = {};

  if (record.prompt !== undefined) {
    if (typeof record.prompt !== "string") {
      throw invalid("Field prompt harus berupa string.");
    }
    input.prompt = record.prompt;
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string") {
      throw invalid("Field cwd harus berupa string.");
    }
    input.cwd = record.cwd;
  }
  if (record.title !== undefined) {
    if (typeof record.title !== "string") {
      throw invalid("Field title harus berupa string.");
    }
    input.title = record.title;
  }
  if (record.workspaceId !== undefined) {
    if (typeof record.workspaceId !== "string") {
      throw invalid("Field workspaceId harus berupa string.");
    }
    input.workspaceId = record.workspaceId;
  }
  if (record.permissionMode !== undefined) {
    if (typeof record.permissionMode !== "string") {
      throw invalid("Field permissionMode harus berupa string.");
    }
    input.permissionMode = record.permissionMode;
  }
  if (record.confirmBypass !== undefined) {
    if (typeof record.confirmBypass !== "boolean") {
      throw invalid("Field confirmBypass harus berupa boolean.");
    }
    input.confirmBypass = record.confirmBypass;
  }
  if (record.worktree !== undefined) {
    if (typeof record.worktree !== "boolean") {
      throw invalid("Field worktree harus berupa boolean.");
    }
    input.worktree = record.worktree;
  }
  if (record.sandbox !== undefined) {
    if (record.sandbox !== "standar" && record.sandbox !== "mati") {
      throw invalid('Field sandbox hanya "standar" atau "mati".');
    }
    input.sandbox = record.sandbox;
  }

  const selection: ProviderSelection = {};
  for (const key of ["profileId", "model", "lightModel"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw invalid(`Field ${key} harus berupa string.`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") selection[key] = trimmed;
  }
  if (Object.keys(selection).length > 0) input.selection = selection;

  return input;
}

/** Bentuk tugas untuk klien. */
function toView(task: ScheduledTask): ScheduledTask {
  return { ...task, input: { ...task.input } };
}

export function scheduleRoutes(options: ScheduleRoutesOptions): Elysia {
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-schedule-routes" })
    .get("/api/schedules", () => {
      return { tasks: service.list().map(toView) };
    })
    .post(
      "/api/schedules",
      async ({ body }) => {
        try {
          const record = parseObject(body);
          // Bagian sesi dibaca dengan parser yang sama seperti saat membuat
          // sesi; jadwal dan nama dibaca terpisah.
          const input = parseCreateBody(body);
          const task = await service.create({
            name: record.name,
            spec: record.spec,
            enabled: record.enabled,
            input,
          });
          return jsonResponse(201, { task: toView(task) });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/schedules/:id",
      async ({ params, body }) => {
        try {
          const record = parseObject(body);
          const patch: {
            name?: unknown;
            spec?: unknown;
            enabled?: unknown;
            input?: Partial<CreateSessionInput>;
          } = {};
          if (record.name !== undefined) patch.name = record.name;
          if (record.spec !== undefined) patch.spec = record.spec;
          if (record.enabled !== undefined) patch.enabled = record.enabled;
          const input = parsePatchInput(record);
          if (Object.keys(input).length > 0) patch.input = input;
          const task = await service.update(params.id, patch);
          return jsonResponse(200, { task: toView(task) });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete(
      "/api/schedules/:id",
      ({ params }) => {
        try {
          service.delete(params.id);
          return jsonResponse(200, { ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/schedules/:id/run",
      async ({ params }) => {
        try {
          const task = await service.runNow(params.id);
          return jsonResponse(200, { task: toView(task) });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
