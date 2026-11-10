import type { TimelineItem } from "./timeline";

export type StepItem = Extract<TimelineItem, { kind: "tool" | "thinking" }>;

export type TimelineBlock =
  | { kind: "item"; item: TimelineItem; index: number }
  | { kind: "steps"; items: StepItem[]; index: number };

/** Tool yang tidak ditampilkan sebagai langkah (dipegang kartu izin). */
function isHiddenTool(item: TimelineItem): boolean {
  return item.kind === "tool" && (item.name === "AskUserQuestion" || item.name === "ExitPlanMode");
}

/**
 * Gabungkan deretan berurutan langkah (tool dan berpikir) menjadi satu blok
 * terlipat. Teks, kartu izin, galat, dan hasil memutus deretan.
 */
export function groupSteps(items: readonly TimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let run: StepItem[] = [];
  let runStart = 0;

  const flush = (): void => {
    if (run.length > 0) blocks.push({ kind: "steps", items: run, index: runStart });
    run = [];
  };

  items.forEach((item, index) => {
    if (isHiddenTool(item)) return;
    if (item.kind === "tool" || item.kind === "thinking") {
      if (run.length === 0) runStart = index;
      run.push(item);
      return;
    }
    flush();
    blocks.push({ kind: "item", item, index });
  });
  flush();
  return blocks;
}

type Category = "think" | "memory" | "command" | "read" | "edit" | "web" | "other";

function categoryOf(item: StepItem): Category {
  if (item.kind === "thinking") return "think";
  const name = item.name;
  if (name.startsWith("mcp__jejak-memory__")) return "memory";
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "command";
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "WebFetch":
    case "WebSearch":
      return "web";
    default:
      return "other";
  }
}

const ORDER: Category[] = ["think", "memory", "read", "command", "edit", "web", "other"];

function phrase(category: Category, count: number): string {
  switch (category) {
    case "think":
      return "berpikir";
    case "memory":
      return `mengingat kembali ${count} memori`;
    case "read":
      return `membaca atau mencari ${count} kali`;
    case "command":
      return `menjalankan ${count} perintah`;
    case "edit":
      return `mengubah ${count} berkas`;
    case "web":
      return `mencari di web ${count} kali`;
    case "other":
      return `memakai ${count} tool`;
  }
}

/** Ringkasan satu baris untuk blok langkah, mis. "Berpikir, menjalankan 5 perintah". */
export function summarizeSteps(items: readonly StepItem[]): string {
  const counts = new Map<Category, number>();
  for (const item of items) {
    const category = categoryOf(item);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts = ORDER.filter((category) => counts.has(category)).map((category) =>
    phrase(category, counts.get(category) ?? 0),
  );
  const text = parts.join(", ");
  return text === "" ? "" : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Banyak langkah gagal dan ada tidaknya yang masih berjalan. */
export function stepsStatus(items: readonly StepItem[]): { failed: number; running: boolean } {
  let failed = 0;
  let running = false;
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (item.status === "gagal") failed += 1;
    if (item.status === "berjalan") running = true;
  }
  return { failed, running };
}
