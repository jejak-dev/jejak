import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileMemoryStore,
  defaultMemoryStore,
  memoryDir,
  memoryIndexPath,
} from "../src/server/memory/memory-store";
import type { Memory } from "../src/server/memory/memory-files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-store-"));
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
    title: "Judul",
    body: "Isi memory.",
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

describe("FileMemoryStore", () => {
  test("create menulis berkas lalu indeks dapat dibaca", async () => {
    const store = new FileMemoryStore({ dir });
    const item = memory({ title: "Tersimpan" });
    await store.create(item);

    const listed = await store.list({});
    expect(listed.map((entry) => entry.id)).toEqual([item.id]);
    expect(listed[0]?.title).toBe("Tersimpan");

    const text = await readFile(join(dir, "profile", `${item.id}.md`), "utf8");
    expect(text).toContain("Tersimpan");
    store.close();
  });

  test("indeks dapat dibangun ulang dari berkas setelah store ditutup", async () => {
    const first = new FileMemoryStore({ dir });
    const item = memory({ title: "Tahan banting" });
    await first.create(item);
    first.close();

    const second = new FileMemoryStore({ dir });
    const listed = await second.list({});
    expect(listed.map((entry) => entry.title)).toEqual(["Tahan banting"]);
    second.close();
  });

  test("update mengganti berkas dan menandai perubahan", async () => {
    const store = new FileMemoryStore({ dir });
    const item = memory({ title: "Lama" });
    await store.create(item);
    await store.update({ ...item, title: "Baru" });

    const listed = await store.list({});
    expect(listed[0]?.title).toBe("Baru");
    store.close();
  });

  test("setStatus mengubah status dan decidedAt", async () => {
    const store = new FileMemoryStore({ dir, now: () => new Date("2026-12-01T00:00:00.000Z") });
    const item = memory({ status: "proposed", confidence: "inferred" });
    await store.create(item);

    const updated = await store.setStatus(item.id, "active", "confirmed", "2026-12-01T00:00:00.000Z");
    expect(updated?.status).toBe("active");
    expect(updated?.confidence).toBe("confirmed");
    expect(updated?.decidedAt).toBe("2026-12-01T00:00:00.000Z");
    expect(updated?.updatedAt).toBe("2026-12-01T00:00:00.000Z");

    expect(await store.setStatus("tidak-ada", "active", "confirmed", null)).toBeNull();
    store.close();
  });

  test("delete menghapus berkas dan baris indeks", async () => {
    const store = new FileMemoryStore({ dir });
    const item = memory();
    await store.create(item);
    expect(await store.delete(item.id)).toBe(true);
    expect(await store.list({})).toEqual([]);
    expect(await store.delete(item.id)).toBe(false);
    store.close();
  });

  test("counts, countActive, countProposed", async () => {
    const store = new FileMemoryStore({ dir });
    await store.create(memory({ status: "active" }));
    await store.create(memory({ status: "active" }));
    await store.create(memory({ status: "proposed" }));

    expect(await store.counts()).toEqual({ proposed: 1, active: 2 });
    expect(await store.countActive("profile", null)).toBe(2);
    expect(await store.countProposed()).toBe(1);
    store.close();
  });

  test("problems dilaporkan dari sync", async () => {
    const store = new FileMemoryStore({ dir });
    await store.create(memory());
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "profile"), { recursive: true });
    await writeFile(join(dir, "profile", `${crypto.randomUUID()}.md`), "rusak", { mode: 0o600 });

    const problems = await store.sync();
    expect(problems).toHaveLength(1);
    expect(store.problems()).toEqual(problems);
    store.close();
  });

  test("get mengembalikan null untuk id tidak dikenal", async () => {
    const store = new FileMemoryStore({ dir });
    expect(await store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    store.close();
  });
});

describe("defaultMemoryStore", () => {
  test("JEJAK_MEMORY=0 menghasilkan undefined", () => {
    expect(defaultMemoryStore({ JEJAK_MEMORY: "0" })).toBeUndefined();
  });

  test("direktori mengikuti JEJAK_HOME dan berkas berizin 0600", async () => {
    const home = join(dir, "home");
    const store = defaultMemoryStore({ JEJAK_HOME: home });
    expect(store).toBeDefined();
    expect(store?.dir).toBe(join(home, "memory"));
    expect(memoryDir({ JEJAK_HOME: home })).toBe(join(home, "memory"));
    expect(memoryIndexPath({ JEJAK_HOME: home })).toBe(join(home, "memory", "index.db"));

    await store?.create(memory());
    const info = await stat(join(home, "memory", "index.db"));
    expect(info.mode & 0o777).toBe(0o600);
    store?.close();
  });

  test("JEJAK_MEMORY=0 tidak membuat berkas", async () => {
    const home = join(dir, "kosong");
    expect(defaultMemoryStore({ JEJAK_HOME: home, JEJAK_MEMORY: "0" })).toBeUndefined();
    await expect(stat(join(home, "memory"))).rejects.toThrow();
  });
});

describe("createApp tanpa memory", () => {
  test("createApp() tanpa opsi tidak membuat folder memory dan rute menjawab 503", async () => {
    const { createApp } = await import("../src/server/index");
    const home = join(dir, "tanpa-memory");
    const app = createApp({ env: { JEJAK_HOME: home } });

    const res = await app.handle(
      new Request("http://127.0.0.1:3000/api/memory", { headers: { host: "127.0.0.1:3000" } }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Memory dimatikan." });

    await expect(stat(join(home, "memory"))).rejects.toThrow();
  });
});
