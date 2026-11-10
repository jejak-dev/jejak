import type { RunMemory } from "../agent/events";
import {
  mcpRoutes,
  McpTokenRegistry,
  type McpToolContext,
  type McpToolDefinition,
  type McpToolSet,
} from "./mcp-http";
import { MemoryTools, projectKeyFor } from "./memory-tools";
import type { MemoryService } from "./memory-service";
import { QuestionTools } from "../questions/question-tools";
import type { QuestionService } from "../questions/question-service";
import { WorkspaceTools, type WorkspaceToolSource } from "../workspaces/workspace-tools";

export interface MemoryBridgeOpenInput {
  sessionId: string;
  cwd: string;
  workspaceId?: string;
}

export interface OpenedMemory {
  memory: RunMemory;
  close(): void;
}

export interface MemoryBridge {
  open(input: MemoryBridgeOpenInput): Promise<OpenedMemory>;
}

export interface MemoryBridgeOptions {
  /** Tanpa `service`, hanya tool workspace yang tersedia. */
  service?: MemoryService;
  /** Tanpa `workspaces`, hanya tool memory yang tersedia. */
  workspaces?: WorkspaceToolSource;
  /** Tanpa `questions`, tool `question_ask` tidak ada. */
  questions?: QuestionService;
  mcpUrl?: string;
}

const QUESTION_INDEX_LINE =
  " Untuk pengetahuan yang tidak ada di kode (mis. tabel X ditulis service mana), ajukan pertanyaan terarah dengan question_ask; jawabannya dikonfirmasi manusia dan dicatat sebagai memory, jangan menebak.";

const WORKSPACE_INDEX_LINE =
  " Sesi ini punya workspace: gunakan workspace_overview untuk melihat repo dan workspace_service untuk kartu satu repo (hanya baca).";

/** Set komposit: tool memory hanya bila layanan memory ada, tool workspace hanya bila token punya workspace. */
function composeTools(
  memoryTools: MemoryTools | undefined,
  workspaceTools: WorkspaceTools | undefined,
  questionTools: QuestionTools | undefined,
): McpToolSet {
  return {
    definitionsFor(ctx: McpToolContext): McpToolDefinition[] {
      const definitions: McpToolDefinition[] = [];
      if (memoryTools !== undefined) definitions.push(...memoryTools.definitions);
      if (workspaceTools !== undefined && ctx.workspaceId !== undefined) {
        definitions.push(...workspaceTools.definitions);
      }
      if (questionTools !== undefined) definitions.push(...questionTools.definitions);
      return definitions;
    },
    async call(ctx: McpToolContext, name: string, args: unknown) {
      if (
        memoryTools !== undefined &&
        memoryTools.definitions.some((tool) => tool.name === name)
      ) {
        return memoryTools.call(
          {
            sessionId: ctx.sessionId,
            projectKey: ctx.projectKey,
            cwd: ctx.cwd,
          },
          name,
          args,
        );
      }
      if (
        questionTools !== undefined &&
        questionTools.definitions.some((tool) => tool.name === name)
      ) {
        return questionTools.call(
          { sessionId: ctx.sessionId, projectKey: ctx.projectKey, cwd: ctx.cwd },
          name,
          args,
        );
      }
      if (
        workspaceTools !== undefined &&
        workspaceTools.definitions.some((tool) => tool.name === name)
      ) {
        return workspaceTools.call({ workspaceId: ctx.workspaceId }, name, args);
      }
      return { text: `Tool "${String(name)}" tidak dikenal.`, isError: true };
    },
  };
}

export function createMemoryBridge(options: MemoryBridgeOptions): {
  bridge: MemoryBridge;
  routes: ReturnType<typeof mcpRoutes>;
} {
  const memoryTools =
    options.service === undefined ? undefined : new MemoryTools(options.service);
  const workspaceTools =
    options.workspaces === undefined ? undefined : new WorkspaceTools(options.workspaces);
  const questionTools =
    options.questions === undefined ? undefined : new QuestionTools(options.questions);
  const tools = composeTools(memoryTools, workspaceTools, questionTools);
  const registry = new McpTokenRegistry();

  const bridge: MemoryBridge = {
    async open(input) {
      const projectKey = await projectKeyFor(input.cwd);
      const issued = registry.issue({
        sessionId: input.sessionId,
        projectKey,
        cwd: input.cwd,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      });
      const ctx = { sessionId: input.sessionId, projectKey, cwd: input.cwd };

      let indexLine = "";
      if (memoryTools !== undefined) {
        indexLine = await memoryTools.indexLine(ctx);
      }
      if (questionTools !== undefined) {
        indexLine = `${indexLine}${QUESTION_INDEX_LINE}`.trim();
      }
      const hasWorkspaceContext =
        input.workspaceId !== undefined && workspaceTools !== undefined;
      if (hasWorkspaceContext) {
        indexLine = `${indexLine}${WORKSPACE_INDEX_LINE}`.trim();
      }

      const available: string[] = [];
      if (memoryTools !== undefined) {
        available.push(...memoryTools.definitions.map((tool) => tool.name));
      }
      if (questionTools !== undefined) {
        available.push(...questionTools.definitions.map((tool) => tool.name));
      }
      if (hasWorkspaceContext) {
        available.push(...workspaceTools.definitions.map((tool) => tool.name));
      }

      const memory: RunMemory = {
        indexLine,
        tools: available,
        call: (name, args) =>
          tools.call(
            input.workspaceId === undefined
              ? ctx
              : { ...ctx, workspaceId: input.workspaceId },
            name,
            args,
          ),
      };
      if (options.mcpUrl !== undefined) memory.url = options.mcpUrl;
      memory.token = issued.token;
      return { memory, close: () => issued.revoke() };
    },
  };

  return { bridge, routes: mcpRoutes({ tools, registry }) };
}
