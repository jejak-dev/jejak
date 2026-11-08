import { Elysia } from "elysia";
import {
  isMcpServerId,
  mcpServersPath,
  type McpProblem,
} from "../mcp/mcp-config";
import {
  McpServerError,
  McpServerService,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from "../mcp/mcp-service";
import { testMcpServer, testTargetOf, type McpTestResult } from "../mcp/mcp-tester";

export interface McpServerRoutesOptions {
  service?: McpServerService;
  fetch?: typeof fetch;
}

const DISABLED = "Server MCP dimatikan.";

const CREATE_KEYS = [
  "name",
  "transport",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "enabled",
] as const;

const UPDATE_KEYS = CREATE_KEYS;

export function defaultMcpServerService(
  env: Record<string, string | undefined> = process.env,
): McpServerService | undefined {
  if (env.JEJAK_MCP_SERVERS?.trim() === "0") {
    return undefined;
  }
  return new McpServerService({ path: mcpServersPath(env) });
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

function errorStatus(error: McpServerError): number {
  if (error.code === "tidak-ditemukan") return 404;
  if (error.code === "konflik") return 409;
  return 400;
}

function errorResponse(error: unknown): Response {
  if (error instanceof McpServerError) {
    return jsonResponse(errorStatus(error), { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

function parseObjectBody(
  body: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  let parsed: unknown;
  if (typeof body === "string") {
    if (body.trim() === "") {
      throw new McpServerError("Body permintaan harus berupa JSON.", "tidak-valid");
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpServerError(
        "Body permintaan harus berupa JSON yang valid.",
        "tidak-valid",
      );
    }
  } else {
    parsed = body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpServerError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new McpServerError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function notFoundId(id: string): McpServerError {
  return new McpServerError(`Server MCP "${id}" tidak ditemukan.`, "tidak-ditemukan");
}

function checkId(id: string): void {
  if (!isMcpServerId(id)) throw notFoundId(id);
}

export function mcpServerRoutes(options: McpServerRoutesOptions = {}): Elysia {
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-mcp-server-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/mcp-servers", () => disabledResponse())
      .post("/api/mcp-servers", () => disabledResponse())
      .patch("/api/mcp-servers/:id", () => disabledResponse())
      .delete("/api/mcp-servers/:id", () => disabledResponse())
      .post("/api/mcp-servers/:id/test", () => disabledResponse()) as unknown as Elysia;
  }

  return plugin
    .get("/api/mcp-servers", async () => {
      try {
        const result = await service.list();
        return {
          items: result.items,
          problems: result.problems satisfies McpProblem[],
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/mcp-servers",
      async ({ body }) => {
        try {
          const input = parseObjectBody(body, CREATE_KEYS);
          const item = await service.create(input satisfies CreateMcpServerInput);
          return jsonResponse(201, { item });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/mcp-servers/:id",
      async ({ params, body }) => {
        try {
          checkId(params.id);
          const input = parseObjectBody(body, UPDATE_KEYS);
          const item = await service.update(params.id, input satisfies UpdateMcpServerInput);
          return { item };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/mcp-servers/:id", async ({ params }) => {
      try {
        checkId(params.id);
        await service.delete(params.id);
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/api/mcp-servers/:id/test", async ({ params }) => {
      try {
        checkId(params.id);
        const server = await service.get(params.id);
        if (server === undefined) {
          throw notFoundId(params.id);
        }
        const result = await testMcpServer(testTargetOf(server), {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return result satisfies McpTestResult;
      } catch (error) {
        return errorResponse(error);
      }
    }) as unknown as Elysia;
}