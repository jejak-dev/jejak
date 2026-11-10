import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_COMMAND_LENGTH, listHooks } from "../src/server/claude-config/hooks";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-claude-hooks-"));
  home = join(root, "rumah");
  project = join(root, "proyek");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function settings(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

describe("hooks", () => {
  test("parse proyek, proyek-lokal, dan pengguna", async () => {
    const hooks = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo awal" }] },
      ],
    };
    await settings(join(project, ".claude", "settings.json"), { hooks });
    await settings(join(project, ".claude", "settings.local.json"), {
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo lokal" }] }] },
    });
    await settings(join(home, ".claude", "settings.json"), {
      hooks: { Notification: [{ hooks: [{ type: "command", command: "echo pengguna" }] }] },
    });

    const list = listHooks(project, home, true);
    expect(list).toEqual([
      { source: "proyek", event: "PreToolUse", matcher: "Bash", command: "echo awal", active: true },
      { source: "proyek-lokal", event: "PostToolUse", command: "echo lokal", active: true },
      { source: "pengguna", event: "Notification", command: "echo pengguna", active: true },
    ]);
  });

  test("sumber pengguna nonaktif bila userSettings mati", () => {
    return settings(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    }).then(() => {
      expect(listHooks(project, home, false)[0]).toMatchObject({
        source: "pengguna",
        active: false,
      });
      expect(listHooks(project, home, true)[0]?.active).toBe(true);
    });
  });

  test("bentuk lain dilewati", async () => {
    await settings(join(project, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [
          { matcher: "x", hooks: [{ type: "http", url: "https://contoh" }] },
          { matcher: "y", hooks: [{ type: "command" }] },
          { hooks: "bukan array" },
          "bukan objek",
        ],
        Rusak: "bukan array",
        PostToolUse: [{ hooks: [{ type: "command", command: "  " }] }],
      },
    });
    expect(listHooks(project, home, true)).toEqual([]);
  });

  test("JSON rusak -> sumber dilewati tanpa melempar", async () => {
    await writeFile(join(project, ".claude", "settings.json"), "{ rusak", "utf8");
    await settings(join(project, ".claude", "settings.local.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo aman" }] }] },
    });
    expect(listHooks(project, home, true)).toEqual([
      { source: "proyek-lokal", event: "Stop", command: "echo aman", active: true },
    ]);
  });

  test("perintah disamarkan dan dipotong", async () => {
    const secret = "sk-ant-abcdefghijklmnop";
    await settings(join(project, ".claude", "settings.json"), {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `curl -H "x: ${secret}"` }] }],
      },
      panjang: undefined,
    });
    await settings(join(project, ".claude", "settings.local.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a".repeat(400) }] }] },
    });

    const [masked, long] = listHooks(project, home, true);
    expect(masked?.command).not.toContain(secret);
    expect(masked?.command).toContain("[disembunyikan:");
    expect(long?.command).toHaveLength(MAX_COMMAND_LENGTH);
  });

  test("tanpa cwd hanya sumber pengguna dibaca", async () => {
    await settings(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    expect(listHooks(undefined, home, true)).toHaveLength(1);
  });
});
