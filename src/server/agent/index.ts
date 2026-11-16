import type { AgentRunner } from "./events";
import { createMockRunner } from "./mock-runner";
import { createSdkRunner } from "./sdk-runner";

export type { AgentEvent, AgentRunner, PermissionMode, RunInput, RunMemory, RunWorkspace, RunClaudeConfig, PermissionRequest, PermissionDecision, PermissionHandler, ResolvedMcpServer, CommandInfo, ListCommandsInput } from "./events";
export {
  PERMISSION_EXPIRED_MESSAGE,
  PERMISSION_INTERRUPTED_MESSAGE,
  PERMISSION_STOPPED_MESSAGE,
} from "./events";
export { createMockRunner, MOCK_COMMANDS } from "./mock-runner";
export type { MockRunnerOptions } from "./mock-runner";
export { createSdkRunner, buildSdkEnv } from "./sdk-runner";
export type { SdkModule, SdkQuery, SdkRunnerOptions } from "./sdk-runner";
export { mapSdkMessage } from "./sdk-mapper";

export function createRunner(env: Record<string, string | undefined> = process.env): AgentRunner {
  return env.MOCK?.trim().toLowerCase() === "true" ? createMockRunner({ streamDelta: true }) : createSdkRunner();
}
