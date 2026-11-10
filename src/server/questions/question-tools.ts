import type { MemoryToolContext, MemoryToolDefinition, MemoryToolResult } from "../memory/memory-tools";
import { QuestionError, type QuestionService } from "./question-service";

export const QUESTION_TOOL_NAMES = ["question_ask"] as const;
export const QUESTION_ASK_BUDGET = 5;

const ASK_DEFINITION: MemoryToolDefinition = {
  name: "question_ask",
  description:
    "Ajukan pertanyaan terarah ke manusia untuk pengetahuan yang tidak ada di kode (mis. tabel X ditulis service mana saja). Pertanyaan masuk antrean terbuka; kamu tidak mendapat jawabannya di sesi ini dan jangan menebak jawabannya. Jangan menyertakan rahasia.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 300 },
      assignee: { type: "string", maxLength: 60 },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

function fail(text: string): MemoryToolResult {
  return { text, isError: true };
}

export class QuestionTools {
  readonly definitions: MemoryToolDefinition[] = [ASK_DEFINITION];
  private readonly asked = new Map<string, number>();

  constructor(private readonly service: QuestionService) {}

  async call(ctx: MemoryToolContext, name: string, args: unknown): Promise<MemoryToolResult> {
    if (name !== "question_ask") return fail(`Tool "${String(name)}" tidak dikenal.`);
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return fail("Argumen question_ask harus berupa objek.");
    }
    const record = args as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "question" && key !== "assignee") return fail(`Argumen "${key}" tidak dikenal.`);
    }
    const used = this.asked.get(ctx.sessionId) ?? 0;
    if (used >= QUESTION_ASK_BUDGET) return fail("Batas pertanyaan per sesi tercapai.");
    try {
      this.service.ask({
        question: record.question,
        assignee: record.assignee,
        layer: "project",
        projectKey: ctx.projectKey,
        sessionId: ctx.sessionId,
      });
    } catch (error) {
      return fail(error instanceof QuestionError ? error.message : "Pertanyaan gagal dicatat.");
    }
    this.asked.set(ctx.sessionId, used + 1);
    return {
      text: "Pertanyaan dicatat di antrean dan menunggu jawaban manusia. Lanjutkan tugas tanpa menebak jawabannya.",
      isError: false,
    };
  }
}
