import { parsePlan } from "./ask-question";
import type { PermissionStatus, TimelineItem } from "./timeline";

/** Judul cadangan saat dokumen rencana tak punya heading. */
export const PLAN_TITLE_FALLBACK = "Rencana";

/** Batas panjang kutipan rencana yang tampil di kartu ringkas pada chat. */
export const PLAN_EXCERPT_MAX = 160;

/** Satu rencana dari sebuah sesi; dokumennya utuh, chat hanya memakai kutipan. */
export interface PlanEntry {
  /** Id izin asal-usul rencana ini. */
  id: string;
  title: string;
  /** Isi dokumen markdown lengkap. */
  plan: string;
  status: PermissionStatus;
  expiresAt?: string;
  message?: string;
}

/** Buang penanda markdown sebaris (tebal, miring, kode, tautan). */
function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/** Buang penanda markdown di awal baris (heading, daftar, kutipan). */
function stripBlock(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,3}\[[ xX]\]\s+/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "")
    .trim();
}

/**
 * Judul rencana: heading markdown pertama; bila tak ada, "Rencana".
 *
 * Judul dipakai sebagai nama singkat di chat dan di pemilih tab Rencana.
 */
export function planTitle(markdown: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const cocok = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (cocok === null) continue;
    const judul = stripInline(cocok[1] ?? "").trim();
    if (judul !== "") return judul;
  }
  return PLAN_TITLE_FALLBACK;
}

/**
 * Kutipan singkat rencana tanpa sintaks markdown.
 *
 * Maksimal tiga baris dan `max` karakter; baris heading tidak diulang karena
 * sudah dipakai sebagai judul.
 */
export function planExcerpt(markdown: string, max: number = PLAN_EXCERPT_MAX): string {
  const baris: string[] = [];
  let total = 0;
  let dalamKode = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const polos = raw.trim();
    if (polos.startsWith("```")) {
      dalamKode = !dalamKode;
      continue;
    }
    if (dalamKode) continue;
    if (polos === "" || polos === "---" || polos === "***" || polos === "___") continue;
    // Baris heading sudah jadi judul; jangan diulang di kutipan.
    if (/^\s{0,3}#{1,6}\s+/.test(raw)) continue;

    const teks = stripInline(stripBlock(raw));
    if (teks === "") continue;
    if (baris.length >= 3) break;

    const tambahan = (baris.length === 0 ? 0 : 1) + teks.length;
    if (total + tambahan > max) {
      const sisa = max - total - (baris.length === 0 ? 0 : 1);
      if (sisa > 1) baris.push(`${teks.slice(0, sisa - 1).trimEnd()}…`);
      break;
    }
    baris.push(teks);
    total += tambahan;
  }

  return baris.join("\n");
}

/**
 * Semua rencana yang pernah diminta dalam sebuah sesi.
 *
 * Urutan mengikuti timeline: yang terakhir adalah rencana terbaru.
 */
export function extractPlans(items: readonly TimelineItem[]): PlanEntry[] {
  const plans: PlanEntry[] = [];
  for (const item of items) {
    if (item.kind !== "permission" || item.name !== "ExitPlanMode") continue;
    const plan = parsePlan(item.input);
    if (plan === undefined) continue;
    const entry: PlanEntry = {
      id: item.id,
      title: planTitle(plan),
      plan,
      status: item.status,
    };
    if (item.expiresAt !== undefined) entry.expiresAt = item.expiresAt;
    if (item.message !== undefined) entry.message = item.message;
    plans.push(entry);
  }
  return plans;
}

/** Rencana terbaru; undefined bila belum ada rencana. */
export function latestPlan(plans: readonly PlanEntry[]): PlanEntry | undefined {
  return plans.length === 0 ? undefined : plans[plans.length - 1];
}

/** Rencana yang masih menunggu keputusan pengguna. */
export function pendingPlans(plans: readonly PlanEntry[]): PlanEntry[] {
  return plans.filter((entry) => entry.status === "menunggu");
}
