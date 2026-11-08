import type { RunMemory } from "../agent/events";
import { mcpRoutes, McpTokenRegistry } from "./mcp-http";
import { MemoryTools, projectKeyFor } from "./memory-tools";
import type { MemoryService } from "./memory-service";

export interface MemoryBridgeOpenInput {
  sessionId: string;
  cwd: string;
}

export interface OpenedMemory {
  memory: RunMemory;
  close(): void;
}

export interface MemoryBridge {
  open(input: MemoryBridgeOpenInput): Promise<OpenedMemory>;
}

export interface MemoryBridgeOptions {
  service: MemoryService;
  mcpUrl?: string;
}

export function createMemoryBridge(options: MemoryBridgeOptions): {
  bridge: MemoryBridge;
  routes: ReturnType<typeof mcpRoutes>;
} {
  const tools = new MemoryTools(options.service);
  const registry = new McpTokenRegistry();

  const bridge: MemoryBridge = {
    async open(input) {
      const projectKey = await projectKeyFor(input.cwd);
      const issued = registry.issue({
        sessionId: input.sessionId,
        projectKey,
        cwd: input.cwd,
      });
      const ctx = { sessionId: input.sessionId, projectKey, cwd: input.cwd };
      const memory: RunMemory = {
        indexLine: await tools.indexLine(ctx),
        call: (name, args) => tools.call(ctx, name, args),
      };
      if (options.mcpUrl !== undefined) memory.url = options.mcpUrl;
      memory.token = issued.token;
      return { memory, close: () => issued.revoke() };
    },
  };

  return { bridge, routes: mcpRoutes({ tools, registry }) };
}
