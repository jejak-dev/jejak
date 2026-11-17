import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { FileCommandEnvStore } from "../src/server/security/command-env-store";

let root: string;
let project: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "jejak-command-env-wiring-")));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  await writeFile(join(root, "env.txt"), "DB_HOST=localhost\nDB_PASSWORD=rahasia-panjang\n");
  await writeFile(
    join(root, "providers.json"),
    JSON.stringify({
      profiles: [{ id: "mock", name: "Mock", models: [{ id: "mock-model" }] }],
      activeProfileId: "mock",
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Menjaga pemasangan di createApp: store env perintah harus sampai ke SessionManager
// yang dibangun createApp sendiri (bukan manager yang disuntik tes).
test("createApp meneruskan commandEnv ke giliran agent", async () => {
  const runs: RunInput[] = [];
  const runner: AgentRunner = {
    async *run(input) {
      runs.push(input);
      // Sesi SDK diperlukan agar pesan lanjutan diterima.
      yield { type: "session", sessionId: "sdk-uji", model: "mock-model" } as AgentEvent;
      yield { type: "result", ok: true } as AgentEvent;
    },
  };
  const app = createApp({
    providersPath: join(root, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(root, "home") },
    runner,
    commandEnv: new FileCommandEnvStore(":memory:"),
  });
  const json = { "content-type": "application/json" };
  const created = await app.handle(
    new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ prompt: "halo", cwd: project }),
    }),
  );
  const { session } = (await created.json()) as { session: { id: string } };
  const put = await app.handle(
    new Request(`http://localhost/api/sessions/${session.id}/command-env`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ path: join(root, "env.txt") }),
    }),
  );
  expect(put.status).toBe(200);

  for (let i = 0; i < 100 && runs.length < 1; i += 1) await Bun.sleep(20);
  // Tunggu giliran pertama selesai lalu kirim pesan kedua.
  await Bun.sleep(100);
  const sent = await app.handle(
    new Request(`http://localhost/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "lagi" }),
    }),
  );
  for (let i = 0; i < 100 && runs.length < 2; i += 1) await Bun.sleep(20);
  expect(sent.status).toBe(200);

  expect(runs.length).toBeGreaterThanOrEqual(2);
  expect(runs[runs.length - 1]?.commandEnv?.env).toEqual({
    DB_HOST: "localhost",
    DB_PASSWORD: "rahasia-panjang",
  });
});
