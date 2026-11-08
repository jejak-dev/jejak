import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absoluteMemoryPath,
  deleteMemoryFile,
  parseMemory,
  projectFolderKey,
  readMemoryFile,
  relativeMemoryPath,
  serializeMemory,
  writeMemoryFile,
  type Memory,
  type MemoryLayer,
} from "../src/server/memory/memory-files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function memory(overrides: Partial<Memory> = {}): Memory {
  const at = "2026-11-08T10:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    layer: "profile",
    projectKey: null,
    title: "Perintah tes",
    body: "Jalankan bun test sebelum commit.",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at },
    staleReason: null,
    createdAt: at,
    updatedAt: at,
    decidedAt: null,
    ...overrides,
  };
}

const PROFILE = { layer: "profile" as MemoryLayer, projectKey: null };

describe("serialisasi frontmatter round-trip", () => {
  test("judul berisi titik dua, pagar, kutip, dan unicode", () => {
    const item = memory({ title: `Perintah: "bun" #1 — jalan ✅` });
    const parsed = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.memory.title).toBe(item.title);
    expect(parsed.memory.body).toBe(item.body);
    expect(parsed.memory.id).toBe(item.id);
  });

  test("isi multibaris dengan baris --- tidak memutus frontmatter", () => {
    const item = memory({ body: "baris satu\n---\nbaris tiga\n\tindentasi" });
    const parsed = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.memory.body).toBe("baris satu\n---\nbaris tiga\n\tindentasi");
  });

  test("origin file dan decided ikut bertahan", () => {
    const at = "2026-11-08T10:00:00.000Z";
    const item = memory({
      layer: "project",
      projectKey: "/tmp/proyek",
      status: "proposed",
      confidence: "from_code",
      origin: {
        kind: "file",
        file: "src/a.ts",
        fileSha256: "a".repeat(64),
        at,
      },
      decidedAt: at,
    });
    const parsed = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      layer: "project",
      projectKey: "/tmp/proyek",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.memory.origin).toEqual(item.origin);
    expect(parsed.memory.decidedAt).toBe(at);
    expect(parsed.memory.status).toBe("proposed");
    expect(parsed.memory.confidence).toBe("from_code");
  });
});

describe("nama berkas dari id", () => {
  test("folder profil dan proyek memakai hash projectKey", () => {
    const item = memory({ layer: "project", projectKey: "/tmp/p" });
    expect(item.projectKey).not.toBeNull();
    expect(relativeMemoryPath(item)).toBe(
      `projects/${projectFolderKey("/tmp/p")}/${item.id}.md`,
    );
    expect(projectFolderKey("/tmp/p")).toHaveLength(16);
    const profile = memory();
    expect(relativeMemoryPath(profile)).toBe(`profile/${profile.id}.md`);
  });

  test("writeMemoryFile menolak id bukan UUID v4", async () => {
    await expect(
      writeMemoryFile(dir, memory({ id: "../x" })),
    ).rejects.toThrow(/UUID/);
    const files = await readdir(dir).catch(() => []);
    expect(files).not.toContain("../x.md");
  });

  test("memakai id sebagai nama berkas, bukan judul", async () => {
    const item = memory({ title: "Judul Berbahaya ../../etc" });
    const written = await writeMemoryFile(dir, item);
    expect(written.relPath).toBe(`profile/${item.id}.md`);
    expect(await readFile(written.absPath, "utf8")).toContain(item.title);
  });
});

describe("izin dan tulis atomik", () => {
  test("berkas 0600 dan direktori 0700", async () => {
    const item = memory({ layer: "project", projectKey: "/tmp/proyek" });
    const written = await writeMemoryFile(dir, item);
    const fileInfo = await stat(written.absPath);
    const folderInfo = await stat(join(dir, "projects", projectFolderKey("/tmp/proyek")));
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(folderInfo.mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("tidak meninggalkan berkas .tmp setelah sukses", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    const entries = await readdir(join(dir, "profile"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([`${item.id}.md`]);
  });

  test("tulis ulang mengganti isi tanpa menyisakan tmp", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    await writeMemoryFile(dir, { ...item, title: "Judul baru" });
    const entries = await readdir(join(dir, "profile"));
    expect(entries).toEqual([`${item.id}.md`]);
    const parsed = await readMemoryFile(dir, `profile/${item.id}.md`, "profile", null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.memory.title).toBe("Judul baru");
  });

  test("deleteMemoryFile menghapus dan aman bila sudah hilang", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    await deleteMemoryFile(dir, item);
    expect(await readdir(join(dir, "profile"))).toEqual([]);
    await deleteMemoryFile(dir, item);
    expect(absoluteMemoryPath(dir, item)).toContain(item.id);
  });
});

describe("berkas rusak ditolak dengan alasan aman", () => {
  const context = { fileName: "berkas.md", ...PROFILE };

  test("frontmatter hilang", () => {
    expect(parseMemory("tanpa frontmatter", context)).toEqual({
      ok: false,
      reason: "frontmatter tidak ditemukan atau tidak valid",
    });
  });

  test("enum status salah", () => {
    const item = memory();
    const text = serializeMemory(item).replace("status: active", "status: entah");
    const result = parseMemory(text, { fileName: `${item.id}.md`, ...PROFILE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("status tidak valid");
  });

  test("enum confidence salah", () => {
    const item = memory();
    const text = serializeMemory(item).replace("confidence: confirmed", "confidence: pasti");
    const result = parseMemory(text, { fileName: `${item.id}.md`, ...PROFILE });
    expect(result.ok).toBe(false);
  });

  test("id tidak cocok dengan nama berkas", () => {
    const item = memory();
    const result = parseMemory(serializeMemory(item), {
      fileName: `${crypto.randomUUID()}.md`,
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("tidak cocok");
  });

  test("id bukan UUID ditolak", () => {
    const item = memory();
    const text = serializeMemory(item).replace(item.id, "bukan-uuid");
    const result = parseMemory(text, { fileName: "bukan-uuid.md", ...PROFILE });
    expect(result.ok).toBe(false);
  });

  test("layer tidak cocok dengan folder", () => {
    const item = memory({ layer: "project", projectKey: "/tmp/p" });
    const result = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("layer tidak cocok dengan folder");
  });

  test("judul terlalu panjang", () => {
    const item = memory({ title: "a".repeat(121) });
    const result = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
  });

  test("isi terlalu panjang", () => {
    const item = memory({ body: "a".repeat(2001) });
    const result = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
  });

  test("rahasia ditolak dan alasan tidak memuat isi rahasia", () => {
    const secret = "sk-abcdefgh12345678";
    const item = memory({ body: `kunci ${secret} jangan disimpan` });
    const result = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rahasia");
      expect(result.reason).toContain("kunci API");
      expect(result.reason).not.toContain(secret);
    }
  });
});

describe("readMemoryFile memakai batas ukuran", () => {
  test("berkas tidak valid menghasilkan ok:false tanpa isi", async () => {
    await mkdir(join(dir, "profile"), { recursive: true });
    const name = `${crypto.randomUUID()}.md`;
    await writeFile(join(dir, "profile", name), "bukan frontmatter", { mode: 0o600 });
    const result = await readMemoryFile(dir, `profile/${name}`, "profile", null);
    expect(result.ok).toBe(false);
  });

  test("path dengan .. ditolak", async () => {
    const result = await readMemoryFile(dir, "../rahasia.md", "profile", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("path berkas tidak valid");
  });

  test("berkas terlalu besar ditolak", async () => {
    await mkdir(join(dir, "profile"), { recursive: true });
    const name = `${crypto.randomUUID()}.md`;
    await writeFile(join(dir, "profile", name), "a".repeat(70 * 1024), { mode: 0o600 });
    const result = await readMemoryFile(dir, `profile/${name}`, "profile", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("berkas terlalu besar");
  });

  test("berkas valid menghasilkan sha256", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    const result = await readMemoryFile(dir, `profile/${item.id}.md`, "profile", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("izin 0644 tetap dibaca sebagai valid (bukan galat)", async () => {
    const item = memory();
    const written = await writeMemoryFile(dir, item);
    await chmod(written.absPath, 0o644);
    const result = await readMemoryFile(dir, `profile/${item.id}.md`, "profile", null);
    expect(result.ok).toBe(true);
  });
});
