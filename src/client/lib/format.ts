export function formatCost(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd)) {
    return "–";
  }
  if (usd === 0) {
    return "$0,00";
  }
  if (usd > 0 && usd < 0.01) {
    return "<$0,01";
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

export function parseHashRoute(hash: string): { sessionId?: string } {
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
