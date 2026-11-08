import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryError, MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore, type MemoryStore } from "../src/server/memory/memory-store";
import type { Memory } from "../src/server/memory/memory-files";
import type { MemoryCounts, MemoryListQuery, MemoryProblem } from "../src/server/memory/memory-index";

let dir: string;
let store: FileMemoryStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-service-"));
  store = new FileMemoryStore({ dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Store tiruan untuk menguji batas tanpa menulis ratusan berkas. */
class StubStore implements MemoryStore {
  readonly dir = ":stub:";
  activeCount = 0;
  proposedCount = 0;
  readonly items = new Map<string, Memory>();
  problemsList: MemoryProblem[] = [];

  async sync(): Promise<MemoryProblem[]> {
    return this.problemsList;
  }
  problems(): MemoryProblem[] {
    return this.problemsList;
  }
  async list(query: MemoryListQuery = {}): Promise<Memory[]> {
    let items = [...this.items.values()];
    if (query.status !== undefined) items = items.filter((m) => m.status === query.status);
    if (query.layer !== undefined) items = items.filter((m) => m.layer === query.layer);
    if (query.project !== undefined) {
      items = items.filter((m) => m.layer === "profile" || m.projectKey === query.project);
    }
    return items.slice(0, query.limit ?? 100);
  }
  async get(id: string): Promise<Memory | null> {
    return this.items.get(id) ?? null;
  }
  async create(memory: Memory): Promise<Memory> {
    this.items.set(memory.id, memory);
    return memory;
  }
  async update(memory: Memory): Promise<Memory> {
    this.items.set(memory.id, memory);
    return memory;
  }
  async setStatus(
    id: string,
    status: Memory["status"],
    confidence: Memory["confidence"],
    decidedAt: string | null,
  ): Promise<Memory | null> {
    const current = this.items.get(id);
    if (current === undefined) return null;
    const updated = { ...current, status, confidence, decidedAt };
    this.items.set(id, updated);
    return updated;
  }
  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
  async counts(): Promise<MemoryCounts> {
    return { proposed: this.proposedCount, active: this.activeCount };
  }
  async countActive(): Promise<number> {
    return this.activeCount;
  }
  async countProposed(): Promise<number> {
    return this.proposedCount;
  }
  close(): void {}
}

function service(withCwd = dir): MemoryService {
  return new MemoryService({ store, cwd: withCwd });
}

async function createValid(overrides: Partial<Parameters<MemoryService["create"]>[0]> = {}) {
  return service().create({ layer: "profile", title: "Judul", body: "Isi", ...overrides });
}

describe("validasi create", () => {
  test("layer wajib dan hanya profile/project", async () => {
    await expect(service().create({ layer: "lain", title: "a", body: "b" })).rejects.toThrow(
      /layer/,
    );
    await expect(service().create({ title: "a", body: "b" })).rejects.toThrow(/layer/);
  });

  test("profile tidak boleh punya projectKey, project wajib", async () => {
    await expect(
      service().create({ layer: "profile", projectKey: "/tmp/x", title: "a", body: "b" }),
    ).rejects.toThrow(/projectKey/);
    await expect(
      service().create({ layer: "project", title: "a", body: "b" }),
    ).rejects.toThrow(/projectKey/);
    await expect(
      service().create({ layer: "project", projectKey: "", title: "a", body: "b" }),
    ).rejects.toThrow(/projectKey/);
    await expect(
      service().create({ layer: "project", projectKey: "relatif/x", title: "a", body: "b" }),
    ).rejects.toThrow(/absolut/);
    await expect(
      service().create({
        layer: "project",
        projectKey: `/${"a".repeat(1024)}`,
        title: "a",
        body: "b",
      }),
    ).rejects.toThrow(/projectKey/);
  });

  test("panjang judul dan isi", async () => {
    await expect(createValid({ title: "" })).rejects.toThrow(/title/);
    await expect(createValid({ title: "a".repeat(121) })).rejects.toThrow(/title/);
    await expect(createValid({ body: "" })).rejects.toThrow(/body/);
    await expect(createValid({ body: "a".repeat(2001) })).rejects.toThrow(/body/);
    const longTitle = "judul panjang ".repeat(9).trim().slice(0, 120);
    const longBody = "isi memory yang cukup panjang ".repeat(80).trim().slice(0, 2000);
    const atLimit = await createValid({ title: longTitle, body: longBody });
    expect(atLimit.title.length).toBeLessThanOrEqual(120);
    expect(atLimit.body.length).toBeLessThanOrEqual(2000);
  });

  test("tipe salah dan karakter kontrol ditolak", async () => {
    await expect(createValid({ title: 42 as unknown as string })).rejects.toThrow(/teks/);
    await expect(createValid({ body: "halo\u0000dunia" })).rejects.toThrow(/kontrol/);
    await expect(createValid({ body: "halo\u0007" })).rejects.toThrow(/kontrol/);
    // Tab dan baris baru tetap diizinkan.
    const ok = await createValid({ body: "baris satu\n\tbaris dua" });
    expect(ok.body).toContain("\n");
  });

  test("pembuatan manual langsung active dan confirmed dengan origin manual", async () => {
    const created = await createValid();
    expect(created.status).toBe("active");
    expect(created.confidence).toBe("confirmed");
    expect(created.origin.kind).toBe("manual");
    expect(created.staleReason).toBeNull();
    expect(created.decidedAt).toBeNull();
  });
});

describe("penjaga rahasia pada jalur tulis", () => {
  test("create dengan rahasia ditolak tanpa membocorkan teks", async () => {
    const secret = "sk-abcdefgh12345678";
    const error = await service()
      .create({ layer: "profile", title: "Kunci", body: `pakai ${secret}` })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryError);
    const message = (error as MemoryError).message;
    expect(message).toContain("rahasia");
    expect(message).toContain("kunci API");
    expect(message).not.toContain(secret);
    expect((error as MemoryError).code).toBe("tidak-valid");
  });

  test("create dengan rahasia di judul juga ditolak", async () => {
    await expect(
      service().create({ layer: "profile", title: "Bearer abcdefghijklmnop", body: "b" }),
    ).rejects.toThrow(/rahasia/);
  });

  test("update dengan rahasia ditolak dan berkas lama tidak berubah", async () => {
    const created = await createValid({ body: "Isi bersih" });
    const secret = "ghp_abcdefghijklmnopqrst";
    await expect(service().update(created.id, { body: `token ${secret}` })).rejects.toThrow(
      /rahasia/,
    );
    const current = await service().get(created.id);
    expect(current.body).toBe("Isi bersih");
  });
});

describe("transisi status", () => {
  test("accept hanya dari proposed dan mengisi decidedAt", async () => {
    const proposed = await service().propose({ layer: "profile", title: "Usul", body: "Isi" });
    const accepted = await service().accept(proposed.id);
    expect(accepted.status).toBe("active");
    expect(accepted.confidence).toBe("confirmed");
    expect(accepted.decidedAt).not.toBeNull();

    await expect(service().accept(proposed.id)).rejects.toThrow(/berpindah/);
  });

  test("reject hanya dari proposed", async () => {
    const proposed = await service().propose({ layer: "profile", title: "Usul", body: "Isi" });
    const rejected = await service().reject(proposed.id);
    expect(rejected.status).toBe("rejected");

    const active = await createValid();
    await expect(service().reject(active.id)).rejects.toThrow(/berpindah/);
  });

  test("archive hanya dari active", async () => {
    const active = await createValid();
    const archived = await service().archive(active.id);
    expect(archived.status).toBe("archived");
    expect(archived.confidence).toBe("confirmed");

    const proposed = await service().propose({ layer: "profile", title: "Usul", body: "Isi" });
    await expect(service().archive(proposed.id)).rejects.toThrow(/berpindah/);
  });

  test("transisi pada id tidak ada 404", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    for (const action of [
      () => service().accept(missing),
      () => service().reject(missing),
      () => service().archive(missing),
      () => service().get(missing),
      () => service().delete(missing),
    ]) {
      const error = await action().catch((caught: unknown) => caught);
      expect((error as MemoryError).code).toBe("tidak-ditemukan");
    }
  });

  test("kode galat transisi adalah konflik", async () => {
    const active = await createValid();
    const error = await service().accept(active.id).catch((caught: unknown) => caught);
    expect((error as MemoryError).code).toBe("konflik");
  });
});

describe("update", () => {
  test("hanya proposed/active yang bisa diubah", async () => {
    const archived = await service().archive((await createValid()).id);
    await expect(service().update(archived.id, { title: "Baru" })).rejects.toThrow(/berpindah|Hanya/);

    const rejected = await service().reject(
      (await service().propose({ layer: "profile", title: "U", body: "I" })).id,
    );
    await expect(service().update(rejected.id, { title: "Baru" })).rejects.toThrow();
  });

  test("mengubah memory active tetap confirmed dan memperbarui updatedAt", async () => {
    const created = await createValid();
    const later = new MemoryService({
      store,
      cwd: dir,
      now: () => new Date(Date.parse(created.updatedAt) + 60_000),
    });
    const updated = await later.update(created.id, { title: "Judul baru" });
    expect(updated.confidence).toBe("confirmed");
    expect(updated.status).toBe("active");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  test("tanpa field yang diubah ditolak", async () => {
    const created = await createValid();
    await expect(service().update(created.id, {})).rejects.toThrow(/Tidak ada field/);
  });
});

describe("propose", () => {
  test("selalu proposed dan tidak pernah active", async () => {
    const proposed = await service().propose({ layer: "profile", title: "Usul", body: "Isi" });
    expect(proposed.status).toBe("proposed");
    expect(proposed.confidence).toBe("inferred");
    const listed = await service().list({});
    expect(listed.items.some((item) => item.status === "active")).toBe(false);
  });

  test("from_code hanya bila berkas terverifikasi", async () => {
    await writeFile(join(dir, "kode.ts"), "export const x = 1;\n");
    const proposed = await service().propose({
      layer: "project",
      projectKey: dir,
      title: "Pakai x",
      body: "Ada di kode.",
      originFile: "kode.ts",
    });
    expect(proposed.confidence).toBe("from_code");
    expect(proposed.origin.kind).toBe("file");
    expect(proposed.origin.file).toBe("kode.ts");
    expect(proposed.origin.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proposed.status).toBe("proposed");
  });

  test("propose tanpa originFile tetap inferred", async () => {
    const proposed = await service().propose({ layer: "profile", title: "Usul", body: "Isi" });
    expect(proposed.confidence).toBe("inferred");
    expect(proposed.origin.kind).toBe("session");
  });

  test("berkas di luar cwd / .. / symlink keluar ditolak 400", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jejak-memory-outside-"));
    try {
      await writeFile(join(outside, "rahasia.ts"), "x");
      await symlink(join(outside, "rahasia.ts"), join(dir, "keluar.ts"));

      for (const originFile of ["../rahasia.ts", "/etc/hosts", "keluar.ts"]) {
        const error = await service()
          .propose({ layer: "profile", title: "Usul", body: "Isi", originFile })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MemoryError);
        expect((error as MemoryError).code).toBe("tidak-valid");
        expect((error as MemoryError).message).not.toContain(outside);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("berkas asal hilang ditolak dan direktori ditolak", async () => {
    await mkdir(join(dir, "folder"), { recursive: true });
    await expect(
      service().propose({ layer: "profile", title: "U", body: "I", originFile: "hilang.ts" }),
    ).rejects.toThrow(/tidak ditemukan/);
    await expect(
      service().propose({ layer: "profile", title: "U", body: "I", originFile: "folder" }),
    ).rejects.toThrow(/berkas biasa/);
  });
});

describe("batas jumlah", () => {
  test("500 active per lingkup ditolak 409", async () => {
    const stub = new StubStore();
    stub.activeCount = 500;
    const svc = new MemoryService({ store: stub });
    const error = await svc
      .create({ layer: "project", projectKey: "/tmp/x", title: "a", body: "b" })
      .catch((caught: unknown) => caught);
    expect((error as MemoryError).code).toBe("konflik");
    expect((error as MemoryError).message).toContain("500");
  });

  test("accept pada lingkup penuh ditolak", async () => {
    const stub = new StubStore();
    const svc = new MemoryService({ store: stub });
    const proposed = await svc.propose({ layer: "profile", title: "U", body: "I" });
    stub.activeCount = 500;
    const error = await svc.accept(proposed.id).catch((caught: unknown) => caught);
    expect((error as MemoryError).code).toBe("konflik");
  });

  test("201 usulan ke atas ditolak 409", async () => {
    const stub = new StubStore();
    stub.proposedCount = 200;
    const svc = new MemoryService({ store: stub });
    const error = await svc
      .propose({ layer: "profile", title: "U", body: "I" })
      .catch((caught: unknown) => caught);
    expect((error as MemoryError).code).toBe("konflik");
    expect((error as MemoryError).message).toContain("200");
  });
});

describe("basi", () => {
  test("hash sama -> null, berubah -> penanda, hilang -> penanda", async () => {
    const file = join(dir, "asal.ts");
    await writeFile(file, "v1");
    const proposed = await service().propose({
      layer: "project",
      projectKey: dir,
      title: "Asal",
      body: "Isi",
      originFile: "asal.ts",
    });

    const fresh = await service().get(proposed.id);
    expect(fresh.staleReason).toBeNull();

    await writeFile(file, "v2 berbeda");
    const changed = await service().get(proposed.id);
    expect(changed.staleReason).toBe("berkas asal berubah");

    await rm(file);
    const missing = await service().get(proposed.id);
    expect(missing.staleReason).toBe("berkas asal hilang");
  });

  test("memory tanpa origin berkas tidak ditandai", async () => {
    const created = await createValid();
    expect((await service().get(created.id)).staleReason).toBeNull();
  });

  test("berkas asal lebih besar dari 1 MiB diabaikan", async () => {
    const file = join(dir, "besar.ts");
    await writeFile(file, "a".repeat(1024 * 1024 + 10));
    const proposed = await service().propose({
      layer: "project",
      projectKey: dir,
      title: "Besar",
      body: "Isi",
      originFile: "besar.ts",
    });
    const read = await service().get(proposed.id);
    expect(read.staleReason).toBeNull();
  });

  test("proyek lain tidak diperiksa terhadap cwd ini", async () => {
    const file = join(dir, "asal.ts");
    await writeFile(file, "v1");
    const proposed = await service().propose({
      layer: "project",
      projectKey: dir,
      title: "Asal",
      body: "Isi",
      originFile: "asal.ts",
    });
    await writeFile(file, "v2");
    const otherCwd = await mkdtemp(join(tmpdir(), "jejak-memory-other-"));
    try {
      const otherService = new MemoryService({ store, cwd: otherCwd });
      expect((await otherService.get(proposed.id)).staleReason).toBeNull();
    } finally {
      await rm(otherCwd, { recursive: true, force: true });
    }
  });

  test("basi dihitung saat list tanpa menulis ke berkas", async () => {
    const file = join(dir, "asal.ts");
    await writeFile(file, "v1");
    await service().propose({
      layer: "project",
      projectKey: dir,
      title: "Asal",
      body: "Isi",
      originFile: "asal.ts",
    });
    await writeFile(file, "v2");
    const listed = await service().list({});
    expect(listed.items[0]?.staleReason).toBe("berkas asal berubah");
  });
});

describe("lingkup dan limit baca", () => {
  test("project = profil + proyek itu saja", async () => {
    const svc = service();
    await svc.create({ layer: "profile", title: "Profil", body: "p" });
    await svc.create({ layer: "project", projectKey: "/tmp/a", title: "A", body: "a" });
    await svc.create({ layer: "project", projectKey: "/tmp/b", title: "B", body: "b" });

    const scopeA = await svc.list({ project: "/tmp/a" });
    expect(scopeA.items.map((item) => item.title).sort()).toEqual(["A", "Profil"]);

    const scopeB = await svc.list({ project: "/tmp/b" });
    expect(scopeB.items.map((item) => item.title).sort()).toEqual(["B", "Profil"]);

    const all = await svc.list({});
    expect(all.items).toHaveLength(3);
  });

  test("dua proyek berbeda tidak saling melihat satu sama lain", async () => {
    const svc = service();
    await svc.create({ layer: "project", projectKey: "/tmp/a", title: "A", body: "a" });
    await svc.create({ layer: "project", projectKey: "/tmp/b", title: "B", body: "b" });
    expect((await svc.list({ project: "/tmp/a" })).items.map((i) => i.title)).toEqual(["A"]);
    expect((await svc.list({ project: "/tmp/b" })).items.map((i) => i.title)).toEqual(["B"]);
  });

  test("filter status, layer, dan q", async () => {
    const svc = service();
    await svc.create({ layer: "profile", title: "Perintah", body: "bun test" });
    await svc.propose({ layer: "profile", title: "Usulan gaya", body: "singkat" });

    expect((await svc.list({ status: "proposed" })).items).toHaveLength(1);
    expect((await svc.list({ layer: "profile" })).items).toHaveLength(2);
    expect((await svc.list({ q: "bun" })).items.map((i) => i.title)).toEqual(["Perintah"]);
    expect((await svc.list({ q: 'perintah "bun' })).items.map((i) => i.title)).toEqual([
      "Perintah",
    ]);
  });

  test("match any menemukan kueri multi-kata yang sebagian tidak cocok", async () => {
    const svc = service();
    await svc.create({
      layer: "profile",
      title: "Perintah tes",
      body: "Perintah tes proyek ini adalah bun test --bail.",
    });

    const query = "perintah tes proyek test command";
    expect((await svc.list({ q: query })).items).toEqual([]);
    expect((await svc.list({ q: query, match: "all" })).items).toEqual([]);
    expect((await svc.list({ q: query, match: "any" })).items.map((i) => i.title)).toEqual([
      "Perintah tes",
    ]);
  });

  test("match tidak sah ditolak", async () => {
    const svc = service();
    for (const match of ["kadang", 5, true]) {
      const error = await svc.list({ match }).catch((caught: unknown) => caught);
      expect((error as MemoryError).code).toBe("tidak-valid");
    }
  });

  test("counts global dan problems tersedia", async () => {
    const svc = service();
    await svc.create({ layer: "profile", title: "A", body: "a" });
    await svc.propose({ layer: "profile", title: "P", body: "p" });
    const result = await svc.list({ status: "active" });
    expect(result.counts).toEqual({ proposed: 1, active: 1 });
    expect(result.problems).toEqual([]);
  });

  test("limit default 100, maks 200, dan nilai tidak sah 400", async () => {
    const svc = service();
    expect((await svc.list({})).items.length).toBeLessThanOrEqual(100);
    expect((await svc.list({ limit: "5" })).items).toEqual([]);
    expect((await svc.list({ limit: 200 })).items).toEqual([]);

    for (const limit of [0, 201, -1, "abc", 1.5]) {
      const error = await svc.list({ limit }).catch((caught: unknown) => caught);
      expect((error as MemoryError).code).toBe("tidak-valid");
    }
  });

  test("enum tak dikenal dan project kosong 400", async () => {
    const svc = service();
    for (const query of [
      { status: "entah" },
      { layer: "lain" },
      { project: "  " },
      { q: 5 as unknown as string },
    ]) {
      const error = await svc.list(query).catch((caught: unknown) => caught);
      expect((error as MemoryError).code).toBe("tidak-valid");
    }
  });
});

describe("delete", () => {
  test("hapus permanen dan 404 setelahnya", async () => {
    const created = await createValid();
    await service().delete(created.id);
    expect((await service().list({})).items).toEqual([]);
    const error = await service().get(created.id).catch((caught: unknown) => caught);
    expect((error as MemoryError).code).toBe("tidak-ditemukan");
  });
});
