import { findSecret } from "../memory/secret-guard";
import type { MemoryService } from "../memory/memory-service";
import type { Question, QuestionLayer, QuestionStatus, QuestionStore } from "./question-store";

export const QUESTION_MAX = 300;
export const ANSWER_MAX = 1500;
export const NAME_MAX = 60;
export const OPEN_LIMIT = 200;
const TOTAL_LIMIT = 1000;

export type QuestionErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik";

export class QuestionError extends Error {
  constructor(
    message: string,
    public readonly code: QuestionErrorCode,
  ) {
    super(message);
    this.name = "QuestionError";
  }
}

function invalid(message: string): QuestionError {
  return new QuestionError(message, "tidak-valid");
}

export interface AskInput {
  question: unknown;
  layer?: unknown;
  projectKey?: unknown;
  assignee?: unknown;
  sessionId?: string;
}

export interface QuestionQuery {
  status?: unknown;
  project?: unknown;
  assignee?: unknown;
}

export interface QuestionServiceOptions {
  store: QuestionStore;
  memory?: MemoryService;
  now?: () => Date;
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`Field ${field} wajib diisi.`);
    return undefined;
  }
  if (typeof value !== "string") throw invalid(`Field ${field} harus berupa teks.`);
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw invalid(`Field ${field} wajib diisi.`);
    return undefined;
  }
  if (trimmed.length > max) throw invalid(`Field ${field} maksimal ${max} karakter.`);
  const secret = findSecret(trimmed);
  if (secret !== null) throw invalid(`Field ${field} tampak memuat rahasia (${secret}); ditolak.`);
  return trimmed;
}

export class QuestionService {
  private readonly store: QuestionStore;
  private readonly memory: MemoryService | undefined;
  private readonly now: () => Date;

  constructor(options: QuestionServiceOptions) {
    this.store = options.store;
    this.memory = options.memory;
    this.now = options.now ?? (() => new Date());
  }

  list(query: QuestionQuery = {}): Question[] {
    const status = query.status;
    if (
      status !== undefined &&
      status !== "all" &&
      status !== "open" &&
      status !== "answered" &&
      status !== "dismissed"
    ) {
      throw invalid("Parameter status tidak valid.");
    }
    const wanted: QuestionStatus | "all" = (status as QuestionStatus | "all" | undefined) ?? "open";
    return this.store
      .all()
      .filter((item) => wanted === "all" || item.status === wanted)
      .filter((item) => typeof query.project !== "string" || item.projectKey === query.project)
      .filter((item) => typeof query.assignee !== "string" || item.assignee === query.assignee)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  openCount(): number {
    return this.store.all().filter((item) => item.status === "open").length;
  }

  ask(input: AskInput): Question {
    const question = text(input.question, "question", QUESTION_MAX, true)!;
    const assignee = text(input.assignee, "assignee", NAME_MAX, false);
    const layer: QuestionLayer = input.layer === "profile" ? "profile" : "project";
    let projectKey: string | null = null;
    if (layer === "project") {
      if (typeof input.projectKey !== "string" || input.projectKey === "") {
        throw invalid("Field projectKey wajib untuk pertanyaan proyek.");
      }
      projectKey = input.projectKey;
    }
    const items = this.store.all();
    if (items.filter((item) => item.status === "open").length >= OPEN_LIMIT) {
      throw new QuestionError(`Batas ${OPEN_LIMIT} pertanyaan terbuka sudah tercapai.`, "konflik");
    }
    const duplicate = items.find(
      (item) =>
        item.status === "open" &&
        item.projectKey === projectKey &&
        item.question.toLowerCase() === question.toLowerCase(),
    );
    if (duplicate !== undefined) return duplicate;
    const created: Question = {
      id: crypto.randomUUID(),
      question,
      layer,
      projectKey,
      status: "open",
      createdAt: this.now().toISOString(),
    };
    if (assignee !== undefined) created.assignee = assignee;
    if (input.sessionId !== undefined) created.sessionId = input.sessionId;
    // Entri lama paling bawah dibuang bila melebihi batas total.
    const next = [created, ...items].slice(0, TOTAL_LIMIT);
    this.store.save(next);
    return created;
  }

  private mutate(id: string, apply: (item: Question) => void): Question {
    const items = this.store.all();
    const item = items.find((candidate) => candidate.id === id);
    if (item === undefined) {
      throw new QuestionError(`Pertanyaan "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    apply(item);
    this.store.save(items);
    return item;
  }

  assign(id: string, assignee: unknown): Question {
    const name = text(assignee, "assignee", NAME_MAX, false);
    return this.mutate(id, (item) => {
      if (item.status !== "open") {
        throw new QuestionError("Hanya pertanyaan terbuka yang bisa ditugaskan.", "konflik");
      }
      if (name === undefined) delete item.assignee;
      else item.assignee = name;
    });
  }

  dismiss(id: string): Question {
    return this.mutate(id, (item) => {
      if (item.status !== "open") {
        throw new QuestionError("Pertanyaan sudah dijawab atau ditutup.", "konflik");
      }
      item.status = "dismissed";
    });
  }

  /** Menjawab: jawaban manusia menjadi memory `active` + `confirmed` berasal `interview`. */
  async answer(id: string, answerInput: unknown, byInput: unknown): Promise<Question> {
    const answer = text(answerInput, "answer", ANSWER_MAX, true)!;
    const by = text(byInput, "by", NAME_MAX, false) ?? "pengguna";
    const existing = this.store.all().find((item) => item.id === id);
    if (existing === undefined) {
      throw new QuestionError(`Pertanyaan "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    if (existing.status !== "open") {
      throw new QuestionError("Pertanyaan sudah dijawab atau ditutup.", "konflik");
    }
    const at = this.now().toISOString();
    let memoryId: string | undefined;
    if (this.memory !== undefined) {
      const date = at.slice(0, 10);
      const memory = await this.memory.createInterview({
        layer: existing.layer,
        projectKey: existing.projectKey,
        title: `Dikonfirmasi: ${existing.question}`.slice(0, 120),
        body: `T: ${existing.question}\nJ: ${answer}\n\nDikonfirmasi oleh ${by}, ${date}.`,
        by,
      });
      memoryId = memory.id;
    }
    return this.mutate(id, (item) => {
      item.status = "answered";
      item.answer = answer;
      item.answeredBy = by;
      item.answeredAt = at;
      if (memoryId !== undefined) item.memoryId = memoryId;
    });
  }
}
