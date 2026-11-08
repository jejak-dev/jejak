import { Elysia } from "elysia";
import {
  WorkspaceError,
  WorkspaceService,
  type CreateWorkspaceInput,
  type SetCardInput,
  type UpdateWorkspaceInput,
} from "../workspaces/workspace-service";
import {
  isWorkspaceId,
  workspacesDir,
  type WorkspaceProblem,
} from "../workspaces/workspace-files";

export interface WorkspaceRoutesOptions {
  service?: WorkspaceService;
}

const DISABLED = "Workspace dimatikan.";

export function defaultWorkspaceService(
  env: Record<string, string | undefined> = process.env,
): WorkspaceService | undefined {
  if (env.JEJAK_WORKSPACES?.trim() === "0") {
    return undefined;
  }
  return new WorkspaceService({ dir: workspacesDir(env) });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, { error: DISABLED });
}

function errorStatus(error: WorkspaceError): number {
  if (error.code === "tidak-ditemukan") return 404;
  if (error.code === "konflik") return 409;
  return 400;
}

function errorResponse(error: unknown): Response {
  if (error instanceof WorkspaceError) {
    return jsonResponse(errorStatus(error), { error: error.message });
  }
  if (error instanceof SyntaxError) {
    return jsonResponse(400, { error: "Body permintaan harus berupa JSON yang valid." });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

function parseObjectBody(
  body: unknown,
  allowed: readonly string[],
  optional: boolean,
): Record<string, unknown> {
  if (body === undefined || body === null || (typeof body === "string" && body.trim() === "")) {
    if (optional) return {};
    throw new WorkspaceError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WorkspaceError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
    }
  } else {
    parsed = body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new WorkspaceError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function notFoundId(id: string): WorkspaceError {
  return new WorkspaceError(`Workspace "${id}" tidak ditemukan.`, "tidak-ditemukan");
}

function checkId(id: string): void {
  if (!isWorkspaceId(id)) throw notFoundId(id);
}

const CREATE_KEYS = ["name", "repos"] as const;
const UPDATE_KEYS = ["name", "repos"] as const;
const CARD_KEYS = ["description", "kind", "tables", "queues", "calls"] as const;

export function workspaceRoutes(options: WorkspaceRoutesOptions = {}): Elysia {
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-workspace-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/workspaces", () => disabledResponse())
      .post("/api/workspaces", () => disabledResponse())
      .patch("/api/workspaces/:id", () => disabledResponse())
      .put("/api/workspaces/:id/repos/:repoName/card", () => disabledResponse())
      .delete("/api/workspaces/:id", () => disabledResponse()) as unknown as Elysia;
  }

  return plugin
    .get("/api/workspaces", async () => {
      try {
        const result = await service.list();
        return {
          items: result.items,
          problems: result.problems satisfies WorkspaceProblem[],
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/workspaces",
      async ({ body }) => {
        try {
          const input = parseObjectBody(body, CREATE_KEYS, false);
          const item = await service.create({
            name: input.name,
            repos: input.repos,
          } satisfies CreateWorkspaceInput);
          return jsonResponse(201, { item });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/workspaces/:id",
      async ({ params, body }) => {
        try {
          checkId(params.id);
          const input = parseObjectBody(body, UPDATE_KEYS, false);
          const item = await service.update(params.id, {
            name: input.name,
            repos: input.repos,
          } satisfies UpdateWorkspaceInput);
          return { item };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .put(
      "/api/workspaces/:id/repos/:repoName/card",
      async ({ params, body }) => {
        try {
          checkId(params.id);
          const input = parseObjectBody(body, CARD_KEYS, false);
          const item = await service.setCard(params.id, params.repoName, {
            description: input.description,
            kind: input.kind,
            tables: input.tables,
            queues: input.queues,
            calls: input.calls,
          } satisfies SetCardInput);
          return { item };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/workspaces/:id", async ({ params }) => {
      try {
        checkId(params.id);
        await service.delete(params.id);
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    }) as unknown as Elysia;
}
