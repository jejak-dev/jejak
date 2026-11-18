import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkRunner, type SdkModule, type SdkQuery } from "../src/server/agent/sdk-runner";
import { agentsMdNote } from "../src/server/claude-config/agents-md";
import { MAX_INSTRUCTIONS_BYTES } from "../src/server/claude-config/instructions";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jejak-agents-md-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("AGENTS.md dimuat bila CLAUDE.md tidak ada", () => {
  writeFileSync(join(dir, "AGENTS.md"), "# Aturan\n\nPakai Bun.\n");
  const note = agentsMdNote(dir);
  expect(note).toContain("AGENTS.md");
  expect(note).toContain("Pakai Bun.");
});

test("tidak ada AGENTS.md menghasilkan undefined", () => {
  expect(agentsMdNote(dir)).toBeUndefined();
});

test("dilewati bila CLAUDE.md di akar atau .claude sudah ada", () => {
  writeFileSync(join(dir, "AGENTS.md"), "isi");
  writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md");
  expect(agentsMdNote(dir)).toBeUndefined();
  rmSync(join(dir, "CLAUDE.md"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "CLAUDE.md"), "x");
  expect(agentsMdNote(dir)).toBeUndefined();
});

test("kosong, terlalu besar, dan symlink ditolak", () => {
  writeFileSync(join(dir, "AGENTS.md"), "  \n");
  expect(agentsMdNote(dir)).toBeUndefined();
  writeFileSync(join(dir, "AGENTS.md"), "a".repeat(MAX_INSTRUCTIONS_BYTES + 1));
  expect(agentsMdNote(dir)).toBeUndefined();
  rmSync(join(dir, "AGENTS.md"));
  writeFileSync(join(dir, "luar.md"), "rahasia");
  symlinkSync(join(dir, "luar.md"), join(dir, "AGENTS.md"));
  expect(agentsMdNote(dir)).toBeUndefined();
});

test("runner menambahkan AGENTS.md ke append system prompt", async () => {
  writeFileSync(join(dir, "AGENTS.md"), "Selalu jawab Bahasa Indonesia.");
  let received: Record<string, unknown> | undefined;
  const module: SdkModule = {
    query(args) {
      received = args.options;
      const query: SdkQuery = {
        close() {},
        async *[Symbol.asyncIterator]() {},
      };
      return query;
    },
  } as SdkModule;
  const runner = createSdkRunner({ load: async () => module, baseEnv: {} });
  for await (const _ of runner.run({
    prompt: "halo",
    cwd: dir,
    provider: { profileId: "bawaan" },
  })) {
    // habiskan aliran
  }
  const append = (received?.systemPrompt as Record<string, unknown>).append as string;
  expect(append).toContain("Selalu jawab Bahasa Indonesia.");
});
