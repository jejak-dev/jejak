export function formatCost(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd)) {
    return "–";
  }
  if (usd === 0) {
    return "$0,00";
  }
  if (usd > 0 && usd < 0.01) {
    const fixed = usd.toFixed(4);
    if (Number(fixed) === 0) {
      return "<$0,0001";
    }
    return `$${fixed.replace(/0+$/, "").replace(".", ",")}`;
  }
  return `$${usd.toFixed(2).replace(".", ",")}`;
}

export function formatCount(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) {
    return "–";
  }
  return new Intl.NumberFormat("id-ID").format(n);
}

export function formatRelative(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 45_000) {
    return "baru saja";
  }
  if (diffMs < 3_600_000) {
    return `${Math.max(1, Math.floor(diffMs / 60_000))} mnt lalu`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.max(1, Math.floor(diffMs / 3_600_000))} jam lalu`;
  }
  if (diffMs < 172_800_000) {
    return "kemarin";
  }
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date);
}

export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "/";
}

export function formatAgo(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 45_000) return "baru";
  if (diffMs < 3_600_000) return `${Math.max(1, Math.floor(diffMs / 60_000))}m`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.floor(diffMs / 3_600_000))}j`;
  if (diffMs < 30 * 86_400_000) return `${Math.max(1, Math.floor(diffMs / 86_400_000))}h`;
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date);
}

export interface SessionGroup<T> {
  cwd: string;
  label: string;
  items: T[];
}

/** Kelompokkan sesi per folder kerja; kelompok dan isinya diurutkan dari yang terbaru. */
/** macOS memetakan /tmp, /var, /etc ke /private/...: samakan agar dua tulisan jalur itu dianggap sama. */
export function canonicalPath(path: string): string {
  return path.replace(/^\/private(\/(?:tmp|var|etc)(?:\/|$))/, "$1");
}

export function groupSessions<T extends { cwd: string; updatedAt: string; worktree?: { repoRoot: string } }>(
  sessions: readonly T[],
): SessionGroup<T>[] {
  const byCwd = new Map<string, T[]>();
  for (const session of sessions) {
    // Sesi worktree dikelompokkan di bawah repo asalnya, bukan folder worktree.
    const key = canonicalPath(session.worktree?.repoRoot ?? session.cwd);
    const list = byCwd.get(key);
    if (list === undefined) byCwd.set(key, [session]);
    else list.push(session);
  }

  const newestFirst = (a: T, b: T): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  const groups = [...byCwd.entries()].map(([cwd, items]) => ({
    cwd,
    label: folderName(cwd),
    items: [...items].sort(newestFirst),
  }));
  return groups.sort((a, b) => newestFirst(a.items[0]!, b.items[0]!));
}

export type StatusTone = "accent" | "success" | "danger" | "muted";

export function statusTone(status: string): StatusTone {
  if (status === "berjalan") return "accent";
  if (status === "selesai") return "success";
  if (status === "gagal") return "danger";
  return "muted";
}

export function shortPath(path: string, max = 36): string {
  if (path.length <= max) {
    return path;
  }

  const segments = path.split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1] ?? path;
  let tail = last;

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `${segments[index]}/${tail}`;
    if (candidate.length + 2 > max) break;
    tail = candidate;
  }

  return `…/${tail}`;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type AppView = "providers" | "memory" | "workspaces" | "mcp" | "audit" | "instruksi";

export interface HashRoute {
  sessionId?: string;
  view?: AppView;
}

export function parseHashRoute(hash: string): HashRoute {
  if (hash === "#/providers") {
    return { view: "providers" };
  }
  if (hash === "#/memory") {
    return { view: "memory" };
  }
  if (hash === "#/workspaces") {
    return { view: "workspaces" };
  }
  if (hash === "#/mcp") {
    return { view: "mcp" };
  }
  if (hash === "#/audit") {
    return { view: "audit" };
  }
  if (hash === "#/instruksi") {
    return { view: "instruksi" };
  }

  const match = /^#\/s\/([^/?#]+)$/.exec(hash);
  if (match === null) {
    return {};
  }

  const raw = match[1] ?? "";
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(raw);
  } catch {
    return {};
  }

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {};
  }
  return { sessionId };
}

export function sessionHash(id?: string): string {
  if (id === undefined || id === "") {
    return "#/";
  }
  return `#/s/${id}`;
}

export function providersHash(): string {
  return "#/providers";
}

export function memoryHash(): string {
  return "#/memory";
}

export function workspacesHash(): string {
  return "#/workspaces";
}

export function mcpHash(): string {
  return "#/mcp";
}

export function auditHash(): string {
  return "#/audit";
}

export function instruksiHash(): string {
  return "#/instruksi";
}

export type ToolCallingTone = "success" | "warning" | "muted";

export interface ToolCallingDescription {
  label: string;
  tone: ToolCallingTone;
}

export function describeToolCalling(
  status: "ok" | "tidak-dipanggil" | "tidak-diuji",
): ToolCallingDescription {
  switch (status) {
    case "ok":
      return { label: "Tool calling berfungsi", tone: "success" };
    case "tidak-dipanggil":
      return {
        label: "Model tidak memanggil tool; agen mungkin kurang andal",
        tone: "warning",
      };
    default:
      return { label: "Tool calling tidak diuji", tone: "muted" };
  }
}
