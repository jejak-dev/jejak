import type {
  AuditEntryItem,
  AuditQueryInput,
  AuditSummaryResult,
} from "./api";

/** Label tampilan untuk 13 jenis audit; server tetap sumber kebenaran. */
export const AUDIT_KIND_LABELS: Record<string, string> = {
  "sesi-mulai": "Sesi mulai",
  "sesi-berhenti": "Sesi berhenti",
  tool: "Tool",
  izin: "Izin",
  berkas: "Berkas",
  git: "Git",
  "rahasia-disamarkan": "Rahasia disamarkan",
  "rahasia-diblokir": "Rahasia diblokir",
  mcp: "MCP",
  pengaturan: "Pengaturan",
  anggaran: "Anggaran",
  provider: "Provider",
  sandbox: "Sandbox",
};

export const AUDIT_META_MAX_PAIRS = 6;
export const AUDIT_META_VALUE_MAX = 40;
export const AUDIT_SESSION_TITLE_MAX = 32;
export const AUDIT_PAGE_LIMIT = 50;

export type AuditTone = "" | "warn" | "bad";

export function kindLabel(kind: string): string {
  return AUDIT_KIND_LABELS[kind] ?? kind;
}

export function kindTone(kind: string): AuditTone {
  if (kind === "rahasia-diblokir") return "bad";
  if (kind === "rahasia-disamarkan") return "warn";
  if (kind === "anggaran") return "warn";
  if (kind === "sandbox") return "warn";
  return "";
}

function metaValue(value: string | number | boolean | null): string | undefined {
  if (value === null) return undefined;
  const text = typeof value === "boolean" ? (value ? "ya" : "tidak") : String(value);
  return text.length > AUDIT_META_VALUE_MAX ? `${text.slice(0, AUDIT_META_VALUE_MAX)}…` : text;
}

/** Ringkasan meta satu baris: `kunci: nilai · kunci: nilai`. Teks biasa, bukan HTML. */
export function metaLine(meta: Record<string, string | number | boolean | null> | undefined): string {
  if (meta === undefined || meta === null) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (parts.length >= AUDIT_META_MAX_PAIRS) break;
    const text = metaValue(value);
    if (text === undefined) continue;
    parts.push(`${key}: ${text}`);
  }
  return parts.join(" · ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clockOf(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `14:03` hari ini, `kemarin 14:03`, selain itu `9 Nov 14:03`; ISO tak valid dikembalikan apa adanya. */
export function formatAuditTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const clock = clockOf(date);
  if (sameDay(date, now)) return clock;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) return `kemarin ${clock}`;
  const day = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date);
  return `${day} ${clock}`;
}

export function sessionLabel(
  sessionId: string | null | undefined,
  sessions: readonly { id: string; title: string }[],
): string | undefined {
  if (sessionId === undefined || sessionId === null || sessionId === "") return undefined;
  const match = sessions.find((session) => session.id === sessionId);
  if (match === undefined) return `sesi ${sessionId}`;
  return match.title.length > AUDIT_SESSION_TITLE_MAX
    ? `${match.title.slice(0, AUDIT_SESSION_TITLE_MAX)}…`
    : match.title;
}

/** Query untuk `listAudit`; nilai kosong dibuang dan limit tetap 50. */
export function auditQueryFor(
  filter: { kind: string; session: string },
  before?: number,
): AuditQueryInput {
  const query: AuditQueryInput = { limit: AUDIT_PAGE_LIMIT };
  if (filter.kind !== "") query.kind = filter.kind;
  if (filter.session !== "") query.session = filter.session;
  if (before !== undefined) query.before = before;
  return query;
}

/** Gabung tanpa duplikat id, urut id menurun (terbaru dulu). */
export function mergeEntries(
  existing: readonly AuditEntryItem[],
  incoming: readonly AuditEntryItem[],
): AuditEntryItem[] {
  const byId = new Map<number, AuditEntryItem>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function summaryLine(summary: AuditSummaryResult): string {
  const base = `${summary.total} aksi dalam ${summary.days} hari`;
  if (summary.redactedSessions > 0) {
    return `${base} · ${summary.redactedSessions} sesi dengan rahasia disamarkan`;
  }
  return base;
}
