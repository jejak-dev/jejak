import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { QuestionError, QuestionService, OPEN_LIMIT } from "../src/server/questions/question-service";
import { FileQuestionStore, parseQuestion } from "../src/server/questions/question-store";
import { QUESTION_ASK_BUDGET, QuestionTools } from "../src/server/questions/question-tools";

let dir: string;
let memStore: FileMemoryStore;
let memory: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-questions-"));
  memStore = new FileMemoryStore({ dir: join(dir, "memory") });
  memory = new MemoryService({ store: memStore, cwd: dir });
});

afterEach(async () => {
  memStore.close();
  await rm(dir, { recursive: true, force: true });
});

function service(now = () => new Date("2026-11-10T08:00:00Z")) {
  return new QuestionService({ store: new FileQuestionStore(":memory:"), memory, now });
}

describe("store", () => {
  test("simpan atomik 0600, muat ulang, buang entri rusak", async () => {
    const path = join(dir, "q", "questions.json");
    const store = new FileQuestionStore(path);
    const svc = new QuestionService({ store });
    svc.ask({ question: "Tabel orders ditulis service mana?", layer: "project", projectKey: "/p" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = new FileQuestionStore(path);
    expect(again.all()).toHaveLength(1);
    expect(parseQuestion({ id: "x" })).toBeNull();
    expect(parseQuestion({ id: "a", question: "q", layer: "project", projectKey: null, status: "open", createdAt: "t" })).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });
});

describe("layanan", () => {
  test("ask: validasi, duplikat dikembalikan, penugasan", () => {
    const svc = service();
    const a = svc.ask({ question: " Siapa konsumen queue X? ", layer: "project", projectKey: "/p", assignee: "Budi" });
    expect(a.question).toBe("Siapa konsumen queue X?");
    expect(a.assignee).toBe("Budi");
    expect(svc.ask({ question: "siapa konsumen queue x?", layer: "project", projectKey: "/p" }).id).toBe(a.id);
    expect(svc.list()).toHaveLength(1);
    expect(svc.list({ assignee: "Budi" })).toHaveLength(1);
    expect(svc.list({ assignee: "Sari" })).toHaveLength(0);
    expect(() => svc.ask({ question: "" , projectKey: "/p" })).toThrow(QuestionError);
    expect(() => svc.ask({ question: "x".repeat(301), projectKey: "/p" })).toThrow(QuestionError);
    expect(() => svc.ask({ question: "ok", layer: "project" })).toThrow(QuestionError);
    expect(() => svc.ask({ question: "token=abcdefghijk1234", projectKey: "/p" })).toThrow(QuestionError);
    expect(svc.assign(a.id, "Sari").assignee).toBe("Sari");
    expect(svc.assign(a.id, "").assignee).toBeUndefined();
  });

  test("batas pertanyaan terbuka", () => {
    const svc = service();
    for (let i = 0; i < OPEN_LIMIT; i++) svc.ask({ question: `Pertanyaan ${i}`, projectKey: "/p" });
    expect(() => svc.ask({ question: "satu lagi", projectKey: "/p" })).toThrow(/Batas/);
  });

  test("answer: membuat memory active/confirmed berasal interview dan menutup pertanyaan", async () => {
    const svc = service();
    const q = svc.ask({ question: "Tabel orders ditulis service mana?", layer: "project", projectKey: dir });
    const answered = await svc.answer(q.id, "Hanya order-service dan billing-service.", "Budi");
    expect(answered.status).toBe("answered");
    expect(answered.answeredBy).toBe("Budi");
    expect(answered.memoryId).toBeDefined();
    const list = await memory.list({ status: "active", project: dir });
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item.confidence).toBe("confirmed");
    expect(item.origin).toMatchObject({ kind: "interview", by: "Budi" });
    expect(item.body).toContain("Dikonfirmasi oleh Budi, 2026-11-10.");
    expect(item.body).toContain("order-service");
    // Muat ulang dari berkas: origin interview harus lolos parser.
    const reread = await memory.list({ status: "active", project: dir });
    expect(reread.problems).toEqual([]);
    await expect(svc.answer(q.id, "lagi", "Budi")).rejects.toThrow(/sudah dijawab/);
    await expect(svc.answer("nihil", "a", "b")).rejects.toThrow(/tidak ditemukan/);
  });

  test("answer menolak rahasia dan dismiss menutup", async () => {
    const svc = service();
    const q = svc.ask({ question: "Apa kunci?", projectKey: dir });
    await expect(svc.answer(q.id, "sk-abcdefghijklmnop", "Budi")).rejects.toThrow(/rahasia/);
    expect(svc.dismiss(q.id).status).toBe("dismissed");
    expect(() => svc.dismiss(q.id)).toThrow(QuestionError);
    expect(svc.list({ status: "all" })).toHaveLength(1);
  });
});

describe("tool question_ask", () => {
  const ctx = { sessionId: "s1", projectKey: "/proyek", cwd: "/proyek" };

  test("mencatat pertanyaan proyek sesi, memvalidasi, dan memakai anggaran", async () => {
    const svc = service();
    const tools = new QuestionTools(svc);
    const ok = await tools.call(ctx, "question_ask", { question: "Siapa pemilik tabel users?" });
    expect(ok.isError).toBe(false);
    expect(svc.list()[0]).toMatchObject({ projectKey: "/proyek", sessionId: "s1" });
    expect((await tools.call(ctx, "question_ask", { question: "" })).isError).toBe(true);
    expect((await tools.call(ctx, "question_ask", { question: "a", x: 1 })).isError).toBe(true);
    expect((await tools.call(ctx, "lain", {})).isError).toBe(true);
    for (let i = 0; i < QUESTION_ASK_BUDGET; i++) {
      await tools.call(ctx, "question_ask", { question: `Tanya ${i}` });
    }
    const over = await tools.call(ctx, "question_ask", { question: "melebihi" });
    expect(over).toMatchObject({ isError: true, text: "Batas pertanyaan per sesi tercapai." });
  });
});

describe("rute", () => {
  function app(withQuestions = true) {
    const audit = new SqliteAuditStore(":memory:");
    const instance = createApp({
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      memory,
      audit,
      ...(withQuestions ? { questions: new FileQuestionStore(":memory:") } : {}),
    });
    return { instance, audit };
  }
  function req(a: ReturnType<typeof app>, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return a.instance.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  }

  test("alur buat, tugaskan, jawab, tutup dengan audit", async () => {
    const a = app();
    const created = await req(a, "POST", "/api/questions", {
      question: "Queue billing dikonsumsi siapa?",
      layer: "project",
      projectKey: dir,
    });
    expect(created.status).toBe(201);
    const q = (await created.json()) as { id: string };
    expect((await req(a, "PATCH", `/api/questions/${q.id}`, { assignee: "Sari" })).status).toBe(200);
    const list = (await (await req(a, "GET", "/api/questions")).json()) as { items: unknown[]; open: number };
    expect(list.items).toHaveLength(1);
    expect(list.open).toBe(1);
    const ans = await req(a, "POST", `/api/questions/${q.id}/answer`, { answer: "invoice-service", by: "Sari" });
    expect(ans.status).toBe(200);
    expect(((await (await req(a, "GET", "/api/questions")).json()) as { open: number }).open).toBe(0);
    expect((await req(a, "POST", `/api/questions/${q.id}/answer`, { answer: "lagi" })).status).toBe(409);
    expect((await req(a, "POST", `/api/questions/nihil/dismiss`, {})).status).toBe(404);
    const summaries = a.audit.list({ kind: "pengaturan", limit: 20 }).map((e) => e.summary);
    expect(summaries).toContain("Pertanyaan dibuat");
    expect(summaries).toContain("Pertanyaan dijawab");
    a.audit.close();
  });

  test("galat: field tak dikenal 400, status tak valid 400, mati 503", async () => {
    const a = app();
    expect((await req(a, "POST", "/api/questions", { question: "a", projectKey: "/p", x: 1 })).status).toBe(400);
    expect((await req(a, "GET", "/api/questions?status=aneh")).status).toBe(400);
    expect((await req(a, "GET", "/api/questions?foo=1")).status).toBe(400);
    a.audit.close();
    const off = app(false);
    expect((await req(off, "GET", "/api/questions")).status).toBe(503);
    off.audit.close();
  });
});
