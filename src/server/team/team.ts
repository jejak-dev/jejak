/**
 * Model data dan batas keras tim agent. Fungsi murni: tanpa I/O, tanpa state
 * global. Penegakan batas dilakukan di `SessionManager.spawnChild`; modul ini
 * hanya memutuskan boleh/tidak.
 */

export interface TeamResult {
  /** <= 4000 karakter. */
  summary: string;
  status: "selesai" | "buntu" | "dihentikan" | "gagal";
  branch?: string;
  changedFiles?: number;
  costUsd: number;
}

export interface TeamInfo {
  /** Ada berarti sesi ini anak dari sesi tersebut. */
  parentId?: string;
  /** <= 40 karakter, dipangkas. */
  role?: string;
  /** ISO. */
  spawnedAt: string;
  /** <= 4000 karakter (dipotong), sudah disamarkan rahasia oleh pemanggil. */
  brief: string;
  /** Diisi saat anak selesai (irisan T3). */
  result?: TeamResult;
}

export interface TeamLimits {
  /** Kedalaman maksimum: anak tidak boleh beranak lagi. */
  maxDepth: 1;
  maxActiveChildren: number;
  maxTotalChildren: number;
}

export const TEAM_HARD_MAX_ACTIVE = 8;
export const TEAM_HARD_MAX_TOTAL = 40;
export const TEAM_DEFAULT_ACTIVE = 3;
export const TEAM_DEFAULT_TOTAL = 12;
export const TEAM_BRIEF_MAX = 4000;
export const TEAM_ROLE_MAX = 40;

/** Nilai permintaan yang tidak masuk akal diabaikan dan memakai bawaan. */
function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) return fallback;
  return value;
}

/**
 * Batas anak efektif. Satu jatah `maxConcurrent` disisakan untuk induk dan
 * satu untuk sesi lain (temuan spike T0), jadi batas anak aktif menyusut saat
 * `maxConcurrent` kecil.
 */
export function teamLimits(input: {
  maxConcurrent: number;
  maxActiveChildren?: number;
  maxTotalChildren?: number;
}): TeamLimits {
  const concurrent = Number.isFinite(input.maxConcurrent) ? input.maxConcurrent : 0;
  const sisa = Math.max(0, Math.floor(concurrent) - 2);
  const active = Math.min(
    positiveInteger(input.maxActiveChildren, TEAM_DEFAULT_ACTIVE),
    TEAM_HARD_MAX_ACTIVE,
    sisa,
  );
  const total = Math.min(
    positiveInteger(input.maxTotalChildren, TEAM_DEFAULT_TOTAL),
    TEAM_HARD_MAX_TOTAL,
  );
  return {
    maxDepth: 1,
    maxActiveChildren: Math.max(0, active),
    maxTotalChildren: Math.max(0, total),
  };
}

export type TeamMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Kelonggaran naik: plan < default < acceptEdits < bypassPermissions. */
const MODE_RANK: Record<TeamMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
};

/** Anak tidak pernah lebih longgar dari induk; bypass untuk anak selalu ditolak. */
export function childModeAllowed(parent: TeamMode, child: TeamMode): boolean {
  if (child === "bypassPermissions") return false;
  if (child === "plan") return true;
  return MODE_RANK[child] <= MODE_RANK[parent];
}

export type SpawnRefusalCode =
  | "dinonaktifkan"
  | "induk-tak-ada"
  | "anak-tak-boleh-beranak"
  | "penuh-aktif"
  | "penuh-total"
  | "mode-lebih-longgar";

export interface SpawnCheckInput {
  enabled: boolean;
  parent:
    | { exists: boolean; isChild: boolean; permissionMode: TeamMode }
    | undefined;
  children: readonly { status: "berjalan" | "selesai" | "gagal" | "dibatalkan" }[];
  limits: TeamLimits;
  /** Bila kosong: "default". */
  requestedMode?: TeamMode;
}

export type SpawnCheck =
  | { ok: true; mode: TeamMode }
  | { ok: false; code: SpawnRefusalCode; message: string };

/** Urutan pemeriksaan tetap: enabled, induk, kedalaman, aktif, total, mode. */
export function checkSpawn(input: SpawnCheckInput): SpawnCheck {
  if (!input.enabled) {
    return {
      ok: false,
      code: "dinonaktifkan",
      message: "Tim agent dimatikan di server ini.",
    };
  }
  const parent = input.parent;
  if (parent === undefined || !parent.exists) {
    return {
      ok: false,
      code: "induk-tak-ada",
      message: "Sesi induk tidak ditemukan.",
    };
  }
  if (parent.isChild) {
    return {
      ok: false,
      code: "anak-tak-boleh-beranak",
      message: "Sesi anak tidak boleh membuat anak lagi.",
    };
  }
  const active = input.children.filter((child) => child.status === "berjalan").length;
  if (active >= input.limits.maxActiveChildren) {
    return {
      ok: false,
      code: "penuh-aktif",
      message: "Anak aktif sudah mencapai batas; tunggu anak lain selesai sebelum membuat yang baru.",
    };
  }
  if (input.children.length >= input.limits.maxTotalChildren) {
    return {
      ok: false,
      code: "penuh-total",
      message: "Jumlah anak sudah mencapai batas total untuk sesi ini.",
    };
  }
  const mode = input.requestedMode ?? "default";
  if (!childModeAllowed(parent.permissionMode, mode)) {
    return {
      ok: false,
      code: "mode-lebih-longgar",
      message: `Mode "${mode}" lebih longgar dari mode induk; anak tidak boleh lebih longgar.`,
    };
  }
  return { ok: true, mode };
}

/** Label peran bebas: dipangkas, kosong menjadi `undefined`, dipotong batas. */
export function clampRole(role: unknown): string | undefined {
  if (typeof role !== "string") return undefined;
  const value = role.trim();
  if (value === "") return undefined;
  return value.slice(0, TEAM_ROLE_MAX);
}

/** Brief tugas: dipotong batas tanpa memangkas spasi di ujung. */
export function clampBrief(text: string): string {
  return text.slice(0, TEAM_BRIEF_MAX);
}

/** Tim aktif kecuali `JEJAK_TEAM` diisi "0". */
export function isTeamEnabled(env: Record<string, string | undefined>): boolean {
  return env.JEJAK_TEAM?.trim() !== "0";
}
