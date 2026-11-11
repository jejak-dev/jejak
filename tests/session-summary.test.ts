import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/server/agent/events";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { SESSION_SUMMARY_PREFIX, buildSessionSummary } from "../src/server/memory/session-summary";

const call = (name: string, input: unknown, id = name): AgentEvent => ({ type: "tool_call", id, name, input });
const result: AgentEvent = { type: "result", ok: true, summary: "Selesai memperbaiki login." };

describe("buildSessionSummary", () => {
  test("memuat permintaan, berkas diubah, jumlah perintah, dan jawaban akhir", () => {
    const summary = buildSessionSummary("Perbaiki login", [
      { type: "user_message", text: "Perbaiki login\n\nLampiran:\n- /tmp/x.png" },
      call("Bash", { command: "bun test" }),
      call("Edit", { file_path: "/p/a.ts" }, "e1"),
      call("Edit", { file_path: "/p/a.ts" }, "e2"),
      call("Write", { file_path: "/p/b.ts" }),
      result,
    ]);
    expect(summary?.title).toBe(`${SESSION_SUMMARY_PREFIX}Perbaiki login`);
    expect(summary?.body).toContain("Permintaan: Perbaiki login");
    expect(summary?.body).not.toContain("Lampiran");
    expect(summary?.body).toContain("Berkas diubah: /p/a.ts, /p/b.ts");
    expect(summary?.body).toContain("Perintah dijalankan: 1");
    expect(summary?.body).toContain("Jawaban akhir: Selesai memperbaiki login.");
  });

  test("sesi tanpa tool dan satu pesan tidak diringkas; subagent tidak dihitung", () => {
    expect(buildSessionSummary("Halo", [{ type: "user_message", text: "halo" }, result])).toBeUndefined();
    const sub: AgentEvent = { type: "tool_call", id: "s", name: "Bash", input: {}, parentToolUseId: "p" };
    expect(buildSessionSummary("Halo", [{ type: "user_message", text: "halo" }, sub, result])).toBeUndefined();
  });

  test("batas panjang judul dan isi", () => {
    const long = "x".repeat(5000);
    const summary = buildSessionSummary(long, [call("Bash", {}), { type: "result", ok: true, summary: long }]);
    expect(summary!.title.length).toBeLessThanOrEqual(120);
    expect(summary!.body.length).toBeLessThanOrEqual(2000);
  });
});

describe("upsertSessionSummary", () => {
  let dir: string;
  let store: FileMemoryStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jejak-sum-"));
    store = new FileMemoryStore({ dir });
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const input = (body: string) => ({
    sessionId: "s_1",
    projectKey: "/proj",
    title: `${SESSION_SUMMARY_PREFIX}Uji`,
    body,
  });

  test("membuat usulan lalu memperbarui yang sama selama masih proposed", async () => {
    const svc = new MemoryService({ store });
    const first = await svc.upsertSessionSummary(input("satu"));
    expect(first?.status).toBe("proposed");
    expect(first?.origin.sessionId).toBe("s_1");
    await svc.upsertSessionSummary(input("dua"));
    const all = await store.list({ layer: "project", project: "/proj" });
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe("dua");
  });

  test("yang sudah diterima tidak ditimpa", async () => {
    const svc = new MemoryService({ store });
    const made = await svc.upsertSessionSummary(input("satu"));
    await svc.accept(made!.id);
    expect(await svc.upsertSessionSummary(input("dua"))).toBeUndefined();
    expect((await store.get(made!.id))?.body).toBe("satu");
  });

  test("rahasia ditolak penjaga", async () => {
    const svc = new MemoryService({ store });
    await expect(svc.upsertSessionSummary(input("password=hunter2hunter2"))).rejects.toThrow();
  });
});
