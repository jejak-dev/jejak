import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeMemorySync,
  claudeSyncDescription,
  claudeSyncFileName,
  claudeSyncHash,
  claudeSyncType,
  readClaudeSyncMarker,
  renderClaudeSyncFile,
  stripHashLine,
  yamlScalar,
} from "../src/server/memory/claude-memory-sync";
import { claudeMemoryDir, type ClaudeProjectEntry } from "../src/server/memory/claude-memory";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { MemoryService } from "../src/server/memory/memory-service";
import type { Memory } from "../src/server/memory/memory-files";

let dir: string;
let claudeRoot: string;
let projectPath: string;
let projectKey: string;

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-claude-sync-"));
  claudeRoot = join(dir, "claude");
  projectPath = join(dir, "proyek");
  await mkdir(projectPath, { recursive: true });
  projectKey = await realpath(projectPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: ID_A,
    layer: "project",
    projectKey,
    title: "Gaya kode",
    body: "Gunakan dua spasi untuk indentasi.",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at: "2026-01-01T00:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    replaces: null,
    ...overrides,
  };
}

function makeSync(
  options: {
    enabled?: () => boolean;
    projects?: () => readonly ClaudeProjectEntry[];
    memories?: () => Promise<Memory[]>;
  } = {},
): ClaudeMemorySync {
  return new ClaudeMemorySync({
    configRoot: claudeRoot,
    enabled: options.enabled ?? (() => true),
    projects:
      options.projects ??
      (() => [{ key: projectPath, path: projectPath }]),
    ...(options.memories === undefined ? {} : { memories: options.memories }),
  });
}

function memoryDir(): string {
  return claudeMemoryDir(claudeRoot, projectPath);
}

function filePath(id: string): string {
  return join(memoryDir(), `jejak_${id}.md`);
}

/* ---------- Render dan hash ---------- */

describe("render berkas memory", () => {
  test("frontmatter memuat name, description, dan metadata Jejak", () => {
    const rendered = renderClaudeSyncFile(makeMemory());
    expect(rendered.fileName).toBe(`jejak_${ID_A}.md`);
    expect(rendered.content.startsWith("---\n")).toBe(true);
    expect(rendered.content).toContain(`name: Gaya kode`);
    expect(rendered.content).toContain("description: Gunakan dua spasi untuk indentasi.");
    expect(rendered.content).toContain("  type: feedback");
    expect(rendered.content).toContain(`  jejak_id: ${ID_A}`);
    expect(rendered.content).toContain("  jejak_confidence: confirmed");
    expect(rendered.content).toContain(`  jejak_hash: ${rendered.hash}`);
    expect(rendered.content.endsWith("Gunakan dua spasi untuk indentasi.\n")).toBe(true);
  });

  test("nilai YAML berisiko ditulis dalam kutip", () => {
    expect(yamlScalar("Gaya kode")).toBe("Gaya kode");
    expect(yamlScalar("gaya: kode")).toBe('"gaya: kode"');
    expect(yamlScalar("gaya # kode")).toBe('"gaya # kode"');
    expect(yamlScalar("gaya\nkode")).toBe('"gaya\\nkode"');
    expect(yamlScalar("true")).toBe('"true"');
    expect(yamlScalar("")).toBe('""');
    const rendered = renderClaudeSyncFile(makeMemory({ title: "Gaya: kode" }));
    expect(rendered.content).toContain('name: "Gaya: kode"');
  });

  test("deskripsi satu baris dan paling banyak 150 karakter", () => {
    expect(claudeSyncDescription(makeMemory())).toBe("Gunakan dua spasi untuk indentasi.");
    const panjang = makeMemory({
      body: `${"a".repeat(400)}\nbaris kedua`,
    });
    const description = claudeSyncDescription(panjang);
    expect(description.length).toBeLessThanOrEqual(150);
    expect(description).not.toContain("\n");
  });

  test("tipe memory mengikuti asalnya", () => {
    expect(claudeSyncType(makeMemory({ origin: { kind: "manual", at: "x" } }))).toBe(
      "feedback",
    );
    expect(claudeSyncType(makeMemory({ origin: { kind: "interview", at: "x" } }))).toBe(
      "feedback",
    );
    expect(claudeSyncType(makeMemory({ origin: { kind: "session", at: "x" } }))).toBe(
      "project",
    );
    expect(
      claudeSyncType(
        makeMemory({
          origin: { kind: "file", at: "x", file: "/tmp/a", fileSha256: "a".repeat(64) },
        }),
      ),
    ).toBe("project");
  });

  test("hash dihitung atas isi tanpa baris jejak_hash", () => {
    const rendered = renderClaudeSyncFile(makeMemory());
    expect(rendered.hash).toHaveLength(64);
    expect(claudeSyncHash(rendered.content)).toBe(rendered.hash);
    expect(stripHashLine(rendered.content)).not.toContain("jejak_hash");
    const marker = readClaudeSyncMarker(rendered.content);
    expect(marker.jejakId).toBe(ID_A);
    expect(marker.jejakHash).toBe(rendered.hash);
  });

  test("nama berkas hanya untuk id yang valid", () => {
    expect(claudeSyncFileName(ID_A)).toBe(`jejak_${ID_A}.md`);
    expect(() => claudeSyncFileName("../../etc/passwd")).toThrow();
  });
});

/* ---------- Tulis, perbarui, hapus ---------- */

describe("sinkron berkas memory", () => {
  test("memory aktif ditulis beserta indeks MEMORY.md", async () => {
    const sync = makeSync();
    const outcome = await sync.apply(makeMemory());
    expect(outcome.status).toBe("ditulis");

    const content = await readFile(filePath(ID_A), "utf8");
    expect(content).toContain(`  jejak_id: ${ID_A}`);
    const info = await stat(filePath(ID_A));
    expect(info.mode & 0o777).toBe(0o600);

    const index = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
    expect(index.trim()).toBe(`- [Gaya kode](jejak_${ID_A}.md) — Gunakan dua spasi untuk indentasi.`);
  });

  test("perbarui memory menulis ulang berkas dan satu baris indeks", async () => {
    const sync = makeSync();
    await sync.apply(makeMemory());
    const outcome = await sync.apply(
      makeMemory({ title: "Gaya kode baru", body: "Isi baru." }),
    );
    expect(outcome.status).toBe("diperbarui");
    const content = await readFile(filePath(ID_A), "utf8");
    expect(content).toContain("name: Gaya kode baru");
    const index = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
    expect(index.trim().split("\n")).toHaveLength(1);
    expect(index).toContain("Gaya kode baru");
  });

  test("hapus memory menghapus berkas dan baris indeks", async () => {
    const sync = makeSync();
    await sync.apply(makeMemory());
    await sync.apply(makeMemory({ id: ID_B, title: "Memory lain" }));
    const outcome = await sync.remove(makeMemory());
    expect(outcome.status).toBe("dihapus");
    expect(await readFile(filePath(ID_A), "utf8").catch(() => null)).toBeNull();
    const index = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
    expect(index).not.toContain(ID_A);
    expect(index).toContain(ID_B);
  });

  test("baris MEMORY.md milik Claude tetap utuh", async () => {
    await mkdir(memoryDir(), { recursive: true });
    await writeFile(
      join(memoryDir(), "MEMORY.md"),
      "- [Catatan Claude](catatan.md) — ditulis manual\n",
      "utf8",
    );
    const sync = makeSync();
    await sync.apply(makeMemory());
    const index = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
    expect(index).toContain("- [Catatan Claude](catatan.md) — ditulis manual");
    expect(index).toContain(`(jejak_${ID_A}.md)`);
  });

  test("berkas lain di folder Claude tak pernah disentuh", async () => {
    await mkdir(memoryDir(), { recursive: true });
    const lain = join(memoryDir(), "catatan.md");
    await writeFile(lain, "isi catatan claude", "utf8");
    const milikLain = join(memoryDir(), `jejak_${ID_B}.md`);
    await writeFile(milikLain, "---\nname: Lain\n---\nisi", "utf8");

    const sync = makeSync();
    await sync.apply(makeMemory());
    expect(await readFile(lain, "utf8")).toBe("isi catatan claude");
    expect(await readFile(milikLain, "utf8")).toBe("---\nname: Lain\n---\nisi");
  });

  test("berkas yang diubah di luar Jejak dilaporkan sebagai konflik", async () => {
    const sync = makeSync();
    await sync.apply(makeMemory());
    const content = await readFile(filePath(ID_A), "utf8");
    await writeFile(filePath(ID_A), `${content}\ncatatan tambahan Claude\n`, "utf8");

    const outcome = await sync.apply(makeMemory({ body: "Isi baru." }));
    expect(outcome.status).toBe("konflik");
    expect(outcome.file).toBe(`jejak_${ID_A}.md`);
    const after = await readFile(filePath(ID_A), "utf8");
    expect(after).toContain("catatan tambahan Claude");
    expect(after).not.toContain("Isi baru.");
  });

  test("berkas yang diubah di luar Jejak tak dihapus", async () => {
    const sync = makeSync();
    await sync.apply(makeMemory());
    const content = await readFile(filePath(ID_A), "utf8");
    await writeFile(filePath(ID_A), `${content}\ntambahan\n`, "utf8");
    const outcome = await sync.remove(makeMemory());
    expect(outcome.status).toBe("konflik");
    expect(await readFile(filePath(ID_A), "utf8")).toContain("tambahan");
  });

  test("path traversal ditolak", async () => {
    const sync = makeSync();
    const outcome = await sync.apply(
      makeMemory({ id: "../../etc/passwd" as Memory["id"] }),
    );
    expect(outcome.status).toBe("dilewati");
    expect(await readFile(join(dir, "etc", "passwd"), "utf8").catch(() => null)).toBeNull();
  });

  test("symlink tak pernah diikuti", async () => {
    await mkdir(memoryDir(), { recursive: true });
    const target = join(dir, "luar.txt");
    await writeFile(target, "isi luar", "utf8");
    await symlink(target, filePath(ID_A));
    const sync = makeSync();
    const outcome = await sync.apply(makeMemory());
    expect(outcome.status).toBe("dilewati");
    expect(await readFile(target, "utf8")).toBe("isi luar");
  });

  test("rahasia ditolak dan tak ditulis", async () => {
    const sync = makeSync();
    const outcome = await sync.apply(
      makeMemory({ body: "token API: sk-ant-abcdefgh12345678" }),
    );
    expect(outcome.status).toBe("ditolak-rahasia");
    expect(await readFile(filePath(ID_A), "utf8").catch(() => null)).toBeNull();
  });

  test("hanya memory proyek aktif yang ditulis", async () => {
    const sync = makeSync();
    const profil = await sync.apply(
      makeMemory({ layer: "profile", projectKey: null }),
    );
    expect(profil.status).toBe("dilewati");
    const usulan = await sync.apply(makeMemory({ status: "proposed" }));
    expect(usulan.status).toBe("dilewati");
    const arsip = await sync.apply(makeMemory({ status: "archived" }));
    expect(arsip.status).toBe("dilewati");
    expect(await readFile(filePath(ID_A), "utf8").catch(() => null)).toBeNull();
  });

  test("saklar mati berarti tak ada berkas yang ditulis", async () => {
    const sync = makeSync({ enabled: () => false });
    const outcome = await sync.apply(makeMemory());
    expect(outcome.status).toBe("dilewati");
    expect(await readFile(filePath(ID_A), "utf8").catch(() => null)).toBeNull();
  });
});

/* ---------- Sinkron penuh ---------- */

describe("sinkron penuh", () => {
  test("menulis memory aktif dan idempoten", async () => {
    const memories = [makeMemory(), makeMemory({ id: ID_B, title: "Memory lain" })];
    const sync = makeSync({ memories: async () => memories });
    const first = await sync.run();
    expect(first.ditulis).toBe(2);
    expect(first.konflik).toEqual([]);

    const second = await sync.run();
    expect(second.ditulis).toBe(0);
    expect(second.diperbarui).toBe(2);
  });

  test("memori yang tak aktif dihapus dan konflik dilaporkan", async () => {
    const memory = makeMemory();
    const sync = makeSync({ memories: async () => [memory] });
    await sync.run();

    const content = await readFile(filePath(ID_A), "utf8");
    await writeFile(filePath(ID_A), `${content}\ntambahan\n`, "utf8");
    const summary = await sync.run();
    expect(summary.konflik).toEqual([`jejak_${ID_A}.md`]);
    expect(await readFile(filePath(ID_A), "utf8")).toContain("tambahan");
  });
});

/* ---------- Sinkron per peristiwa ---------- */

describe("sinkron per peristiwa", () => {
  let store: FileMemoryStore;

  beforeEach(() => {
    store = new FileMemoryStore({ dir: join(dir, "jejak-memory") });
  });

  afterEach(() => {
    store.close();
  });

  function serviceWith(sync: ClaudeMemorySync): MemoryService {
    const service = new MemoryService({ store });
    service.setChangeListener((event) =>
      event.kind === "simpan"
        ? sync.apply(event.memory).then(() => undefined)
        : sync.remove(event.memory).then(() => undefined),
    );
    return service;
  }

  test("memory aktif ditulis, diubah, diarsipkan, lalu dihapus", async () => {
    const sync = makeSync();
    const service = serviceWith(sync);

    const created = await service.create({
      layer: "project",
      projectKey,
      title: "Gaya kode",
      body: "Gunakan dua spasi.",
    });
    const content = await readFile(filePath(created.id), "utf8");
    expect(content).toContain(`  jejak_id: ${created.id}`);

    await service.update(created.id, { body: "Gunakan empat spasi." });
    const updated = await readFile(filePath(created.id), "utf8");
    expect(updated).toContain("Gunakan empat spasi.");

    await service.archive(created.id);
    expect(await readFile(filePath(created.id), "utf8").catch(() => null)).toBeNull();

    await service.create({
      layer: "project",
      projectKey,
      title: "Memory kedua",
      body: "Isi kedua.",
    });
    const second = (await service.list({ status: "active" })).items[0]!;
    await service.delete(second.id);
    expect(await readFile(filePath(second.id), "utf8").catch(() => null)).toBeNull();
  });

  test("usulan yang diterima ikut ditulis", async () => {
    const sync = makeSync();
    const service = serviceWith(sync);
    const proposal = await service.propose({
      layer: "project",
      projectKey,
      title: "Usulan",
      body: "Isi usulan.",
    });
    expect(await readFile(filePath(proposal.id), "utf8").catch(() => null)).toBeNull();
    await service.accept(proposal.id);
    expect(await readFile(filePath(proposal.id), "utf8")).toContain(
      `  jejak_id: ${proposal.id}`,
    );
  });

  test("kegagalan sinkron tak menggagalkan operasi memory", async () => {
    const service = new MemoryService({ store });
    service.setChangeListener(() => {
      throw new Error("sinkron gagal");
    });
    const created = await service.create({
      layer: "project",
      projectKey,
      title: "Tetap jalan",
      body: "Isi memory.",
    });
    expect(created.status).toBe("active");
  });
});
