/** Normalisasi untuk pencocokan: tanpa diakritik, huruf kecil. */
export function normalizeForCompare(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const WORD_BOUNDARY = /[\s/_.\-:]/;

/**
 * Skor fuzzy tak peka huruf besar/kecil dan diakritik.
 * Urutan mutu: awalan (1000-an) > awal kata (500-an) > subsequence (100-an).
 * Kembali `undefined` bila tidak ada kecocokan.
 */
export function fuzzyScore(query: string, label: string): number | undefined {
  const q = normalizeForCompare(query.trim());
  const t = normalizeForCompare(label);
  if (q === "" || t === "") return undefined;

  const density = q.length / t.length;

  if (t.startsWith(q)) {
    return 1000 + density * 100;
  }

  for (let index = 0; index + q.length <= t.length; index += 1) {
    const atBoundary = index === 0 || WORD_BOUNDARY.test(t[index - 1] ?? "");
    if (atBoundary && t.startsWith(q, index)) {
      return 500 + density * 100;
    }
  }

  // Subsequence: setiap huruf query muncul berurutan (boleh berselang).
  let cursor = 0;
  let run = 0;
  let bestRun = 0;
  let span = 0;
  let first = -1;
  let last = -1;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return undefined;
    if (first === -1) first = found;
    last = found;
    span = found - first + 1;
    run = found === cursor && cursor !== 0 ? run + 1 : 1;
    bestRun = Math.max(bestRun, run);
    cursor = found + 1;
  }

  // Rapat: deretan huruf berurutan panjang dan rentang sempit diberi skor lebih tinggi.
  const tightness = q.length / Math.max(span, q.length);
  return 100 + bestRun * 10 + tightness * 40;
}

export type CommandId =
  | "new-session"
  | "open-workspace"
  | "open-mcp"
  | "open-audit"
  | "open-instruksi"
  | "open-usage"
  | "open-memory"
  | "open-providers"
  | "toggle-panel"
  | "open-git"
  | "open-secrets-tab"
  | "focus-search"
  | "show-shortcuts"
  | "compact";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: "aksi" | "sesi";
  run: CommandId | { session: string };
  /** Folder sesi (hanya baris sesi); ikut dicocokkan saat menyaring. */
  folder?: string;
  /** Status sesi (hanya baris sesi); untuk tampilan. */
  status?: string;
}

export interface BuildCommandsInput {
  sessions: readonly {
    id: string;
    title: string;
    cwd: string;
    status: string;
    archivedAt?: string;
  }[];
  hasSession: boolean;
  panelOpen: boolean;
}

/** Aksi tetap dulu, lalu sesi tidak terarsip terbaru (maks 50). */
export function buildCommands({ sessions, hasSession, panelOpen }: BuildCommandsInput): Command[] {
  const commands: Command[] = [
    { id: "new-session", label: "New session", group: "aksi", run: "new-session" },
    { id: "open-workspace", label: "Buka Workspace", group: "aksi", run: "open-workspace" },
    { id: "open-mcp", label: "Buka Server MCP", group: "aksi", run: "open-mcp" },
    { id: "open-audit", label: "Buka log audit", group: "aksi", run: "open-audit" },
    { id: "open-instruksi", label: "Buka instruksi dan skills", group: "aksi", run: "open-instruksi" },
    { id: "open-usage", label: "Buka Usage", group: "aksi", run: "open-usage" },
    { id: "open-memory", label: "Buka Memory", group: "aksi", run: "open-memory" },
    { id: "open-providers", label: "Buka Provider", group: "aksi", run: "open-providers" },
  ];

  if (hasSession) {
    commands.push({
      id: "toggle-panel",
      label: "Tampilkan/Sembunyikan panel",
      hint: "p",
      group: "aksi",
      run: "toggle-panel",
    });
    commands.push({
      id: "compact",
      label: "Compact percakapan",
      group: "aksi",
      run: "compact",
    });
    commands.push({
      id: "open-git",
      label: "Buka panel Git",
      group: "aksi",
      run: "open-git",
    });
    commands.push({
      id: "open-secrets-tab",
      label: "Buka tab Rahasia",
      group: "aksi",
      run: "open-secrets-tab",
    });
  }

  commands.push({ id: "focus-search", label: "Cari sesi", hint: "/", group: "aksi", run: "focus-search" });
  commands.push({
    id: "show-shortcuts",
    label: "Pintasan keyboard",
    hint: "?",
    group: "aksi",
    run: "show-shortcuts",
  });

  let shown = 0;
  for (const session of sessions) {
    if (session.archivedAt !== undefined) continue;
    if (shown >= 50) break;
    commands.push({
      id: `session-${session.id}`,
      label: session.title,
      group: "sesi",
      run: { session: session.id },
      folder: session.cwd,
      status: session.status,
    });
    shown += 1;
  }

  return commands;
}

function scoreCommand(command: Command, query: string): number | undefined {
  const labelScore = fuzzyScore(query, command.label);
  if (command.group !== "sesi" || command.folder === undefined) return labelScore;
  const folderScore = fuzzyScore(query, command.folder);
  if (labelScore === undefined) return folderScore;
  if (folderScore === undefined) return labelScore;
  return Math.max(labelScore, folderScore);
}

/**
 * Saring berdasarkan skor. Tanpa ketikan hasil mengikuti urutan `buildCommands`
 * (aksi dulu, lalu sesi terbaru); `limit` membatasi jumlah baris.
 */
export function filterCommands(commands: readonly Command[], query: string, limit = 50): Command[] {
  if (query.trim() === "") {
    return commands.slice(0, limit);
  }

  const scored: { command: Command; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(command, query);
    if (score !== undefined) scored.push({ command, score, index });
  });

  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return scored.slice(0, limit).map((entry) => entry.command);
}
