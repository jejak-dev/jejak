import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  MemoryIndex,
  toFtsAnyQuery,
  toFtsQuery,
} from "../src/server/memory/memory-index";
import {
  memoryFileName,
  projectFolderName,
  serializeMemory,
  writeMemoryFile,
  type Memory,
} from "../src/server/memory/memory-files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-index-"));
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
    title: "Judul memory",
    body: "Isi memory biasa.",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at },
    staleReason: null,
    createdAt: at,
    updatedAt: at,
    decidedAt: null,
    replaces: null,
    ...overrides,
  };
}

describe("sync", () => {
  test("menambah, mengubah, dan membuang berkas", async () => {
    const index = new MemoryIndex();
    const first = memory({ title: "Pertama" });
    const written = await writeMemoryFile(dir, first);

    expect(await index.sync(dir)).toEqual([]);
    expect(index.get(first.id)?.title).toBe("Pertama");

    const second = memory({ title: "Kedua", body: "Isi kedua." });
    await writeMemoryFile(dir, second);
    expect(await index.sync(dir)).toEqual([]);
    expect(index.list({}).map((item) => item.title).sort()).toEqual(["Kedua", "Pertama"]);

    const edited = { ...first, title: "Pertama diubah" };
    await writeMemoryFile(dir, edited, written.relPath);
    await index.sync(dir);
    expect(index.get(first.id)?.title).toBe("Pertama diubah");

    await unlink(join(dir, "profile", memoryFileName(first)));
    await index.sync(dir);
    expect(index.get(first.id)).toBeNull();
    expect(index.list({}).map((item) => item.id)).toEqual([second.id]);
    index.close();
  });

  test("kolom replaces disimpan dan dikembalikan", async () => {
    const index = new MemoryIndex();
    const target = crypto.randomUUID();
    const item = memory({ status: "proposed", replaces: target });
    await writeMemoryFile(dir, item);
    await index.sync(dir);
    expect(index.get(item.id)?.replaces).toBe(target);

    const biasa = memory({ title: "Biasa" });
    await writeMemoryFile(dir, biasa);
    await index.sync(dir);
    expect(index.get(biasa.id)?.replaces).toBeNull();
    index.close();
  });

  test("berkas diedit tangan terdeteksi meski id sama", async () => {
    const index = new MemoryIndex();
    const item = memory({ title: "Awal" });
    await writeMemoryFile(dir, item);
    await index.sync(dir);

    const path = join(dir, "profile", memoryFileName(item));
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("title: \"Awal\"", "title: \"Diedit tangan\""));
    await index.sync(dir);

    expect(index.get(item.id)?.title).toBe("Diedit tangan");
    index.close();
  });

  test("berkas rusak masuk problems tanpa menggagalkan yang lain", async () => {
    const valid = memory({ title: "Valid" });
    await writeMemoryFile(dir, valid);
    await mkdir(join(dir, "profile"), { recursive: true });
    const brokenName = `${crypto.randomUUID()}.md`;
    await writeFile(join(dir, "profile", brokenName), "rusak", { mode: 0o600 });

    const index = new MemoryIndex();
    const problems = await index.sync(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe(`profile/${brokenName}`);
    expect(index.get(valid.id)?.title).toBe("Valid");
    index.close();
  });

  test("projects/<kunci>/_project.json dipetakan balik", async () => {
    const projectKey = "/tmp/proyek-a";
    const item = memory({ layer: "project", projectKey, title: "Proyek" });
    await writeMemoryFile(dir, item);
    const mapping = JSON.parse(
      await readFile(join(dir, "projects", projectFolderName(projectKey), "_project.json"), "utf8"),
    ) as { projectKey: string };
    expect(mapping.projectKey).toBe(projectKey);

    const index = new MemoryIndex();
    await index.sync(dir);
    expect(index.get(item.id)?.projectKey).toBe(projectKey);
    index.close();
  });

  test("_project.json hilang membuat berkas proyek jadi problem", async () => {
    const projectKey = "/tmp/proyek-b";
    const item = memory({ layer: "project", projectKey });
    await writeMemoryFile(dir, item);
    const folder = join(dir, "projects", projectFolderName(projectKey));
    await unlink(join(folder, "_project.json"));

    const index = new MemoryIndex();
    const problems = await index.sync(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("pemetaan proyek");
    index.close();
  });
});

describe("kueri FTS", () => {
  test("judul dan isi dapat dicari", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(dir, memory({ title: "Perintah tes", body: "bun test" }));
    await writeMemoryFile(dir, memory({ title: "Gaya jawaban", body: "Bahasa Indonesia" }));
    await index.sync(dir);

    expect(index.list({ q: "bun" }).map((item) => item.title)).toEqual(["Perintah tes"]);
    expect(index.list({ q: "indonesia" }).map((item) => item.title)).toEqual(["Gaya jawaban"]);
    index.close();
  });

  test("kueri berisi karakter FTS tidak melempar", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(dir, memory({ title: "Perintah tes", body: "bun test" }));
    await index.sync(dir);

    const hostile = ['"', '""', "*", "OR", "NEAR(", "-x", "a OR b", "NEAR(", "^", "()", "---"];
    for (const q of hostile) {
      expect(() => index.list({ q })).not.toThrow();
    }
    const withQuote = index.list({ q: 'perintah "tes' });
    expect(withQuote.map((item) => item.title)).toEqual(["Perintah tes"]);
    index.close();
  });

  test("kueri hanya tanda kutip tidak melempar dan aman", () => {
    const index = new MemoryIndex();
    expect(() => index.list({ q: '"""' })).not.toThrow();
    expect(index.list({ q: '"""' })).toEqual([]);
    index.close();
  });
});

describe("pencocokan mode any", () => {
  const commandQuery = "perintah tes proyek test command";

  async function seedCommand(index: MemoryIndex): Promise<void> {
    await writeMemoryFile(
      dir,
      memory({ title: "Perintah tes", body: "Perintah tes proyek ini adalah bun test --bail." }),
    );
    await writeMemoryFile(
      dir,
      memory({ title: "Gaya jawaban", body: "Jawab dalam bahasa Indonesia yang ringkas." }),
    );
    await index.sync(dir);
  }

  test("mode any menemukan kueri multi-kata yang sebagian tidak cocok", async () => {
    const index = new MemoryIndex();
    await seedCommand(index);

    expect(index.list({ q: commandQuery, match: "all" })).toEqual([]);
    expect(index.list({ q: commandQuery, match: "any" }).map((item) => item.title)).toEqual([
      "Perintah tes",
    ]);
    // Bawaan tetap AND.
    expect(index.list({ q: commandQuery })).toEqual([]);
    index.close();
  });

  test("urutan bm25: cocok lebih banyak token muncul lebih dulu", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(
      dir,
      memory({ title: "Sedikit", body: "ada kata alpha saja di sini" }),
    );
    await writeMemoryFile(
      dir,
      memory({ title: "Banyak", body: "alpha beta gamma delta semuanya ada" }),
    );
    await index.sync(dir);

    const order = index.list({ q: "alpha beta gamma delta", match: "any" });
    expect(order.map((item) => item.title)).toEqual(["Banyak", "Sedikit"]);
    index.close();
  });

  test("token hostile tidak melempar dan tidak menginjeksi di mode any", async () => {
    const index = new MemoryIndex();
    await seedCommand(index);

    const hostile = [
      '"perintah"',
      'perintah OR *',
      'perintah OR "tes"',
      "NEAR(perintah tes)",
      "-perintah",
      'perintah" OR 1=1 --',
      "OR NEAR( *",
    ];
    for (const q of hostile) {
      expect(() => index.list({ q, match: "any" })).not.toThrow();
    }
    // Hanya token yang cocok yang dipakai; tidak ada hasil dari sintaks injeksi.
    const injected = index.list({ q: '"perintah" OR 1=1 --', match: "any" });
    expect(injected.map((item) => item.title)).toEqual(["Perintah tes"]);
    index.close();
  });

  test("filter status, layer, dan project tetap berlaku di mode any", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(dir, memory({ title: "Profil", body: "bun test perintah" }));
    await writeMemoryFile(
      dir,
      memory({
        layer: "project",
        projectKey: "/tmp/p1",
        title: "P1",
        body: "bun test perintah",
      }),
    );
    await writeMemoryFile(
      dir,
      memory({
        layer: "project",
        projectKey: "/tmp/p2",
        title: "P2",
        body: "bun test perintah",
        status: "proposed",
      }),
    );
    await index.sync(dir);

    const scoped = index.list({ q: "bun command", match: "any", project: "/tmp/p1" });
    expect(scoped.map((item) => item.title).sort()).toEqual(["P1", "Profil"]);
    expect(scoped.map((item) => item.title)).not.toContain("P2");

    expect(
      index
        .list({ q: "bun command", match: "any", status: "proposed" })
        .map((item) => item.title),
    ).toEqual(["P2"]);
    expect(
      index
        .list({ q: "bun command", match: "any", status: "active" })
        .map((item) => item.title)
        .sort(),
    ).toEqual(["P1", "Profil"]);
    expect(
      index
        .list({ q: "bun command", match: "any", project: "/tmp/p2", status: "proposed" })
        .map((item) => item.title),
    ).toEqual(["P2"]);
    expect(
      index
        .list({ q: "bun command", match: "any", layer: "profile" })
        .map((item) => item.title),
    ).toEqual(["Profil"]);
    index.close();
  });
});

describe("toFtsQuery", () => {
  test("membungkus token dan membuang kutip", () => {
    expect(toFtsQuery("halo dunia")).toBe('"halo" "dunia"');
    expect(toFtsQuery('a"b c')).toBe('"ab" "c"');
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery('"""')).toBe("");
    expect(toFtsQuery("OR AND NEAR(")).toBe('"OR" "AND" "NEAR("');
  });

  test("any: OR antar token, membuang kutip dan stopword", () => {
    expect(toFtsAnyQuery("halo dunia")).toBe('"halo" OR "dunia"');
    expect(toFtsAnyQuery('a"b c')).toBe('"ab"');
    expect(toFtsAnyQuery("   ")).toBe("");
    expect(toFtsAnyQuery('"""')).toBe("");
    expect(toFtsAnyQuery("perintah tes proyek test command")).toBe(
      '"perintah" OR "tes" OR "proyek" OR "test" OR "command"',
    );
    // Stopword dan token 1 karakter dibuang bila masih ada token lain.
    expect(toFtsAnyQuery("apa itu yang dan di ke untuk the is")).toBe('"apa"');
    // Bila semua terbuang, token asli dipakai.
    expect(toFtsAnyQuery("the a is")).toBe('"the" OR "a" OR "is"');
  });
});

describe("pemulihan indeks", () => {
  test("indeks dihapus lalu dibangun ulang dari berkas dengan hasil sama", async () => {
    const item = memory({ title: "Bertahan", body: "Isi bertahan." });
    await writeMemoryFile(dir, item);

    const first = new MemoryIndex(join(dir, "index.db"));
    await first.sync(dir);
    expect(first.list({}).map((entry) => entry.id)).toEqual([item.id]);
    first.close();

    await unlink(join(dir, "index.db"));

    const rebuilt = new MemoryIndex(join(dir, "index.db"));
    await rebuilt.sync(dir);
    expect(rebuilt.get(item.id)?.title).toBe("Bertahan");
    expect(rebuilt.list({ q: "bertahan" }).map((entry) => entry.id)).toEqual([item.id]);
    rebuilt.close();
  });

  test("indeks korup dibuang lalu dibangun ulang", async () => {
    const item = memory({ title: "Anti korup" });
    await writeMemoryFile(dir, item);
    const indexPath = join(dir, "index.db");
    const created = new MemoryIndex(indexPath);
    await created.sync(dir);
    created.close();

    await writeFile(indexPath, "ini bukan database sqlite");

    const rebuilt = new MemoryIndex(indexPath);
    await rebuilt.sync(dir);
    expect(rebuilt.get(item.id)?.title).toBe("Anti korup");
    rebuilt.close();
  });

  test("versi skema lebih baru dibuang lalu dibangun ulang", async () => {
    const item = memory({ title: "Versi baru" });
    await writeMemoryFile(dir, item);
    const indexPath = join(dir, "index.db");
    const created = new MemoryIndex(indexPath);
    await created.sync(dir);
    created.close();

    const raw = new Database(indexPath);
    raw.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    raw.close();

    const rebuilt = new MemoryIndex(indexPath);
    await rebuilt.sync(dir);
    expect(rebuilt.get(item.id)?.title).toBe("Versi baru");
    expect(rebuilt.list({}).map((entry) => entry.id)).toEqual([item.id]);
    rebuilt.close();
  });

  test("indeks versi lama dimigrasi tanpa kehilangan isi", async () => {
    const item = memory({ title: "Lama" });
    await writeMemoryFile(dir, item);
    const indexPath = join(dir, "index.db");
    const created = new MemoryIndex(indexPath);
    await created.sync(dir);
    created.close();

    // Turunkan ke skema versi 1: kolom `replaces` belum ada.
    const raw = new Database(indexPath);
    raw.run("ALTER TABLE memories DROP COLUMN replaces");
    raw.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    raw.close();

    const rebuilt = new MemoryIndex(indexPath);
    await rebuilt.sync(dir);
    expect(rebuilt.get(item.id)?.title).toBe("Lama");
    expect(rebuilt.get(item.id)?.replaces).toBeNull();
    rebuilt.close();
  });

  test("berkas indeks 0600 dan folder 0700", async () => {
    const item = memory();
    await writeMemoryFile(dir, item);
    const { stat } = await import("node:fs/promises");
    const indexPath = join(dir, "sub", "index.db");
    const index = new MemoryIndex(indexPath);
    await index.sync(dir);
    index.close();
    expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sub"))).mode & 0o777).toBe(0o700);
  });
});

describe("list, get, counts, dan batas", () => {
  test("filter status, layer, project, dan limit", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(dir, memory({ title: "Profil" }));
    await writeMemoryFile(dir, memory({ layer: "project", projectKey: "/tmp/p1", title: "P1", status: "proposed" }));
    await writeMemoryFile(dir, memory({ layer: "project", projectKey: "/tmp/p2", title: "P2" }));
    await index.sync(dir);

    expect(index.list({ status: "proposed" }).map((item) => item.title)).toEqual(["P1"]);
    expect(index.list({ layer: "profile" }).map((item) => item.title)).toEqual(["Profil"]);
    expect(index.list({ project: "/tmp/p1" }).map((item) => item.title).sort()).toEqual(["P1", "Profil"]);
    expect(index.list({ limit: 1 })).toHaveLength(1);
    expect(index.list({ q: "p2", project: "/tmp/p1" })).toEqual([]);
    index.close();
  });

  test("counts dan countActive/countProposed", async () => {
    const index = new MemoryIndex();
    await writeMemoryFile(dir, memory({ title: "A", status: "active" }));
    await writeMemoryFile(dir, memory({ title: "B", status: "active" }));
    await writeMemoryFile(dir, memory({ title: "C", status: "proposed" }));
    await index.sync(dir);

    expect(index.counts()).toEqual({ proposed: 1, active: 2 });
    expect(index.countActive("profile", null)).toBe(2);
    expect(index.countActive("project", "/tmp/x")).toBe(0);
    expect(index.countProposed()).toBe(1);
    index.close();
  });

  test("urutan updatedAt turun", async () => {
    const index = new MemoryIndex();
    const older = memory({ title: "Lama", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = memory({ title: "Baru", updatedAt: "2026-06-01T00:00:00.000Z" });
    await writeMemoryFile(dir, older);
    await writeMemoryFile(dir, newer);
    await index.sync(dir);
    expect(index.list({}).map((item) => item.title)).toEqual(["Baru", "Lama"]);
    index.close();
  });
});

describe("serialisasi aman lewat index", () => {
  test("berkas dengan rahasia tidak masuk indeks", async () => {
    const item = memory({ body: "kunci sk-abcdefgh12345678 ada di sini" });
    await writeMemoryFile(dir, item);
    const index = new MemoryIndex();
    const problems = await index.sync(dir);
    expect(problems).toHaveLength(1);
    expect(index.list({})).toEqual([]);
    index.close();
  });

  test("writeMemoryFile menulis ulang isi yang sama dengan sha", async () => {
    const item = memory();
    const written = await writeMemoryFile(dir, item);
    const text = await readFile(written.absPath, "utf8");
    expect(text).toBe(serializeMemory(item));
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.size).toBeGreaterThan(0);
  });
});
