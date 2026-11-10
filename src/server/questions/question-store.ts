import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { jejakHome } from "../provider-store";

export type QuestionStatus = "open" | "answered" | "dismissed";
export type QuestionLayer = "profile" | "project";

export interface Question {
  id: string;
  question: string;
  layer: QuestionLayer;
  /** Kunci proyek untuk lapis `project`; `null` untuk `profile`. */
  projectKey: string | null;
  assignee?: string;
  status: QuestionStatus;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
  /** Memory yang dibuat dari jawaban. */
  memoryId?: string;
  sessionId?: string;
  createdAt: string;
}

export interface QuestionStore {
  /** Salinan seluruh pertanyaan, terbaru dulu. */
  all(): Question[];
  /** Menyimpan seluruh daftar secara atomik. */
  save(items: Question[]): void;
}

const VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Mengurai satu entri; entri rusak dibuang (null). */
export function parseQuestion(raw: unknown): Question | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const question = str(raw.question);
  const createdAt = str(raw.createdAt);
  if (id === undefined || question === undefined || createdAt === undefined) return null;
  const layer = raw.layer;
  if (layer !== "profile" && layer !== "project") return null;
  const status = raw.status;
  if (status !== "open" && status !== "answered" && status !== "dismissed") return null;
  const projectKey = raw.projectKey === null ? null : str(raw.projectKey);
  if (projectKey === undefined) return null;
  if (layer === "project" && projectKey === null) return null;
  const item: Question = { id, question, layer, projectKey, status, createdAt };
  for (const key of ["assignee", "answer", "answeredBy", "answeredAt", "memoryId", "sessionId"] as const) {
    const value = str(raw[key]);
    if (value !== undefined) item[key] = value;
  }
  return item;
}

export function questionsPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "questions.json");
}

export function defaultQuestionStore(
  env: Record<string, string | undefined> = process.env,
): QuestionStore | undefined {
  if (env.JEJAK_QUESTIONS?.trim() === "0") return undefined;
  if (env.JEJAK_PERSIST?.trim() === "0") return new FileQuestionStore(":memory:");
  return new FileQuestionStore(questionsPath(env));
}

/** Berkas JSON atomik (0600); `:memory:` untuk tes. */
export class FileQuestionStore implements QuestionStore {
  private items: Question[] | undefined;
  private readonly inMemory: boolean;

  constructor(private readonly path: string) {
    this.inMemory = path === ":memory:" || path === "";
  }

  private load(): Question[] {
    if (this.items !== undefined) return this.items;
    this.items = [];
    if (this.inMemory) return this.items;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (isRecord(parsed) && parsed.version === VERSION && Array.isArray(parsed.items)) {
        this.items = parsed.items
          .map(parseQuestion)
          .filter((item): item is Question => item !== null);
      }
    } catch {
      // Berkas tak ada atau rusak: mulai kosong; tidak ditimpa sampai ada save.
    }
    return this.items;
  }

  all(): Question[] {
    return this.load().map((item) => ({ ...item }));
  }

  save(items: Question[]): void {
    this.items = items.map((item) => ({ ...item }));
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: VERSION, items: this.items }, null, 2)}\n`;
    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, body, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Berkas sementara mungkin sudah hilang.
      }
      throw error;
    }
  }
}
