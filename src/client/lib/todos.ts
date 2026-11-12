/**
 * Daftar langkah agent dari tool `TodoWrite`. Murni: tanpa DOM, tidak pernah
 * melempar galat; masukan tak sesuai bentuk diabaikan.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Bentuk kalimat berjalan untuk langkah yang sedang dikerjakan. */
  activeForm?: string;
}

/**
 * Bentuk item timeline yang dibutuhkan: panggil tool beserta konteksnya.
 * Seluruh medan selain `name` opsional agar menerima berbagai sumber.
 */
export interface TodoTimelineItem {
  kind?: string;
  name?: string;
  input?: unknown;
  /** Id tool induk: ada bila tool dipanggil dari dalam subagent. */
  parentToolUseId?: string;
  /** Kedalaman timeline: lebih dari 0 berarti punya induk. */
  depth?: number;
}

const TODO_TOOL = "todowrite";

/** "mcp__server__TodoWrite" -> "todowrite"; nama lain menjadi huruf kecil. */
function normalizeName(name: string): string {
  return name.replace(/^mcp__.+?__/i, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Status asing (atau tak ada) dianggap "pending". */
function toStatus(value: unknown): TodoStatus {
  if (value === "in_progress" || value === "completed") return value;
  return "pending";
}

/** Daftar langkah dari satu panggilan TodoWrite; undefined bila tak terbaca. */
function parseTodos(input: unknown): TodoItem[] | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input.todos;
  if (!Array.isArray(raw)) return undefined;

  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (content === "") continue;
    const item: TodoItem = { content, status: toStatus(entry.status) };
    const activeForm = typeof entry.activeForm === "string" ? entry.activeForm.trim() : "";
    if (activeForm !== "") item.activeForm = activeForm;
    out.push(item);
  }
  return out;
}

/**
 * Daftar langkah terakhir yang dikirim agent. Panggilan TodoWrite terbaru
 * menggantikan yang lama (daftarnya penuh), jadi hanya panggilan terakhir
 * yang dipakai. Panggilan dari subagent (punya induk) diabaikan.
 */
export function latestTodos(items: readonly TodoTimelineItem[]): TodoItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind !== undefined && item.kind !== "tool") continue;
    if (item.name === undefined || normalizeName(item.name) !== TODO_TOOL) continue;
    // Panggilan dari subagent punya induk: bukan daftar langkah sesi ini.
    if (item.parentToolUseId !== undefined) continue;
    if ((item.depth ?? 0) > 0) continue;
    return parseTodos(item.input) ?? [];
  }
  return [];
}

/** Jumlah langkah selesai dan jumlah seluruh langkah. */
export function todoProgress(todos: readonly TodoItem[]): { done: number; total: number } {
  let done = 0;
  for (const todo of todos) if (todo.status === "completed") done += 1;
  return { done, total: todos.length };
}
