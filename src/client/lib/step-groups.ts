import type { TimelineItem } from "./timeline";

export type StepItem = Extract<TimelineItem, { kind: "tool" | "thinking" }>;

export type TextItem = Extract<TimelineItem, { kind: "text" }>;

/** Isi blok "Bekerja": langkah dan teks narasi selang-seling, urutan asli. */
export type WorkItem = StepItem | TextItem;

export type WorkBlock = { kind: "work"; items: WorkItem[]; index: number; steps: number };

export type TimelineBlock =
  | { kind: "item"; item: TimelineItem; index: number }
  | { kind: "steps"; items: StepItem[]; index: number }
  | WorkBlock;

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

/**
 * Pembatas segmen: blok yang selalu tampil sendiri dan memutus deretan kerja.
 */
function isBoundary(block: TimelineBlock): boolean {
  return block.kind === "item" && block.item.kind !== "text";
}

/**
 * Lipat satu segmen (deretan langkah dan teks) menjadi satu blok "Bekerja".
 * Teks terakhir segmen adalah jawaban akhir: ia tetap di luar blok.
 */
function foldSegment(blocks: TimelineBlock[], isTail: boolean, live: boolean): TimelineBlock[] {
  const hasSteps = blocks.some((block) => block.kind === "steps");
  if (!hasSteps) return blocks;

  if (isTail) {
    if (live) return blocks;
    const lastText = [...blocks].reverse().find((block) => block.kind === "item");
    const teks = lastText?.kind === "item" ? (lastText.item as TextItem) : undefined;
    if (teks?.streaming === true) return blocks;
  }

  const last = blocks[blocks.length - 1] as TimelineBlock;
  const endsWithText = last.kind === "item";
  const folded = endsWithText ? blocks.slice(0, -1) : blocks;
  const rest: TimelineBlock[] = endsWithText ? [last] : [];

  // Tidak ada yang digabung: blok langkah tunggal tetap blok langkah biasa.
  const single = folded[0];
  if (folded.length === 1 && single?.kind === "steps") return [single, ...rest];

  const items: WorkItem[] = [];
  let steps = 0;
  for (const block of folded) {
    if (block.kind === "steps") {
      items.push(...block.items);
      steps += block.items.length;
    } else if (block.kind === "item") {
      items.push(block.item as TextItem);
    }
  }
  const first = folded[0];
  const index = first?.index ?? 0;
  return [{ kind: "work", items, index, steps }, ...rest];
}

/**
 * Lipat seluruh proses kerja satu giliran jadi satu blok "Bekerja".
 * Sebaliknya `groupSteps`, fungsi ini tidak mengubah blok langkah biasa.
 */
export function foldWork(blocks: readonly TimelineBlock[], opts: { live: boolean }): TimelineBlock[] {
  type Part = { kind: "segment"; blocks: TimelineBlock[] } | { kind: "boundary"; block: TimelineBlock };
  const parts: Part[] = [];
  let current: TimelineBlock[] = [];
  for (const block of blocks) {
    if (isBoundary(block)) {
      if (current.length > 0) {
        parts.push({ kind: "segment", blocks: current });
        current = [];
      }
      parts.push({ kind: "boundary", block });
    } else {
      current.push(block);
    }
  }
  if (current.length > 0) parts.push({ kind: "segment", blocks: current });

  const out: TimelineBlock[] = [];
  parts.forEach((part, i) => {
    if (part.kind === "boundary") {
      out.push(part.block);
      return;
    }
    out.push(...foldSegment(part.blocks, i === parts.length - 1, opts.live));
  });
  return out;
}

/** Judul blok "Bekerja", mis. "Bekerja, 12 langkah". */
export function workTitle(block: WorkBlock): string {
  return `Bekerja, ${block.steps} langkah`;
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
