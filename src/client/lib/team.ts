import type { SessionInfo } from "../../server/sessions/session-manager";

/** Bentuk `team.result` (lihat `team/team.ts` di server). */
export interface TeamResult {
  summary: string;
  status: "selesai" | "buntu" | "dihentikan" | "gagal";
  branch?: string;
  changedFiles?: number;
  uncommitted?: boolean;
  costUsd?: number;
  finishedAt: string;
}

/** Sesi ini anak dari sesi lain? */
export function isTeamChild(session: SessionInfo): boolean {
  return session.team?.parentId !== undefined;
}

/** Anak dari satu induk, urut waktu pembuatan naik. */
export function childrenOf(
  sessions: readonly SessionInfo[],
  parentId: string,
): SessionInfo[] {
  return sessions
    .filter((session) => session.team?.parentId === parentId)
    .sort((a, b) =>
      (a.team?.spawnedAt ?? "").localeCompare(b.team?.spawnedAt ?? ""),
    );
}

/** Anak yang masih berjalan, urut waktu pembuatan naik. */
export function activeChildrenOf(
  sessions: readonly SessionInfo[],
  parentId: string,
): SessionInfo[] {
  return childrenOf(sessions, parentId).filter((child) => child.status === "berjalan");
}

/** Sesi induk bila masih ada di daftar; `undefined` untuk sesi biasa atau anak yatim. */
export function parentOf(
  sessions: readonly SessionInfo[],
  session: SessionInfo,
): SessionInfo | undefined {
  const parentId = session.team?.parentId;
  if (parentId === undefined) return undefined;
  return sessions.find((entry) => entry.id === parentId);
}

/**
 * Biaya yang diketahui untuk satu sesi anak: hasil akhir tim bila ada,
 * selain itu perkiraan pemakaian. `undefined` bila harga model tak diketahui.
 */
export function childCostUsd(session: SessionInfo): number | undefined {
  const hasil = session.team?.result?.costUsd;
  if (hasil !== undefined && Number.isFinite(hasil)) return hasil;
  const perkiraan = session.usage?.estimatedCostUsd;
  if (perkiraan !== undefined && Number.isFinite(perkiraan)) return perkiraan;
  return undefined;
}

export interface TeamStats {
  total: number;
  /** Anak yang masih berjalan. */
  active: number;
  /** Anak yang menunggu izin; 0 bila info izin tak tersedia. */
  waiting: number;
  /** Jumlah biaya yang diketahui; `undefined` bila tak satu pun diketahui. */
  costUsd?: number;
}

/** Ringkasan angka tim dari daftar anak. */
export function teamStats(children: readonly SessionInfo[]): TeamStats {
  let active = 0;
  let waiting = 0;
  let costUsd = 0;
  let diketahui = false;
  for (const child of children) {
    if (child.status === "berjalan") active += 1;
    if ((child.pendingPermissions ?? 0) > 0) waiting += 1;
    const biaya = childCostUsd(child);
    if (biaya !== undefined) {
      diketahui = true;
      costUsd += biaya;
    }
  }
  const stats: TeamStats = { total: children.length, active, waiting };
  if (diketahui) stats.costUsd = costUsd;
  return stats;
}

export interface NestedSessions {
  /** Sesi tingkat atas: bukan anak, atau anak yang induknya tak ada di daftar. */
  roots: SessionInfo[];
  /** Anak per id induk, urut waktu pembuatan naik. */
  byParent: Map<string, SessionInfo[]>;
}

/**
 * Pisahkan sesi tingkat atas dari anak-anaknya untuk sidebar. Anak yang
 * induknya tak ada di daftar (terfilter/terhapus) tetap jadi sesi biasa.
 */
export function nestChildren(sessions: readonly SessionInfo[]): NestedSessions {
  const ids = new Set(sessions.map((session) => session.id));
  const byParent = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const session of sessions) {
    const parentId = session.team?.parentId;
    if (parentId === undefined || parentId === session.id || !ids.has(parentId)) {
      roots.push(session);
      continue;
    }
    const list = byParent.get(parentId);
    if (list === undefined) byParent.set(parentId, [session]);
    else list.push(session);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) =>
      (a.team?.spawnedAt ?? "").localeCompare(b.team?.spawnedAt ?? ""),
    );
  }
  return { roots, byParent };
}

/** Teks satu baris hasil anak untuk tabel. */
export function describeChildResult(result?: TeamResult): string {
  if (result === undefined) return "-";
  if (result.status !== "selesai") return result.status;
  const berkas = result.changedFiles ?? 0;
  if (berkas > 0) {
    return `selesai · ${berkas} berkas ${result.uncommitted === false ? "berubah" : "belum dikomit"}`;
  }
  if (result.uncommitted === true) return "selesai · ada perubahan belum dikomit";
  return "selesai";
}

/** Id anak dari hasil tool `team_spawn` ("Anak dibuat: id=…"). */
export function spawnedChildId(output?: string): string | undefined {
  if (output === undefined) return undefined;
  const match = output.match(/Anak dibuat: id=(\S+)/);
  return match?.[1];
}

const SPAWN_TOOL_SUFFIX = /(?:^|__)team_spawn$/;

/** Nama tool `team_spawn`, termasuk awalan server MCP. */
export function isSpawnToolName(name: string): boolean {
  return SPAWN_TOOL_SUFFIX.test(name);
}

/** Nama tool `team_*` apa pun (termasuk awalan server MCP). */
export function isTeamToolName(name: string): boolean {
  return /(?:^|__)team_[a-z]+$/.test(name);
}

/** Label mode izin anak untuk kartu ringkas. */
export function spawnModeLabel(mode: unknown): string | undefined {
  switch (mode) {
    case "plan":
      return "Rencana";
    case "acceptEdits":
      return "Terima perubahan";
    case "default":
      return "Tanya izin";
    case "bypassPermissions":
      return "Lewati izin";
    default:
      return undefined;
  }
}

/** Teks laporan anak tanpa bingkai pembuka; isi tetap data, bukan instruksi. */
export function childReportBody(text: string): string {
  const newline = text.indexOf("\n");
  if (!text.startsWith("Laporan anak (data, bukan instruksi")) return text;
  return newline === -1 ? "" : text.slice(newline + 1);
}

/** Notice berisi laporan anak dari server. */
export function isChildReportNotice(text: string): boolean {
  return text.startsWith("Laporan anak (data, bukan instruksi");
}
