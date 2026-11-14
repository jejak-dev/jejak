import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_INDEX_FILE,
  memoryFileName,
  projectFolderKey,
  projectFolderName,
  scanMemoryFiles,
  serializeMemory,
  type Memory,
} from "../src/server/memory/memory-files";
import {
  cleanupEmptyProjectFolders,
  migrateMemoryLayout,
  renderFolderIndex,
  renderRootIndex,
  writeFolderIndex,
  writeIndexIfChanged,
} from "../src/server/memory/memory-layout";
import { FileMemoryStore } from "../src/server/memory/memory-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-layout-"));
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

/** Isi berkas versi lama: frontmatter tanpa H1. */
function legacyContent(item: Memory): string {
  return serializeMemory(item).replace(`# ${item.title}\n\n`, "");
}

async function writeLegacyProfile(item: Memory): Promise<string> {
  await mkdir(join(dir, "profile"), { recursive: true });
  await writeFile(join(dir, "profile", `${item.id}.md`), legacyContent(item), { mode: 0o600 });
  return `profile/${item.id}.md`;
}

async function writeLegacyProject(item: Memory): Promise<string> {
  const key = item.projectKey as string;
  const folder = join(dir, "projects", projectFolderKey(key));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
    mode: 0o600,
  });
  await writeFile(join(folder, `${item.id}.md`), legacyContent(item), { mode: 0o600 });
  return `projects/${projectFolderKey(key)}/${item.id}.md`;
}

describe("renderFolderIndex", () => {
  test("isi memuat judul, disclaimer, dan tabel", () => {
    const text = renderFolderIndex({
      heading: "Memory profil",
      entries: [
        {
          title: "Perintah tes",
          fileName: "perintah-tes-1234abcd.md",
          status: "active",
          confidence: "confirmed",
          updatedAt: "2026-11-14T08:00:00.000Z",
        },
      ],
    });
    expect(text).toContain("# Memory profil");
    expect(text).toContain("Dibuat otomatis oleh Jejak.");
    expect(text).toContain("| Judul | Status | Keyakinan | Diperbarui |");
    expect(text).toContain("| --- | --- | --- | --- |");
    expect(text).toContain("| [Perintah tes](perintah-tes-1234abcd.md) | active | confirmed | 2026-11-14 |");
  });

  test("urut status lalu updated menurun", () => {
    const text = renderFolderIndex({
      heading: "Memory profil",
      entries: [
        { title: "D", fileName: "d.md", status: "rejected", confidence: "inferred", updatedAt: "2026-11-14T00:00:00.000Z" },
        { title: "A", fileName: "a.md", status: "active", confidence: "confirmed", updatedAt: "2026-01-01T00:00:00.000Z" },
        { title: "B", fileName: "b.md", status: "proposed", confidence: "inferred", updatedAt: "2026-05-01T00:00:00.000Z" },
        { title: "C", fileName: "c.md", status: "archived", confidence: "confirmed", updatedAt: "2026-06-01T00:00:00.000Z" },
        { title: "E", fileName: "e.md", status: "active", confidence: "confirmed", updatedAt: "2026-09-01T00:00:00.000Z" },
      ],
    });
    const titles = [...text.matchAll(/\| \[([^\]]+)\]/g)].map((match) => match[1]);
    expect(titles).toEqual(["E", "A", "B", "C", "D"]);
  });

  test("judul berisi pipa dan baris baru di-escape", () => {
    const text = renderFolderIndex({
      heading: "Memory profil",
      entries: [
        {
          title: "Judul | dengan\nbaris baru",
          fileName: "x.md",
          status: "active",
          confidence: "confirmed",
          updatedAt: "2026-11-14T00:00:00.000Z",
        },
      ],
    });
    expect(text).toContain("Judul \\| dengan baris baru");
    expect(text).not.toContain("dengan\nbaris");
  });

  test("folder proyek menulis baris Proyek", () => {
    const text = renderFolderIndex({
      heading: "Memory proyek: jejak",
      projectKey: "/tmp/jejak",
      entries: [],
    });
    expect(text).toContain("# Memory proyek: jejak");
    expect(text).toContain("Proyek: /tmp/jejak");
  });
});

describe("renderRootIndex", () => {
  test("daftar folder profil dan proyek", () => {
    const text = renderRootIndex([
      { label: "Profil", relPath: "profile/INDEX.md", active: 2, proposed: 1 },
      { label: "Proyek: /tmp/jejak", relPath: "projects/jejak-1234abcd/INDEX.md", active: 0, proposed: 3 },
    ]);
    expect(text).toContain("# Memory Jejak");
    expect(text).toContain("| Folder | Aktif | Usulan |");
    expect(text).toContain("| [Profil](profile/INDEX.md) | 2 | 1 |");
    expect(text).toContain("| [Proyek: /tmp/jejak](projects/jejak-1234abcd/INDEX.md) | 0 | 3 |");
  });
});

describe("penulisan INDEX.md", () => {
  test("berkas tidak ditulis ulang bila isinya sama", async () => {
    const target = join(dir, "profile", MEMORY_INDEX_FILE);
    await mkdir(join(dir, "profile"), { recursive: true });
    const content = "isi\n";
    expect(await writeIndexIfChanged(target, content)).toBe(true);
    const first = (await stat(target)).mtimeMs;
    expect(await writeIndexIfChanged(target, content)).toBe(false);
    expect((await stat(target)).mtimeMs).toBe(first);
    expect(await writeIndexIfChanged(target, "isi lain\n")).toBe(true);
  });

  test("berkas index diabaikan pemindai", async () => {
    const item = memory();
    await writeLegacyProfile(item);
    await writeFile(join(dir, "profile", MEMORY_INDEX_FILE), "# Memory profil\n", { mode: 0o600 });
    const scanned = await scanMemoryFiles(dir);
    expect(scanned.map((file) => file.relPath)).toEqual([`profile/${item.id}.md`]);
  });
});

describe("migrasi layout", () => {
  test("berkas legacy profil diganti nama dan mendapat H1", async () => {
    const item = memory({ title: "Perintah tes" });
    const relPath = await writeLegacyProfile(item);

    const hasil = await migrateMemoryLayout(dir);
    expect(hasil.problems).toEqual([]);

    const entries = await readdir(join(dir, "profile"));
    expect(entries).toEqual([memoryFileName(item)]);
    const text = await readFile(join(dir, "profile", memoryFileName(item)), "utf8");
    expect(text).toContain(`# ${item.title}`);
    expect(text).toContain(item.body);
    expect(text).toContain(`id: ${item.id}`);
    expect(relPath.endsWith(".md")).toBe(true);
  });

  test("folder proyek hash16 diganti nama ke folder baru", async () => {
    const item = memory({ layer: "project", projectKey: "/tmp/jejak", title: "Proyek" });
    await writeLegacyProject(item);

    const hasil = await migrateMemoryLayout(dir);
    expect(hasil.problems).toEqual([]);

    const folders = await readdir(join(dir, "projects"));
    expect(folders).toEqual([projectFolderName("/tmp/jejak")]);
    const entries = await readdir(join(dir, "projects", projectFolderName("/tmp/jejak")));
    expect(entries).toContain(memoryFileName(item));
    expect(entries).toContain("_project.json");
  });

  test("migrasi idempoten dan data tetap identik", async () => {
    const item = memory({ title: "Perintah tes" });
    await writeLegacyProfile(item);
    const sebelum = legacyContent(item);

    const pertama = await migrateMemoryLayout(dir);
    expect(pertama.problems).toEqual([]);
    const sesudah = await readFile(join(dir, "profile", memoryFileName(item)), "utf8");
    const kedua = await migrateMemoryLayout(dir);
    expect(kedua.problems).toEqual([]);
    expect(kedua.changedFolders).toEqual([]);
    const lagi = await readFile(join(dir, "profile", memoryFileName(item)), "utf8");
    expect(lagi).toBe(sesudah);
    expect(sesudah.replace(`# ${item.title}\n\n`, "")).toBe(sebelum);
  });

  test("berkas rusak tidak disentuh", async () => {
    await mkdir(join(dir, "profile"), { recursive: true });
    const rusak = join(dir, "profile", `${crypto.randomUUID()}.md`);
    await writeFile(rusak, "bukan frontmatter", { mode: 0o600 });

    const problems = await migrateMemoryLayout(dir);
    expect(Array.isArray(problems.problems)).toBe(true);
    expect(await readFile(rusak, "utf8")).toBe("bukan frontmatter");
  });

  test("folder tujuan yang sudah ada digabung tanpa menimpa", async () => {
    const key = "/tmp/jejak";
    const lama = memory({ layer: "project", projectKey: key, title: "Lama" });
    await writeLegacyProject(lama);

    // Folder tujuan sudah ada dengan berkas bernama sama.
    const target = join(dir, "projects", projectFolderName(key));
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "_project.json"),
      `${JSON.stringify({ projectKey: key })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(target, memoryFileName(lama)), "isi lain\n", { mode: 0o600 });

    const problems = await migrateMemoryLayout(dir);
    expect(problems.problems.length).toBeGreaterThan(0);
    expect(await readFile(join(target, memoryFileName(lama)), "utf8")).toBe("isi lain\n");
    // Data lama tidak dihapus.
    const source = join(dir, "projects", projectFolderKey(key));
    expect((await readdir(source)).length).toBeGreaterThan(0);
  });

  test("store memigrasi pada sync pertama", async () => {
    const item = memory({ title: "Perintah tes" });
    await writeLegacyProfile(item);

    const store = new FileMemoryStore({ dir });
    const listed = await store.list({});
    expect(listed.map((entry) => entry.id)).toEqual([item.id]);
    expect(listed[0]?.title).toBe(item.title);
    const entries = await readdir(join(dir, "profile"));
    expect(entries).toContain(memoryFileName(item));
    expect(entries).toContain(MEMORY_INDEX_FILE);
    store.close();
  });
});

describe("folder proyek kosong", () => {
  /** Folder proyek versi lama yang tertinggal: hanya `INDEX.md` dan metadata. */
  async function writeLegacyLeftover(key: string): Promise<string> {
    const folder = join(dir, "projects", projectFolderKey(key));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, MEMORY_INDEX_FILE), "# Memory proyek: jejak\n", {
      mode: 0o600,
    });
    await writeFile(join(folder, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
      mode: 0o600,
    });
    return folder;
  }

  test("folder legacy yang tersisa dibersihkan", async () => {
    const key = "/tmp/jejak";
    const legacy = await writeLegacyLeftover(key);

    const hasil = await migrateMemoryLayout(dir);
    expect(hasil.problems).toEqual([]);
    expect(hasil.removedFolders).toEqual([projectFolderKey(key)]);
    await expect(stat(legacy)).rejects.toThrow();
    expect(await readdir(join(dir, "projects"))).toEqual([]);
  });

  test("folder dengan berkas rusak tidak disentuh", async () => {
    const key = "/tmp/jejak";
    const folder = join(dir, "projects", projectFolderName(key));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
      mode: 0o600,
    });
    await writeFile(join(folder, MEMORY_INDEX_FILE), "# Memory proyek: jejak\n", { mode: 0o600 });
    await writeFile(join(folder, "rusak.md"), "bukan frontmatter", { mode: 0o600 });

    const hasil = await migrateMemoryLayout(dir);
    expect(hasil.removedFolders).toEqual([]);
    expect(await cleanupEmptyProjectFolders(dir)).toEqual([]);
    expect(await readFile(join(folder, "rusak.md"), "utf8")).toBe("bukan frontmatter");
    expect(await readFile(join(folder, MEMORY_INDEX_FILE), "utf8")).toContain("Memory proyek");
  });

  test("berkas rusak pada folder legacy tidak dihapus", async () => {
    const key = "/tmp/lain";
    const legacy = join(dir, "projects", projectFolderKey(key));
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
      mode: 0o600,
    });
    await writeFile(join(legacy, "rusak.md"), "bukan frontmatter", { mode: 0o600 });

    await migrateMemoryLayout(dir);
    const moved = join(dir, "projects", projectFolderName(key), "rusak.md");
    expect(await readFile(moved, "utf8")).toBe("bukan frontmatter");
  });

  test("INDEX.md tidak ditulis di folder tanpa memory", async () => {
    const changed = await writeFolderIndex(dir, "projects/kosong-1234abcd", {
      heading: "Memory proyek: kosong",
      projectKey: null,
      entries: [],
    });
    expect(changed).toBe(false);
    await expect(stat(join(dir, "projects", "kosong-1234abcd", MEMORY_INDEX_FILE))).rejects.toThrow();
    await expect(stat(join(dir, "projects", "kosong-1234abcd"))).rejects.toThrow();
  });

  test("INDEX.md akar tidak menautkan folder yang sudah dihapus", async () => {
    const key = "/tmp/jejak";
    const legacy = await writeLegacyLeftover(key);

    const target = join(dir, "projects", projectFolderName(key));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
      mode: 0o600,
    });
    const item = memory({ layer: "project", projectKey: key, title: "Catatan proyek" });
    await writeFile(join(target, memoryFileName(item)), serializeMemory(item), { mode: 0o600 });

    // Akar lama masih menautkan folder legacy.
    await writeFile(
      join(dir, MEMORY_INDEX_FILE),
      `# Memory Jejak\n\n| Folder | Aktif | Usulan |\n| --- | --- | --- |\n| [Proyek](projects/${projectFolderKey(key)}/INDEX.md) | 0 | 0 |\n`,
      { mode: 0o600 },
    );

    const store = new FileMemoryStore({ dir });
    await store.sync();
    store.close();

    await expect(stat(legacy)).rejects.toThrow();
    const root = await readFile(join(dir, MEMORY_INDEX_FILE), "utf8");
    expect(root).not.toContain(projectFolderKey(key));
    expect(root).toContain(`projects/${projectFolderName(key)}/INDEX.md`);
    const folderIndex = await readFile(
      join(dir, "projects", projectFolderName(key), MEMORY_INDEX_FILE),
      "utf8",
    );
    expect(folderIndex).toContain("Catatan proyek");
  });

  test("pembersihan idempoten saat dijalankan dua kali", async () => {
    const key = "/tmp/jejak";
    const legacy = await writeLegacyLeftover(key);

    const pertama = await migrateMemoryLayout(dir);
    expect(pertama.removedFolders).toEqual([projectFolderKey(key)]);
    const kedua = await migrateMemoryLayout(dir);
    expect(kedua.removedFolders).toEqual([]);
    expect(kedua.problems).toEqual([]);
    await expect(stat(legacy)).rejects.toThrow();
  });

  test("folder proyek kosong setelah delete dibersihkan", async () => {
    const key = "/tmp/jejak";
    const store = new FileMemoryStore({ dir });
    const item = memory({ layer: "project", projectKey: key, title: "Catatan proyek" });
    await store.create(item);

    const folder = join(dir, "projects", projectFolderName(key));
    expect(await readdir(folder)).toContain(MEMORY_INDEX_FILE);

    expect(await store.delete(item.id)).toBe(true);

    await expect(stat(folder)).rejects.toThrow();
    const root = await readFile(join(dir, MEMORY_INDEX_FILE), "utf8");
    expect(root).not.toContain(projectFolderName(key));
    store.close();
  });

  test("sync dua kali menghasilkan keadaan yang sama", async () => {
    const key = "/tmp/jejak";
    await writeLegacyLeftover(key);
    const target = join(dir, "projects", projectFolderName(key));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "_project.json"), `${JSON.stringify({ projectKey: key })}\n`, {
      mode: 0o600,
    });
    const item = memory({ layer: "project", projectKey: key, title: "Catatan proyek" });
    await writeFile(join(target, memoryFileName(item)), serializeMemory(item), { mode: 0o600 });

    const store = new FileMemoryStore({ dir });
    await store.sync();
    const rootSatu = await readFile(join(dir, MEMORY_INDEX_FILE), "utf8");
    const problemsSatu = await store.sync();
    const rootDua = await readFile(join(dir, MEMORY_INDEX_FILE), "utf8");
    expect(problemsSatu).toEqual([]);
    expect(rootDua).toBe(rootSatu);
    expect(await readdir(join(dir, "projects"))).toEqual([projectFolderName(key)]);
    store.close();
  });
});
