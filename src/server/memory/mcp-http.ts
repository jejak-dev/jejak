import { createHash, randomBytes } from "node:crypto";
import { Elysia } from "elysia";
import { VERSION } from "../../shared/version";
import { DEFAULT_ALLOWED_HOSTS, hostnameOf } from "../guard";

export const MCP_PATH = "/mcp";
export const MCP_BODY_MAX_BYTES = 64 * 1024;
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const TOOL_UNAVAILABLE = "Tool tidak tersedia.";

export interface McpToolContext {
  sessionId: string;
  projectKey: string;
  cwd: string;
  workspaceId?: string;
}

export type McpTokenContext = McpToolContext;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolOutcome {
  text: string;
  isError: boolean;
}

/** Kumpulan tool komposit: definisi dan panggilan dipilih per token. */
export interface McpToolSet {
  definitionsFor(ctx: McpToolContext): McpToolDefinition[];
  call(ctx: McpToolContext, name: string, args: unknown): Promise<McpToolOutcome>;
}

export interface IssuedMcpToken {
  token: string;
  revoke(): void;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Token acak per sesi; hanya hash SHA-256 yang disimpan di peta. */
export class McpTokenRegistry {
  private readonly tokens = new Map<string, McpTokenContext>();

  issue(ctx: McpTokenContext): IssuedMcpToken {
    const token = randomBytes(32).toString("hex");
    const key = sha256Hex(token);
    const stored: McpTokenContext = {
      sessionId: ctx.sessionId,
      projectKey: ctx.projectKey,
      cwd: ctx.cwd,
    };
    if (ctx.workspaceId !== undefined) stored.workspaceId = ctx.workspaceId;
    this.tokens.set(key, stored);
    let revoked = false;
    return {
      token,
      revoke: () => {
        if (revoked) return;
        revoked = true;
        this.tokens.delete(key);
      },
    };
  }

  lookup(token: string): McpTokenContext | undefined {
    if (typeof token !== "string" || token === "") return undefined;
    return this.tokens.get(sha256Hex(token));
  }
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse(200, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: id ?? null, result });
}

function bearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface McpRoutesOptions {
  tools: McpToolSet;
  registry: McpTokenRegistry;
  allowedHosts?: string[];
}

export function mcpRoutes(options: McpRoutesOptions): Elysia {
  const tools = options.tools;
  const registry = options.registry;
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.trim().toLowerCase()),
  );

  async function handle(request: Request, raw: string): Promise<Response> {
    const url = new URL(request.url);
    const rawHost = request.headers.get("host")?.trim() || url.host;
    if (!allowedHosts.has(hostnameOf(rawHost))) {
      return jsonResponse(403, { error: "host tidak diizinkan" });
    }
    if (request.headers.get("origin") !== null) {
      return jsonResponse(403, { error: "origin tidak diizinkan" });
    }

    const token = bearerToken(request.headers.get("authorization"));
    const ctx: McpTokenContext | undefined =
      token === undefined ? undefined : registry.lookup(token);
    if (ctx === undefined) {
      return jsonResponse(401, { error: "token tidak valid" });
    }

    const contentType = request.headers.get("content-type");
    if (
      contentType === null ||
      !contentType.trim().toLowerCase().startsWith("application/json")
    ) {
      return jsonResponse(415, { error: "content-type harus application/json" });
    }

    if (new TextEncoder().encode(raw).length > MCP_BODY_MAX_BYTES) {
      return jsonResponse(413, { error: "body terlalu besar" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (Array.isArray(payload)) {
      return rpcError(null, -32600, "Batch tidak didukung");
    }
    if (!isRecord(payload)) {
      return rpcError(null, -32600, "Request tidak valid");
    }

    const id = payload.id;
    const method = payload.method;
    if (typeof method !== "string") {
      return rpcError(id, -32600, "Method tidak valid");
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      const params = isRecord(payload.params) ? payload.params : {};
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : MCP_DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "jejak-memory", version: VERSION },
      });
    }

    if (method === "ping") {
      return rpcResult(id, {});
    }

    if (method === "tools/list") {
      return rpcResult(id, { tools: tools.definitionsFor(ctx) });
    }

    if (method === "tools/call") {
      const params = isRecord(payload.params) ? payload.params : {};
      const name = params.name;
      if (typeof name !== "string") {
        return rpcError(id, -32602, "Parameter name wajib berupa teks");
      }
      const available = tools.definitionsFor(ctx).some((tool) => tool.name === name);
      if (!available) {
        return rpcResult(id, {
          content: [{ type: "text", text: TOOL_UNAVAILABLE }],
          isError: true,
        });
      }
      const outcome = await tools.call(ctx, name, params.arguments);
      return rpcResult(id, {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
      });
    }

    return rpcError(id, -32601, "Method tidak dikenal");
  }

  return new Elysia({ name: "jejak-mcp-routes" })
    .post(MCP_PATH, async ({ request, body }) => {
      const raw = typeof body === "string" ? body : "";
      return handle(request, raw);
    }, { parse: "text" })
    .get(MCP_PATH, () => new Response(null, { status: 405 }))
    .delete(MCP_PATH, () => new Response(null, { status: 405 })) as unknown as Elysia;
}
