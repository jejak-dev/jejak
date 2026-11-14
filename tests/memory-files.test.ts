import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absoluteMemoryPath,
  deleteMemoryFile,
  memoryFileName,
  parseMemory,
  projectDisplayName,
  projectFolderKey,
  projectFolderName,
  readMemoryFile,
  relativeMemoryPath,
  serializeMemory,
  slugify,
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

describe("judul H1 dan nama berkas baru", () => {
  test("isi diawali H1 judul dan round-trip stabil", () => {
    const item = memory({ title: "Perintah Tes" });
    const text = serializeMemory(item);
    expect(text).toContain(`# ${item.title}\n\n${item.body}`);

    const parsed = parseMemory(text, { fileName: memoryFileName(item), ...PROFILE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.memory.body).toBe(item.body);
    expect(parsed.memory.title).toBe(item.title);
    expect(serializeMemory(parsed.memory)).toBe(text);
  });

  test("berkas lama tanpa H1 tetap terbaca", () => {
    const item = memory();
    const tanpaH1 = serializeMemory(item).replace(`# ${item.title}\n\n`, "");
    const parsed = parseMemory(tanpaH1, { fileName: `${item.id}.md`, ...PROFILE });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.memory.body).toBe(item.body);
  });

  test("nama berkas baru dan legacy sama-sama diterima", () => {
    const item = memory({ title: "Perintah Tes" });
    const baru = parseMemory(serializeMemory(item), {
      fileName: memoryFileName(item),
      ...PROFILE,
    });
    expect(baru.ok).toBe(true);
    const legacy = parseMemory(serializeMemory(item), {
      fileName: `${item.id}.md`,
      ...PROFILE,
    });
    expect(legacy.ok).toBe(true);
  });

  test("nama berkas yang tidak cocok ditolak dengan pesan jelas", () => {
    const item = memory();
    const result = parseMemory(serializeMemory(item), {
      fileName: "lain-12345678.md",
      ...PROFILE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("tidak cocok");
  });

  test("id8 pada nama berkas harus cocok dengan id memory", () => {
    const item = memory();
    const salah = parseMemory(serializeMemory(item), {
      fileName: `judul-${"0".repeat(8)}.md`,
      ...PROFILE,
    });
    expect(salah.ok).toBe(false);
  });
});

describe("nama berkas dan folder", () => {
  test("slugify membersihkan karakter aneh dan memotong panjang", () => {
    expect(slugify("Perintah Tes")).toBe("perintah-tes");
    expect(slugify("  Halo   Dunia  ")).toBe("halo-dunia");
    expect(slugify('Perintah: "bun" #1 — jalan ✅')).toBe("perintah-bun-1-jalan");
    expect(slugify("")).toBe("memory");
    expect(slugify("!!!")).toBe("memory");
    expect(slugify("a".repeat(60))).toBe("a".repeat(48));
    expect(slugify("a".repeat(60)).length).toBe(48);
    expect(slugify("-AWAS-")).toBe("awas");
  });

  test("memoryFileName memakai slug judul dan 8 hex pertama id", () => {
    const item = memory({ title: "Perintah Tes" });
    expect(memoryFileName(item)).toBe(`perintah-tes-${item.id.slice(0, 8)}.md`);
    const kosong = memory({ title: "!!!" });
    expect(memoryFileName(kosong)).toBe(`memory-${kosong.id.slice(0, 8)}.md`);
  });

  test("projectFolderName memakai slug nama proyek dan hash 8", () => {
    const key = "/tmp/jejak";
    const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
    expect(projectFolderName(key)).toBe(`jejak-${hash}`);
    expect(projectFolderName("https://github.com/org/repo.git")).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(projectDisplayName("https://github.com/org/repo.git")).toBe("repo");
    expect(projectFolderName(key)).not.toBe(projectFolderKey(key));
    expect(projectFolderKey(key)).toHaveLength(16);
  });

  test("folder profil dan proyek memakai nama baru", () => {
    const item = memory({ layer: "project", projectKey: "/tmp/p", title: "Judul Proyek" });
    expect(item.projectKey).not.toBeNull();
    expect(relativeMemoryPath(item)).toBe(
      `projects/${projectFolderName("/tmp/p")}/${memoryFileName(item)}`,
    );
    const profile = memory({ title: "Judul Profil" });
    expect(relativeMemoryPath(profile)).toBe(`profile/${memoryFileName(profile)}`);
  });

  test("writeMemoryFile menolak id bukan UUID v4", async () => {
    await expect(
      writeMemoryFile(dir, memory({ id: "../x" })),
    ).rejects.toThrow(/UUID/);
    const files = await readdir(dir).catch(() => []);
    expect(files).not.toContain("../x.md");
  });

  test("nama berkas memakai slug judul tanpa karakter berbahaya", async () => {
    const item = memory({ title: "Judul Berbahaya ../../etc" });
    const written = await writeMemoryFile(dir, item);
    expect(written.relPath).toBe(`profile/${memoryFileName(item)}`);
    expect(memoryFileName(item)).not.toContain("..");
    expect(memoryFileName(item)).not.toContain("/");
    expect(memoryFileName(item)).toMatch(/^[a-z0-9-]+\.md$/);
    expect(await readFile(written.absPath, "utf8")).toContain(item.title);
  });

  test("existingRelPath dipakai apa adanya", async () => {
    const item = memory({ title: "Judul Lama" });
    const written = await writeMemoryFile(dir, item, "profile/lama.md");
    expect(written.relPath).toBe("profile/lama.md");
    expect(await readdir(join(dir, "profile"))).toEqual(["lama.md"]);
  });
});

describe("izin dan tulis atomik", () => {
  test("berkas 0600 dan direktori 0700", async () => {
    const item = memory({ layer: "project", projectKey: "/tmp/proyek" });
    const written = await writeMemoryFile(dir, item);
    const fileInfo = await stat(written.absPath);
    const folderInfo = await stat(join(dir, "projects", projectFolderName("/tmp/proyek")));
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(folderInfo.mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("tidak meninggalkan berkas .tmp setelah sukses", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    const entries = await readdir(join(dir, "profile"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([memoryFileName(item)]);
  });

  test("tulis ulang mengganti isi tanpa menyisakan tmp", async () => {
    const item = memory();
    const written = await writeMemoryFile(dir, item);
    await writeMemoryFile(dir, { ...item, title: "Judul baru" }, written.relPath);
    const entries = await readdir(join(dir, "profile"));
    expect(entries).toEqual([memoryFileName(item)]);
    const parsed = await readMemoryFile(dir, `profile/${memoryFileName(item)}`, "profile", null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.memory.title).toBe("Judul baru");
  });

  test("deleteMemoryFile menghapus dan aman bila sudah hilang", async () => {
    const item = memory();
    const written = await writeMemoryFile(dir, item);
    await deleteMemoryFile(dir, written.relPath);
    expect(await readdir(join(dir, "profile"))).toEqual([]);
    await deleteMemoryFile(dir, written.relPath);
    expect(absoluteMemoryPath(dir, item)).toContain(item.id.slice(0, 8));
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
    const result = await readMemoryFile(dir, `profile/${memoryFileName(item)}`, "profile", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("izin 0644 tetap dibaca sebagai valid (bukan galat)", async () => {
    const item = memory();
    const written = await writeMemoryFile(dir, item);
    await chmod(written.absPath, 0o644);
    const result = await readMemoryFile(dir, `profile/${memoryFileName(item)}`, "profile", null);
    expect(result.ok).toBe(true);
  });
});
