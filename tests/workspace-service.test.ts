import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceError,
  WorkspaceService,
} from "../src/server/workspaces/workspace-service";
import {
  initialServiceCard,
  type Workspace,
} from "../src/server/workspaces/workspace-files";

let root: string;
let dir: string;
let service: WorkspaceService;
let repoA: string;
let repoB: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-workspace-service-"));
  dir = join(root, "workspaces");
  service = new WorkspaceService({ dir });
  repoA = join(root, "api");
  repoB = join(root, "web");
  await mkdir(repoA, { recursive: true, mode: 0o700 });
  await mkdir(repoB, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectError(
  promise: Promise<unknown>,
  code: WorkspaceError["code"],
): Promise<WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    const typed = error as WorkspaceError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error("seharusnya gagal");
}

describe("create dan get", () => {
  test("membuat workspace dengan kartu awal dan path realpath", async () => {
    const item = await service.create({
      name: "  Kantor  ",
      repos: [{ name: "api", path: repoA }],
    });
    expect(item.name).toBe("Kantor");
    expect(item.repos).toHaveLength(1);
    expect(item.repos[0]!.card).toEqual(initialServiceCard());
    expect(item.repos[0]!.missing).toBe(false);

    const read = await service.get(item.id);
    expect(read?.id).toBe(item.id);
    expect(read?.createdAt).toBe(item.createdAt);
  });

  test("tanpa repos menghasilkan daftar kosong", async () => {
    const item = await service.create({ name: "Kosong" });
    expect(item.repos).toEqual([]);
  });

  test("get id tak ada mengembalikan null", async () => {
    expect(await service.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("validasi nama", () => {
  test("nama kosong, terlalu panjang, dan kontrol ditolak", async () => {
    await expectError(service.create({ name: "" }), "tidak-valid");
    await expectError(service.create({ name: "   " }), "tidak-valid");
    await expectError(service.create({ name: "x".repeat(81) }), "tidak-valid");
    await expectError(service.create({ name: "a\u0007b" }), "tidak-valid");
    await expectError(service.create({ name: 5 }), "tidak-valid");
  });

  test("rahasia pada nama ditolak tanpa mengulang teks", async () => {
    const secret = "ghp_abcdefghijklmnopqrst";
    const error = await expectError(service.create({ name: `kantor ${secret}` }), "tidak-valid");
    expect(error.message).toContain("rahasia");
    expect(error.message).not.toContain(secret);
  });
});

describe("validasi repo", () => {
  test("nama repo harus pola dan unik", async () => {
    await expectError(
      service.create({ name: "W", repos: [{ name: "Api", path: repoA }] }),
      "tidak-valid",
    );
    await expectError(
      service.create({ name: "W", repos: [{ name: "-api", path: repoA }] }),
      "tidak-valid",
    );
    await expectError(
      service.create({
        name: "W",
        repos: [
          { name: "api", path: repoA },
          { name: "api", path: repoB },
        ],
      }),
      "tidak-valid",
    );
  });

  test("path relatif, bukan direktori, dan tidak ada ditolak", async () => {
    await expectError(
      service.create({ name: "W", repos: [{ name: "api", path: "api" }] }),
      "tidak-valid",
    );
    const filePath = join(root, "berkas.txt");
    await writeFile(filePath, "x");
    await expectError(
      service.create({ name: "W", repos: [{ name: "api", path: filePath }] }),
      "tidak-valid",
    );
    await expectError(
      service.create({ name: "W", repos: [{ name: "api", path: join(root, "tidak-ada") }] }),
      "tidak-valid",
    );
  });

  test("path duplikat (termasuk lewat symlink) ditolak", async () => {
    await expectError(
      service.create({
        name: "W",
        repos: [
          { name: "api", path: repoA },
          { name: "api2", path: repoA },
        ],
      }),
      "tidak-valid",
    );
  });

  test("maks 20 repo per workspace", async () => {
    const repos = await Promise.all(
      Array.from({ length: 21 }, async (_, index) => {
        const path = join(root, `repo-${index}`);
        await mkdir(path, { recursive: true, mode: 0o700 });
        return { name: `repo-${index}`, path };
      }),
    );
    await expectError(service.create({ name: "W", repos }), "konflik");
  });

  test("maks 50 workspace", async () => {
    for (let index = 0; index < 50; index += 1) {
      await service.create({ name: `W${index}` });
    }
    await expectError(service.create({ name: "kelebihan" }), "konflik");
  });
});

describe("update", () => {
  test("repos menggantikan seluruh daftar dan kartu dipertahankan bila nama sama", async () => {
    const created = await service.create({
      name: "W",
      repos: [
        { name: "api", path: repoA },
        { name: "web", path: repoB },
      ],
    });
    const updated = await service.setCard(created.id, "api", {
      description: "Layanan API",
      kind: "backend",
    });

    const replaced = await service.update(created.id, {
      repos: [
        { name: "api", path: repoA },
        { name: "baru", path: repoB },
      ],
    });
    expect(replaced.repos.map((repo) => repo.name)).toEqual(["api", "baru"]);
    expect(replaced.repos[0]!.card.description).toBe("Layanan API");
    expect(updated.repos[0]!.card.description).toBe("Layanan API");
    expect(replaced.repos[1]!.card).toEqual(initialServiceCard());
  });

  test("validasi repos dilakukan sebelum menulis apa pun", async () => {
    const created = await service.create({ name: "W" });
    await expectError(
      service.update(created.id, {
        repos: [
          { name: "api", path: repoA },
          { name: "api", path: repoB },
        ],
      }),
      "tidak-valid",
    );
    const read = await service.get(created.id);
    expect(read?.repos).toEqual([]);
    expect(read?.updatedAt).toBe(created.updatedAt);
  });

  test("nama saja dan tanpa field", async () => {
    const created = await service.create({ name: "W" });
    const renamed = await service.update(created.id, { name: "Baru" });
    expect(renamed.name).toBe("Baru");
    await expectError(service.update(created.id, {}), "tidak-valid");
    await expectError(service.update(crypto.randomUUID(), { name: "X" }), "tidak-ditemukan");
  });
});

describe("kartu service", () => {
  let id: string;

  beforeEach(async () => {
    const created = await service.create({ name: "W", repos: [{ name: "api", path: repoA }] });
    id = created.id;
  });

  test("setCard mengisi field dan updatedAt, field lain dipertahankan", async () => {
    const first = await service.setCard(id, "api", {
      description: "Layanan utama",
      kind: "backend",
      tables: ["pesanan", "pesanan", " pengguna "],
      queues: ["antrian"],
      calls: ["web"],
    });
    const card = first.repos[0]!.card;
    expect(card.description).toBe("Layanan utama");
    expect(card.kind).toBe("backend");
    expect(card.tables).toEqual(["pesanan", "pengguna"]);
    expect(card.updatedAt).not.toBeNull();

    const second = await service.setCard(id, "api", { description: "Diubah" });
    expect(second.repos[0]!.card.kind).toBe("backend");
    expect(second.repos[0]!.card.tables).toEqual(["pesanan", "pengguna"]);
    expect(second.repos[0]!.card.description).toBe("Diubah");
  });

  test("description maks 1000 dan kind enum", async () => {
    await expectError(
      service.setCard(id, "api", { description: "x".repeat(1001) }),
      "tidak-valid",
    );
    await expectError(service.setCard(id, "api", { kind: "entah" }), "tidak-valid");
  });

  test("daftar maks 100 dan entri maks 120", async () => {
    await expectError(
      service.setCard(id, "api", { tables: Array.from({ length: 101 }, (_, i) => `t${i}`) }),
      "tidak-valid",
    );
    await expectError(service.setCard(id, "api", { queues: ["x".repeat(121)] }), "tidak-valid");
    await expectError(service.setCard(id, "api", { calls: [""] }), "tidak-valid");
  });

  test("rahasia ditolak di setCard tanpa mengulang teks", async () => {
    const secret = "sk-ant-abcdefghijklmnop";
    const error = await expectError(
      service.setCard(id, "api", { tables: [`tabel ${secret}`] }),
      "tidak-valid",
    );
    expect(error.message).toContain("rahasia");
    expect(error.message).not.toContain(secret);
  });

  test("repo dan workspace tak dikenal, serta tanpa field", async () => {
    await expectError(service.setCard(id, "lain", { kind: "backend" }), "tidak-ditemukan");
    await expectError(
      service.setCard(crypto.randomUUID(), "api", { kind: "backend" }),
      "tidak-ditemukan",
    );
    await expectError(service.setCard(id, "api", {}), "tidak-valid");
  });
});

describe("rahasia di update", () => {
  test("nama pada update ditolak bila memuat rahasia", async () => {
    const created = await service.create({ name: "W" });
    const secret = "glpat-abcdefghijklmnop";
    const error = await expectError(
      service.update(created.id, { name: `W ${secret}` }),
      "tidak-valid",
    );
    expect(error.message).not.toContain(secret);
  });
});

describe("missing dan delete", () => {
  test("missing true bila folder repo dihapus setelah disimpan", async () => {
    const created = await service.create({ name: "W", repos: [{ name: "api", path: repoA }] });
    expect(created.repos[0]!.missing).toBe(false);
    await rm(repoA, { recursive: true, force: true });
    const read = await service.get(created.id);
    expect(read?.repos[0]!.missing).toBe(true);
  });

  test("delete hanya menghapus berkas workspace, folder repo tetap ada", async () => {
    const created = await service.create({ name: "W", repos: [{ name: "api", path: repoA }] });
    await service.delete(created.id);
    expect(await service.get(created.id)).toBeNull();
    expect((await stat(repoA)).isDirectory()).toBe(true);
  });

  test("delete id tak ada 404 dan list kosong bila folder belum ada", async () => {
    await expectError(service.delete(crypto.randomUUID()), "tidak-ditemukan");
    expect(await service.list()).toEqual({ items: [], problems: [] });
  });
});

describe("problems", () => {
  test("berkas rusak masuk problems tanpa menggagalkan yang lain", async () => {
    const good = await service.create({ name: "Baik" });
    await writeFile(join(dir, `${crypto.randomUUID()}.json`), "{ rusak", { mode: 0o600 });

    const listed = await service.list();
    expect(listed.items.map((item) => item.id)).toEqual([good.id]);
    expect(listed.problems).toHaveLength(1);
    expect(listed.problems[0]?.file.endsWith(".json")).toBe(true);
    expect(listed.problems[0]?.reason).not.toContain("rusak");
  });

  test("berkas dengan id tidak cocok nama berkas masuk problems", async () => {
    const at = "2026-11-08T10:00:00.000Z";
    const wrong: Workspace = {
      id: crypto.randomUUID(),
      name: "Salah",
      createdAt: at,
      updatedAt: at,
      repos: [],
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, `${crypto.randomUUID()}.json`),
      JSON.stringify({ version: 1, ...wrong }),
      { mode: 0o600 },
    );

    const listed = await service.list();
    expect(listed.items).toEqual([]);
    expect(listed.problems).toHaveLength(1);
  });

  test("readdir folder hanya terisi berkas workspace", async () => {
    await service.create({ name: "W" });
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]!.endsWith(".json")).toBe(true);
  });
});
