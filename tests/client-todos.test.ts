import { describe, expect, test } from "bun:test";
import { latestTodos, todoProgress, type TodoTimelineItem } from "../src/client/lib/todos";

function toolCall(input: unknown, patch: Partial<TodoTimelineItem> = {}): TodoTimelineItem {
  return { kind: "tool", name: "TodoWrite", input, depth: 0, ...patch };
}

function todo(
  content: string,
  status: string,
  activeForm?: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { content, status };
  if (activeForm !== undefined) entry.activeForm = activeForm;
  return entry;
}

describe("latestTodos", () => {
  test("tanpa panggilan TodoWrite hasilnya kosong", () => {
    expect(latestTodos([])).toEqual([]);
    expect(
      latestTodos([
        { kind: "user", name: undefined },
        toolCall({ command: "ls" }, { name: "Bash" }),
      ]),
    ).toEqual([]);
  });

  test("satu panggilan diambil apa adanya", () => {
    const todos = latestTodos([
      toolCall({
        todos: [
          todo("Baca berkas", "completed"),
          todo("Tulis berkas", "in_progress", "Menulis berkas"),
          todo("Uji", "pending"),
        ],
      }),
    ]);

    expect(todos).toEqual([
      { content: "Baca berkas", status: "completed" },
      { content: "Tulis berkas", status: "in_progress", activeForm: "Menulis berkas" },
      { content: "Uji", status: "pending" },
    ]);
  });

  test("panggilan terakhir menggantikan yang lama", () => {
    const todos = latestTodos([
      toolCall({ todos: [todo("Langkah lama", "pending")] }),
      toolCall({ todos: [todo("Langkah baru", "completed")] }),
    ]);

    expect(todos).toEqual([{ content: "Langkah baru", status: "completed" }]);
  });

  test("entri tak valid diabaikan", () => {
    const todos = latestTodos([
      toolCall({
        todos: [
          todo("Sah", "pending"),
          "bukan objek",
          null,
          { status: "pending" },
          { content: "", status: "pending" },
          { content: "   ", status: "pending" },
          { content: 42, status: "pending" },
        ],
      }),
    ]);

    expect(todos).toEqual([{ content: "Sah", status: "pending" }]);
  });

  test("status asing menjadi pending", () => {
    const todos = latestTodos([
      toolCall({
        todos: [
          todo("Tanpa status", "unknown"),
          { content: "Tanpa medan status" },
        ],
      }),
    ]);

    expect(todos).toEqual([
      { content: "Tanpa status", status: "pending" },
      { content: "Tanpa medan status", status: "pending" },
    ]);
  });

  test("activeForm tak sah diabaikan", () => {
    const todos = latestTodos([
      toolCall({
        todos: [
          { content: "Satu", status: "in_progress", activeForm: 5 },
          { content: "Dua", status: "in_progress", activeForm: "  " },
          { content: "Tiga", status: "in_progress", activeForm: "Kerjakan tiga" },
        ],
      }),
    ]);

    expect(todos).toEqual([
      { content: "Satu", status: "in_progress" },
      { content: "Dua", status: "in_progress" },
      { content: "Tiga", status: "in_progress", activeForm: "Kerjakan tiga" },
    ]);
  });

  test("panggilan subagent diabaikan", () => {
    const todos = latestTodos([
      toolCall({ todos: [todo("Langkah sesi", "pending")] }),
      toolCall({ todos: [todo("Langkah subagent", "completed")] }, { parentToolUseId: "t9" }),
    ]);

    expect(todos).toEqual([{ content: "Langkah sesi", status: "pending" }]);
  });

  test("tool bernama lain diabaikan", () => {
    const todos = latestTodos([
      toolCall({ todos: [todo("Bukan todos", "pending")] }, { name: "Task" }),
      toolCall({ todos: [todo("Sah", "pending")] }, { name: "mcp__server__TodoWrite" }),
    ]);

    expect(todos).toEqual([{ content: "Sah", status: "pending" }]);
  });

  test("masukan tak terbaca menghasilkan daftar kosong", () => {
    expect(latestTodos([toolCall(undefined)])).toEqual([]);
    expect(latestTodos([toolCall({})])).toEqual([]);
    expect(latestTodos([toolCall({ todos: "bukan daftar" })])).toEqual([]);
  });
});

describe("todoProgress", () => {
  test("menghitung selesai dan total", () => {
    expect(
      todoProgress([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toEqual({ done: 1, total: 3 });
  });

  test("daftar kosong nol", () => {
    expect(todoProgress([])).toEqual({ done: 0, total: 0 });
  });
});
