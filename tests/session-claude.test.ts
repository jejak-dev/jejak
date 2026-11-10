import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunInput } from "../src/server/agent";
import { FileClaudeConfigStore } from "../src/server/claude-config/config-store";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-sesi-claude-"));
  home = join(root, "rumah");
  project = await realpath(await mkdtemp(join(root, "proyek-")));
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".claude", "skills", "satu"), { recursive: true });
  await mkdir(join(project, ".claude", "skills", "dua"), { recursive: true });
  await writeFile(
    join(project, ".claude", "skills", "satu", "SKILL.md"),
    "---\ndescription: Satu\n---\n",
  );
  await writeFile(
    join(project, ".claude", "skills", "dua", "SKILL.md"),
    "---\ndescription: Dua\n---\n",
  );
  await mkdir(join(home, ".claude", "skills", "pribadi"), { recursive: true });
  await writeFile(
    join(home, ".claude", "skills", "pribadi", "SKILL.md"),
    "---\ndescription: Pribadi\n---\n",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function capturingRunner(): { runner: AgentRunner; inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        yield { type: "result", ok: true };
      },
    },
  };
}

async function runTurn(
  options: Partial<ConstructorParameters<typeof SessionManager>[0]> = {},
): Promise<RunInput> {
  const { runner, inputs } = capturingRunner();
  const manager = new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    home,
    ...options,
  });
  const info = await manager.create({ prompt: "Halo", cwd: project });
  await manager.done(info.id);
  const input = inputs[0];
  if (input === undefined) throw new Error("runner tidak dipanggil");
  return input;
}

describe("SessionManager dan pengaturan Claude", () => {
  test("tanpa store input.claude tidak diisi", async () => {
    const input = await runTurn();
    expect(input.claude).toBeUndefined();
  });

  test("flags diteruskan dan skills hanya saat ada yang nonaktif", async () => {
    const store = new FileClaudeConfigStore(":memory:");
    const off = await runTurn({ claude: store });
    expect(off.claude).toEqual({ userSettings: false, hooksEnabled: true });

    store.setFlags({ userSettings: true, hooksEnabled: false });
    const on = await runTurn({ claude: store });
    expect(on.claude).toMatchObject({ userSettings: true, hooksEnabled: false });
    expect(on.claude?.skills).toBeUndefined();
  });

  test("skills dihitung dari yang tidak dinonaktifkan", async () => {
    const store = new FileClaudeConfigStore(":memory:");
    store.setSkillEnabled("project", project, "dua", false);
    const input = await runTurn({ claude: store });
    // Pengguna belum opt-in: hanya skill proyek; skill nonaktif dibuang.
    expect(input.claude?.skills).toEqual(["satu"]);

    store.setFlags({ userSettings: true });
    store.setSkillEnabled("user", undefined, "pribadi", false);
    const withUser = await runTurn({ claude: store });
    expect(withUser.claude?.skills).toEqual(["satu"]);
  });

  test("menonaktifkan semua skill menyisakan daftar kosong", async () => {
    const store = new FileClaudeConfigStore(":memory:");
    store.setSkillEnabled("project", project, "satu", false);
    store.setSkillEnabled("project", project, "dua", false);
    const input = await runTurn({ claude: store });
    expect(input.claude?.skills).toEqual([]);
  });

  test("store yang melempar tidak menggagalkan giliran", async () => {
    const broken = {
      get() {
        throw new Error("rusak");
      },
      setFlags() {
        throw new Error("rusak");
      },
      setSkillEnabled() {
        throw new Error("rusak");
      },
      disabledFor() {
        throw new Error("rusak");
      },
    };
    const input = await runTurn({ claude: broken });
    expect(input.claude).toBeUndefined();
  });
});
