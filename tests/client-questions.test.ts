import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, type QuestionItem } from "../src/client/lib/api";
import {
  ANSWER_MAX,
  answerHint,
  answeredLine,
  canSubmitAnswer,
  loadName,
  questionMeta,
  saveName,
} from "../src/client/lib/questions";
import { originLabel } from "../src/client/lib/memory";

const Q: QuestionItem = {
  id: "q1",
  question: "Tabel orders ditulis service mana?",
  layer: "project",
  projectKey: "/kerja/api-orders",
  assignee: "Budi",
  status: "open",
  createdAt: "2026-11-10T08:00:00.000Z",
};

describe("fungsi murni", () => {
  test("questionMeta: proyek, penugasan, tanggal", () => {
    const meta = questionMeta(Q);
    expect(meta).toContain("api-orders");
    expect(meta).toContain("untuk Budi");
    expect(questionMeta({ ...Q, layer: "profile", projectKey: null, assignee: undefined })).toContain("Semua proyek");
  });

  test("canSubmitAnswer dan answerHint", () => {
    expect(canSubmitAnswer("  ")).toBe(false);
    expect(canSubmitAnswer("ya")).toBe(true);
    expect(canSubmitAnswer("x".repeat(ANSWER_MAX + 1))).toBe(false);
    expect(answerHint(" abc ")).toBe(`3 / ${ANSWER_MAX}`);
  });

  test("answeredLine dengan dan tanpa tanggal", () => {
    expect(answeredLine({ ...Q, status: "answered", answeredBy: "Sari" })).toBe("Dijawab oleh Sari");
    expect(answeredLine({ ...Q, status: "answered", answeredBy: "Sari", answeredAt: "2026-11-10T09:00:00Z" })).toContain("Sari · ");
  });

  test("nama: simpan dan muat; penyimpanan rusak tidak melempar", () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    saveName("  Budi  ", storage);
    expect(loadName(storage)).toBe("Budi");
    const broken = {
      getItem: () => {
        throw new Error("blokir");
      },
      setItem: () => {
        throw new Error("blokir");
      },
    };
    expect(loadName(broken)).toBe("");
    expect(() => saveName("x", broken)).not.toThrow();
  });

  test("originLabel interview menyebut pengonfirmasi", () => {
    expect(
      originLabel({ kind: "interview", by: "Budi", at: "2026-11-10T08:00:00Z" }),
    ).toContain("Dikonfirmasi oleh Budi");
  });
});

describe("ApiClient pertanyaan", () => {
  function fakeFetch(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return response();
    };
    return { fetch: impl as typeof fetch, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("listQuestions mengirim status dan membuka bungkus", async () => {
    const { fetch, calls } = fakeFetch(() => json({ items: [Q], open: 1 }));
    const result = await createApiClient({ fetch }).listQuestions("answered");
    expect(result).toEqual({ items: [Q], open: 1 });
    expect(calls[0]?.url).toBe("/api/questions?status=answered");
  });

  test("answer, assign, dismiss memakai metode dan jalur yang benar", async () => {
    const { fetch, calls } = fakeFetch(() => json(Q));
    const api = createApiClient({ fetch });
    await api.answerQuestion("q 1", "ya", "Budi");
    await api.assignQuestion("q1", "Sari");
    await api.dismissQuestion("q1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/questions/q%201/answer",
      "PATCH /api/questions/q1",
      "POST /api/questions/q1/dismiss",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ answer: "ya", by: "Budi" });
  });

  test("bentuk salah atau 503 menjadi ApiError", async () => {
    const bad = fakeFetch(() => json({ x: 1 }));
    await expect(createApiClient({ fetch: bad.fetch }).listQuestions()).rejects.toBeInstanceOf(ApiError);
    const off = fakeFetch(() => json({ error: "Pertanyaan dimatikan." }, 503));
    await expect(createApiClient({ fetch: off.fetch }).listQuestions()).rejects.toBeInstanceOf(ApiError);
  });
});
