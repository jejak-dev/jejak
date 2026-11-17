import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import type { ResolvedProvider } from "../src/server/provider";
import { FileCommandEnvStore } from "../src/server/security/command-env-store";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };
const SECRET = "rahasia-env-panjang";

let root: string;
let project: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "jejak-session-command-env-")));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".env"), `DB_HOST=localhost\nDB_PASSWORD=${SECRET}\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({ runner, resolveProvider: async () => PROVIDER, ...extra });
}

function recordingRunner(script: (input: RunInput) => AgentEvent[]): {
  runner: AgentRunner;
  runs: RunInput[];
} {
  const runs: RunInput[] = [];
  return {
    runs,
    runner: {
      async *run(input) {
        runs.push(input);
        for (const event of script(input)) yield event;
      },
    },
  };
}

async function collect(iterable: AsyncIterable<SequencedEvent>): Promise<SequencedEvent[]> {
  const result: SequencedEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("SessionManager env perintah", () => {
  test("input.commandEnv diisi dari store dan riwayat disamarkan", async () => {
    const store = new FileCommandEnvStore(":memory:");
    store.set(project, join(project, ".env"));
    const recording = recordingRunner(() => [
      { type: "text", text: `nilai ${SECRET} bocor` },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner, { commandEnv: store });
    const info = await mgr.create({ prompt: "halo", cwd: project });
    await mgr.done(info.id);

    expect(recording.runs[0]?.commandEnv).toEqual({
      file: join(project, ".env"),
      keys: ["DB_HOST", "DB_PASSWORD"],
      values: ["localhost", SECRET],
      env: { DB_HOST: "localhost", DB_PASSWORD: SECRET },
    });
    const events = await collect(mgr.events(info.id));
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).toContain("[disembunyikan:");
  });

  test("cwd lewat symlink tetap cocok dengan akar yang disimpan (mis. /tmp di macOS)", async () => {
    const store = new FileCommandEnvStore(":memory:");
    // Rute menyimpan memakai akar ter-realpath.
    store.set(project, join(project, ".env"));
    const tautan = join(root, "tautan-proyek");
    await symlink(project, tautan);
    const recording = recordingRunner(() => [{ type: "result", ok: true }]);
    const mgr = manager(recording.runner, { commandEnv: store });
    const info = await mgr.create({ prompt: "halo", cwd: tautan });
    await mgr.done(info.id);
    expect(recording.runs[0]?.commandEnv?.file).toBe(join(project, ".env"));
  });

  test("tanpa store tidak ada commandEnv", async () => {
    const recording = recordingRunner(() => [{ type: "result", ok: true }]);
    const mgr = manager(recording.runner);
    const info = await mgr.create({ prompt: "halo", cwd: project });
    await mgr.done(info.id);
    expect(recording.runs[0]?.commandEnv).toBeUndefined();
  });

  test("berkas env tak terbaca: giliran lanjut dan peringatan sekali", async () => {
    const store = new FileCommandEnvStore(":memory:");
    store.set(project, join(project, ".env"));
    await rm(join(project, ".env"));
    const recording = recordingRunner(() => [{ type: "result", ok: true }]);
    const mgr = manager(recording.runner, { commandEnv: store });
    const info = await mgr.create({ prompt: "halo", cwd: project });
    await mgr.done(info.id);

    expect(recording.runs[0]?.commandEnv).toBeUndefined();
    const events = await collect(mgr.events(info.id));
    const errors = events.filter((item) => item.event.type === "error");
    expect(errors).toHaveLength(1);
  });

  test("guard Bash menolak perintah yang menampilkan env", async () => {
    const store = new FileCommandEnvStore(":memory:");
    store.set(project, join(project, ".env"));
    const recording = recordingRunner(() => [{ type: "result", ok: true }]);
    const mgr = manager(recording.runner, { commandEnv: store });
    const info = await mgr.create({ prompt: "halo", cwd: project });
    await mgr.done(info.id);

    const guard = recording.runs[0]?.secretGuard;
    expect(guard).toBeDefined();
    expect(
      guard?.({ toolName: "Bash", toolInput: { command: "printenv DB_PASSWORD" } }),
    ).toEqual({
      reason: "Perintah ini akan menampilkan variabel lingkungan rahasia.",
      rule: "env-perintah",
    });
    expect(
      guard?.({ toolName: "Bash", toolInput: { command: "psql -h $DB_HOST -c 'select 1'" } }),
    ).toBeUndefined();
  });
});
