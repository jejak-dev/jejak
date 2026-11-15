import { describe, expect, test } from "bun:test";
import { MemoryService } from "../src/server/memory/memory-service";
import type { MemoryStore } from "../src/server/memory/memory-store";
import type { Memory } from "../src/server/memory/memory-files";
import type { MemoryCounts, MemoryListQuery, MemoryProblem } from "../src/server/memory/memory-index";
import { SESSION_SUMMARY_PREFIX } from "../src/server/memory/session-summary";
import { PROJECT_SUMMARY_PREFIX } from "../src/server/memory/session-consolidation";

/** Store tiruan: memory disimpan di memori supaya cap waktu bisa dikendalikan. */
class StubStore implements MemoryStore {
  readonly dir = ":stub:";
  readonly items = new Map<string, Memory>();

  async sync(): Promise<MemoryProblem[]> {
    return [];
  }
  problems(): MemoryProblem[] {
    return [];
  }
  async list(query: MemoryListQuery = {}): Promise<Memory[]> {
    let items = [...this.items.values()];
    if (query.status !== undefined) items = items.filter((m) => m.status === query.status);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      items = items.filter((m) => query.statuses!.includes(m.status));
    }
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
    return { proposed: 0, active: 0 };
  }
  async countActive(): Promise<number> {
    return 0;
  }
  async countProposed(): Promise<number> {
    return 0;
  }
  close(): void {}
}

function bodyFor(berkas: string[], jawaban: string): string {
  return [
    "Permintaan: kerjakan hal",
    `Berkas diubah: ${berkas.join(", ")}`,
    `Jawaban akhir: ${jawaban}`,
  ].join("\n");
}

function ringkasan(
  store: StubStore,
  opsi: {
    sessionId: string;
    projectKey?: string;
    body?: string;
    title?: string;
    updatedAt?: string;
  },
): Memory {
  const memory: Memory = {
    id: crypto.randomUUID(),
    layer: "project",
    projectKey: opsi.projectKey ?? "/proj",
    title: opsi.title ?? `${SESSION_SUMMARY_PREFIX}Sesi ${opsi.sessionId}`,
    body: opsi.body ?? bodyFor(["a.ts"], "Selesai."),
    status: "proposed",
    confidence: "inferred",
    origin: { kind: "session", sessionId: opsi.sessionId, at: "2026-11-01T00:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: opsi.updatedAt ?? "2026-11-01T00:00:00.000Z",
    decidedAt: null,
    replaces: null,
  };
  store.items.set(memory.id, memory);
  return memory;
}

describe("pruneStaleSessionSummaries", () => {
  test("menolak hanya usulan ringkasan sesi yang lebih tua dari ambang", async () => {
    const store = new StubStore();
    let now = new Date("2026-11-01T00:00:00.000Z");
    const svc = new MemoryService({ store, now: () => now });

    const lama = ringkasan(store, { sessionId: "s_lama" });
    const lamaJuga = ringkasan(store, { sessionId: "s_lama_juga" });
    const aktif = ringkasan(store, { sessionId: "s_aktif" });
    store.items.set(aktif.id, { ...aktif, status: "active" });
    const bukanRingkasan = ringkasan(store, {
      sessionId: "s_biasa",
      title: "Catatan biasa",
    });

    now = new Date("2026-11-16T00:00:00.000Z");
    const segar = ringkasan(store, {
      sessionId: "s_segar",
      body: bodyFor(["b.ts"], "Baru."),
    });
    store.items.set(segar.id, { ...segar, updatedAt: now.toISOString() });

    const pruned = await svc.pruneStaleSessionSummaries();
    expect(pruned).toBe(2);
    expect((await store.get(lama.id))?.status).toBe("rejected");
    expect((await store.get(lamaJuga.id))?.status).toBe("rejected");
    expect((await store.get(aktif.id))?.status).toBe("active");
    expect((await store.get(bukanRingkasan.id))?.status).toBe("proposed");
    expect((await store.get(segar.id))?.status).toBe("proposed");
  });

  test("ambang khusus dipakai dan tak ada berkas yang dihapus", async () => {
    const store = new StubStore();
    let now = new Date("2026-11-01T00:00:00.000Z");
    const svc = new MemoryService({ store, now: () => now });
    ringkasan(store, { sessionId: "s_1" });
    now = new Date("2026-11-10T00:00:00.000Z");

    expect(await svc.pruneStaleSessionSummaries({ olderThanDays: 30 })).toBe(0);
    expect(await svc.pruneStaleSessionSummaries({ olderThanDays: 5 })).toBe(1);
    expect(store.items.size).toBe(1);
  });
});

describe("consolidateSessionSummaries", () => {
  test("menggabungkan dua ringkasan menjadi satu usulan proyek", async () => {
    const store = new StubStore();
    const svc = new MemoryService({ store });
    const satu = ringkasan(store, {
      sessionId: "s_1",
      body: bodyFor(["src/a.ts", "src/b.ts"], "Selesai bagian pertama."),
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const dua = ringkasan(store, {
      sessionId: "s_2",
      body: bodyFor(["src/b.ts", "src/c.ts"], "Selesai bagian kedua."),
      updatedAt: "2026-11-02T00:00:00.000Z",
    });

    const result = await svc.consolidateSessionSummaries("/proj");
    expect(result.sources).toBe(2);
    expect(result.merged.status).toBe("proposed");
    expect(result.merged.confidence).toBe("inferred");
    expect(result.merged.layer).toBe("project");
    expect(result.merged.projectKey).toBe("/proj");
    expect(result.merged.title.startsWith(PROJECT_SUMMARY_PREFIX)).toBe(true);
    expect(result.merged.title).toContain("2026-11-01");
    expect(result.merged.origin.sessionIds).toEqual(["s_1", "s_2"]);
    expect(result.merged.origin.at).toBeTruthy();
    expect(result.merged.body).toContain("Sesi s_1");
    expect(result.merged.body).toContain("Sesi s_2");
    // Berkas yang sama tak diulang lintas sesi.
    expect(result.merged.body.match(/src\/b\.ts/g)).toHaveLength(1);

    // Sumber yang masih usulan ditolak; tak ada yang dihapus.
    expect((await store.get(satu.id))?.status).toBe("rejected");
    expect((await store.get(dua.id))?.status).toBe("rejected");
    expect(store.items.size).toBe(3);
  });

  test("sumber yang sudah diarsipkan diarsipkan, bukan ditolak", async () => {
    const store = new StubStore();
    const svc = new MemoryService({ store });
    const aktif = ringkasan(store, { sessionId: "s_aktif" });
    store.items.set(aktif.id, { ...aktif, status: "active" });
    const usulan = ringkasan(store, { sessionId: "s_usulan" });

    await svc.consolidateSessionSummaries("/proj");
    expect((await store.get(aktif.id))?.status).toBe("archived");
    expect((await store.get(usulan.id))?.status).toBe("rejected");
  });

  test("kurang dari dua ringkasan ditolak", async () => {
    const store = new StubStore();
    const svc = new MemoryService({ store });
    ringkasan(store, { sessionId: "s_1" });

    await expect(svc.consolidateSessionSummaries("/proj")).rejects.toThrow();
    expect(store.items.size).toBe(1);

    // Memory non-ringkasan tak dihitung sebagai sumber.
    ringkasan(store, { sessionId: "s_2", title: "Catatan biasa" });
    await expect(svc.consolidateSessionSummaries("/proj")).rejects.toThrow();
  });

  test("isi dipangkas dan jumlah sesi lama yang hilang disebut", async () => {
    const store = new StubStore();
    const svc = new MemoryService({ store });
    const panjang = "kata ".repeat(120).trim();
    for (let index = 0; index < 12; index += 1) {
      const memory = ringkasan(store, {
        sessionId: `s_${index}`,
        body: bodyFor([`src/f${index}.ts`], panjang),
      });
      store.items.set(memory.id, {
        ...memory,
        updatedAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const result = await svc.consolidateSessionSummaries("/proj");
    expect(result.merged.body.length).toBeLessThanOrEqual(2000);
    expect(result.merged.body).toContain("sesi lebih lama dihilangkan");
    expect(result.merged.origin.sessionIds).toHaveLength(12);
  });

  test("rahasia di sumber tak bocor ke memory gabungan", async () => {
    const store = new StubStore();
    const svc = new MemoryService({ store });
    const rahasia = "ghp_abcdefghijklmnopqrst";
    ringkasan(store, {
      sessionId: "s_1",
      body: bodyFor(["a.ts"], "Selesai."),
    });
    ringkasan(store, {
      sessionId: "s_rahasia",
      body: bodyFor(["b.ts"], `Token ${rahasia}`),
    });

    await expect(svc.consolidateSessionSummaries("/proj")).rejects.toThrow();
    const gabungan = [...store.items.values()].find((item) =>
      item.title.startsWith(PROJECT_SUMMARY_PREFIX),
    );
    expect(gabungan).toBeUndefined();
  });
});
