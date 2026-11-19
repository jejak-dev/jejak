import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  CLAUDE_MEMORY_FILE_MAX_BYTES,
  CLAUDE_MEMORY_MAX_FILES,
  claudeConfigRoot,
  claudeMemoryDir,
  claudeProjectEntries,
  claudeProjectSlug,
  claudeWorktreeOrigin,
  isInsideDir,
  listClaudeMemories,
  parseClaudeMemory,
  resolveClaudeProject,
} from "../src/server/memory/claude-memory";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-claude-memory-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeMemory(
  folder: string,
  name: string,
  content: string,
): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, content, "utf8");
  return path;
}

/* ---------- Slug dan folder ---------- */

describe("claudeProjectSlug", () => {
  test("path biasa: setiap karakter non-alfanumerik jadi -", () => {
    expect(claudeProjectSlug("/Users/boy/Developer/jejak")).toBe(
      "-Users-boy-Developer-jejak",
    );
  });

  test("titik dan garis bawah ikut diganti", () => {
    expect(claudeProjectSlug("/Users/x/.jejak/worktrees/s-1")).toBe(
      "-Users-x--jejak-worktrees-s-1",
    );
  });

  test("spasi jadi -", () => {
    expect(claudeProjectSlug("/Users/boy/My Project")).toBe("-Users-boy-My-Project");
  });

  test("unicode jadi - per karakter", () => {
    expect(claudeProjectSlug("/Users/boy/é")).toBe("-Users-boy--");
  });

  test("huruf besar dipertahankan", () => {
    expect(claudeProjectSlug("/Users/Boy/Jejak")).toBe("-Users-Boy-Jejak");
  });
});

describe("claudeConfigRoot", () => {
  test("menghormati CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigRoot({ CLAUDE_CONFIG_DIR: "/custom/root" }, "/home/user")).toBe(
      "/custom/root",
    );
  });

  test("tanpa env pakai ~/.claude", () => {
    expect(claudeConfigRoot({}, "/home/user")).toBe("/home/user/.claude");
  });

  test("env kosong diabaikan", () => {
    expect(claudeConfigRoot({ CLAUDE_CONFIG_DIR: "  " }, "/home/user")).toBe(
      "/home/user/.claude",
    );
  });
});

describe("claudeMemoryDir", () => {
  test("folder memory di bawah projects/<slug>/memory", () => {
    expect(claudeMemoryDir("/cfg", "/Users/boy/jejak")).toBe(
      "/cfg/projects/-Users-boy-jejak/memory",
    );
  });

  test("berbeda bila config root berbeda", () => {
    expect(claudeMemoryDir("/a", "/p")).not.toBe(claudeMemoryDir("/b", "/p"));
  });
});

/* ---------- Parser ---------- */

describe("parseClaudeMemory", () => {
  test("frontmatter normal dibaca penuh", () => {
    const text = [
      "---",
      'name: nama-materi',
      'description: "ringkasan singkat"',
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "Isi memory.",
    ].join("\n");
    const item = parseClaudeMemory("berkas.md", text, "2026-01-01T00:00:00.000Z");
    expect(item.title).toBe("nama-materi");
    expect(item.description).toBe("ringkasan singkat");
    expect(item.type).toBe("feedback");
    expect(item.body).toBe("Isi memory.");
    expect(item.file).toBe("berkas.md");
    expect(item.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("frontmatter rusak: judul dari nama berkas, tipe unknown", () => {
    const item = parseClaudeMemory(
      "rusak.md",
      "---\nbukan frontmatter\n",
      "2026-01-01T00:00:00.000Z",
    );
    expect(item.title).toBe("rusak");
    expect(item.type).toBe("unknown");
    expect(item.description).toBe("");
  });

  test("tanpa frontmatter: judul dari nama berkas, tipe unknown", () => {
    const item = parseClaudeMemory(
      "polos.md",
      "Langsung isi tanpa frontmatter.\n",
      "2026-01-01T00:00:00.000Z",
    );
    expect(item.title).toBe("polos");
    expect(item.type).toBe("unknown");
    expect(item.body).toBe("Langsung isi tanpa frontmatter.");
  });

  test("kunci tak dikenal diabaikan", () => {
    const text = [
      "---",
      "name: nama",
      "kunciAsing: nilai",
      "metadata:",
      "  type: project",
      "  node_type: memory",
      "---",
      "Isi.",
    ].join("\n");
    const item = parseClaudeMemory("x.md", text, "2026-01-01T00:00:00.000Z");
    expect(item.title).toBe("nama");
    expect(item.type).toBe("project");
  });

  test("tipe tak dikenal menjadi unknown", () => {
    const text = ["---", "name: n", "metadata:", "  type: entah", "---", "isi"].join("\n");
    const item = parseClaudeMemory("x.md", text, "2026-01-01T00:00:00.000Z");
    expect(item.type).toBe("unknown");
  });

  test("nama kosong memakai nama berkas", () => {
    const text = ["---", 'name: ""', "metadata:", "  type: user", "---", "isi"].join("\n");
    const item = parseClaudeMemory("fallback.md", text, "2026-01-01T00:00:00.000Z");
    expect(item.title).toBe("fallback");
    expect(item.type).toBe("user");
  });
});

/* ---------- Pembacaan folder ---------- */

describe("listClaudeMemories", () => {
  test("folder tak ada menghasilkan dirExists false tanpa galat", async () => {
    const listing = await listClaudeMemories(join(dir, "hilang"));
    expect(listing.dirExists).toBe(false);
    expect(listing.items).toEqual([]);
  });

  test("MEMORY.md tidak masuk daftar item tapi jadi index", async () => {
    const folder = join(dir, "memory");
    await writeMemory(folder, "MEMORY.md", "- [satu](satu.md)\n");
    await writeMemory(folder, "satu.md", "---\nname: satu\n---\nisi\n");
    const listing = await listClaudeMemories(folder);
    expect(listing.dirExists).toBe(true);
    expect(listing.items.map((item) => item.file)).toEqual(["satu.md"]);
    expect(listing.index).toContain("satu.md");
  });

  test("symlink diabaikan", async () => {
    const folder = join(dir, "memory");
    await mkdir(folder, { recursive: true });
    const target = await writeMemory(
      join(dir, "luar"),
      "luar.md",
      "---\nname: luar\n---\nisi\n",
    );
    await symlink(target, join(folder, "saut.md"));
    const listing = await listClaudeMemories(folder);
    expect(listing.items.map((item) => item.file)).toEqual([]);
  });

  test("folder di dalam folder diabaikan", async () => {
    const folder = join(dir, "memory");
    await mkdir(join(folder, "sub.md"), { recursive: true });
    const listing = await listClaudeMemories(folder);
    expect(listing.items).toEqual([]);
  });

  test("berkas bukan .md diabaikan", async () => {
    const folder = join(dir, "memory");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "catatan.txt"), "bukan memory", "utf8");
    const listing = await listClaudeMemories(folder);
    expect(listing.items).toEqual([]);
  });

  test("berkas lebih besar dari batas dipotong dan ditandai truncated", async () => {
    const folder = join(dir, "memory");
    await mkdir(folder, { recursive: true });
    const besar = "x".repeat(CLAUDE_MEMORY_FILE_MAX_BYTES + 500);
    await writeFile(
      join(folder, "besar.md"),
      `---\nname: besar\n---\n${besar}`,
      "utf8",
    );
    const listing = await listClaudeMemories(folder);
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]!.truncated).toBe(true);
    expect(listing.items[0]!.body.length).toBeLessThanOrEqual(
      CLAUDE_MEMORY_FILE_MAX_BYTES,
    );
  });

  test("jumlah berkas dibatasi", async () => {
    const folder = join(dir, "memory");
    await mkdir(folder, { recursive: true });
    for (let index = 0; index < CLAUDE_MEMORY_MAX_FILES + 5; index += 1) {
      await writeFile(
        join(folder, `m-${String(index).padStart(4, "0")}.md`),
        `---\nname: m${index}\n---\nisi\n`,
        "utf8",
      );
    }
    const listing = await listClaudeMemories(folder);
    expect(listing.items).toHaveLength(CLAUDE_MEMORY_MAX_FILES);
  });

  test("urut menurut waktu ubah menurun", async () => {
    const folder = join(dir, "memory");
    await mkdir(folder, { recursive: true });
    const lama = join(folder, "lama.md");
    const baru = join(folder, "baru.md");
    await writeFile(lama, "---\nname: lama\n---\nisi\n", "utf8");
    await writeFile(baru, "---\nname: baru\n---\nisi\n", "utf8");
    const sekarang = new Date();
    const sejamak = new Date(sekarang.getTime() - 3600 * 1000);
    await utimes(lama, sejamak, sejamak);
    await utimes(baru, sekarang, sekarang);
    const listing = await listClaudeMemories(folder);
    expect(listing.items.map((item) => item.file)).toEqual(["baru.md", "lama.md"]);
  });
});

/* ---------- Pemetaan proyek ---------- */

describe("claudeProjectEntries dan resolveClaudeProject", () => {
  test("proyek tak dikenal menghasilkan undefined", () => {
    const entries = claudeProjectEntries([{ cwd: "/a" }]);
    expect(resolveClaudeProject(entries, "/tidak")).toBeUndefined();
  });

  test("proyek ditemukan lewat kuncinya", () => {
    const entries = claudeProjectEntries([{ cwd: "/a" }]);
    expect(resolveClaudeProject(entries, "/a")?.key).toBe("/a");
  });

  test("worktree Jejak menyimpan repo asal", () => {
    const entries = claudeProjectEntries([
      {
        cwd: "/home/.jejak/worktrees/s-1",
        worktree: { path: "/home/.jejak/worktrees/s-1", repoRoot: "/repo/asli" },
      },
    ]);
    const entry = resolveClaudeProject(entries, "/home/.jejak/worktrees/s-1");
    expect(entry?.originPath).toBe("/repo/asli");
  });

  test("repo asal hanya untuk path di dalam worktree", () => {
    const entries = claudeProjectEntries([
      {
        cwd: "/repo/asli",
        worktree: { path: "/home/.jejak/worktrees/s-1", repoRoot: "/repo/asli" },
      },
    ]);
    expect(resolveClaudeProject(entries, "/repo/asli")?.originPath).toBeUndefined();
  });
});

describe("claudeWorktreeOrigin", () => {
  test("repo asal dibaca dari metadata git worktree", async () => {
    const repo = join(dir, "repo");
    const worktrees = join(repo, ".git", "worktrees", "w-1");
    await mkdir(worktrees, { recursive: true });
    await writeFile(join(worktrees, "commondir"), "../..\n", "utf8");
    const wt = join(dir, "wt");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${worktrees}\n`, "utf8");
    expect(await claudeWorktreeOrigin(wt)).toBe(repo);
  });

  test("bukan worktree menghasilkan undefined", async () => {
    const plain = join(dir, "biasa");
    await mkdir(plain, { recursive: true });
    expect(await claudeWorktreeOrigin(plain)).toBeUndefined();
  });
});

describe("folder Claude tidak pernah ditulis", () => {
  test("folder memory tetap sama setelah dibaca", async () => {
    const folder = join(dir, "memory");
    await writeMemory(folder, "satu.md", "---\nname: satu\n---\nisi\n");
    const before = await readdir(folder);
    const statsBefore = await Promise.all(
      before.map(async (name) => (await Bun.file(join(folder, name)).stat()).mtimeMs),
    );
    await listClaudeMemories(folder);
    const after = await readdir(folder);
    const statsAfter = await Promise.all(
      after.map(async (name) => (await Bun.file(join(folder, name)).stat()).mtimeMs),
    );
    expect(after).toEqual(before);
    expect(statsAfter).toEqual(statsBefore);
  });
});

describe("isInsideDir lintas platform", () => {
  const winDir = "C:\\Users\\boyku\\.claude\\projects\\F--lab-replmgr-be\\memory";

  test("path Windows (backslash): berkas di dalam folder diterima", () => {
    expect(isInsideDir(winDir, `${winDir}\\feedback-a.md`, win32)).toBe(true);
    expect(isInsideDir(winDir, winDir, win32)).toBe(true);
  });

  test("path Windows: folder lain, saudara berawalan sama, dan naik ditolak", () => {
    expect(isInsideDir(winDir, `${winDir}-lain\\a.md`, win32)).toBe(false);
    expect(isInsideDir(winDir, `${winDir}\\..\\x.md`, win32)).toBe(false);
    expect(isInsideDir(winDir, "D:\\lain\\a.md", win32)).toBe(false);
  });

  test("path POSIX tetap benar", () => {
    expect(isInsideDir("/a/memory", "/a/memory/x.md", posix)).toBe(true);
    expect(isInsideDir("/a/memory", "/a/memory-lain/x.md", posix)).toBe(false);
    expect(isInsideDir("/a/memory", "/a/x.md", posix)).toBe(false);
  });
});
