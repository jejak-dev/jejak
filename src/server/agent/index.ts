import type { AgentRunner } from "./events";
import { createMockRunner } from "./mock-runner";
import { createSdkRunner } from "./sdk-runner";

export type { AgentEvent, AgentRunner, PermissionMode, RunInput, PermissionRequest, PermissionDecision, PermissionHandler } from "./events";
export { createMockRunner } from "./mock-runner";
export type { MockRunnerOptions } from "./mock-runner";
export { createSdkRunner, buildSdkEnv } from "./sdk-runner";
export type { SdkModule, SdkQuery, SdkRunnerOptions } from "./sdk-runner";
export { mapSdkMessage } from "./sdk-mapper";

export function createRunner(env: Record<string, string | undefined> = process.env): AgentRunner {
  return env.MOCK?.trim().toLowerCase() === "true" ? createMockRunner() : createSdkRunner();
}
