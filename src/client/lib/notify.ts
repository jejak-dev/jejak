import type { SessionInfo } from "../../server/sessions/session-manager";
import { isArchived } from "./sessions";

export interface NotifyPrefs {
  enabled: boolean;
  sound: boolean;
}

export type NotifyKind = "izin" | "selesai" | "gagal";

export interface NotifyEvent {
  sessionId: string;
  title: string;
  kind: NotifyKind;
}

export type NotificationSupport = "tidak-ada" | "ditolak" | "belum" | "diizinkan";

const STORAGE_KEY = "jejak.notify";
const DEFAULT_PREFS: NotifyPrefs = { enabled: false, sound: false };

const TITLES: Record<NotifyKind, string> = {
  izin: "Butuh izin",
  selesai: "Selesai",
  gagal: "Gagal",
};

/** Baca preferensi notifikasi dari string JSON; bentuk asing jatuh ke bawaan (semua mati). */
export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  if (raw === null || raw === "") return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_PREFS };
  const value = parsed as Record<string, unknown>;
  return { enabled: value.enabled === true, sound: value.sound === true };
}

export function readNotifyPrefs(): NotifyPrefs {
  try {
    return parseNotifyPrefs(globalThis.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Penyimpanan tidak tersedia (mode privat); notifikasi tetap berfungsi tanpa memori.
  }
}

/**
 * Peristiwa yang layak dinotifikasi antara dua daftar sesi. Tanpa daftar
 * sebelumnya tidak ada peristiwa; sesi arsip dan sesi baru diabaikan.
 */
export function detectEvents(
  prev: SessionInfo[] | undefined,
  next: SessionInfo[],
): NotifyEvent[] {
  if (prev === undefined) return [];
  const before = new Map(prev.map((session) => [session.id, session]));
  const events: NotifyEvent[] = [];
  for (const session of next) {
    if (isArchived(session)) continue;
    const old = before.get(session.id);
    if (old === undefined || isArchived(old)) continue;
    if (session.pendingPermissions > old.pendingPermissions) {
      events.push({ sessionId: session.id, title: session.title, kind: "izin" });
    }
    if (old.status === "berjalan" && session.status === "selesai") {
      events.push({ sessionId: session.id, title: session.title, kind: "selesai" });
    }
    if (old.status === "berjalan" && session.status === "gagal") {
      events.push({ sessionId: session.id, title: session.title, kind: "gagal" });
    }
  }
  return events;
}

export function notificationSupport(): NotificationSupport {
  if (typeof Notification === "undefined") return "tidak-ada";
  switch (Notification.permission) {
    case "granted":
      return "diizinkan";
    case "denied":
      return "ditolak";
    default:
      return "belum";
  }
}

/** Tampilkan notifikasi sistem; klik memfokuskan jendela lalu menjalankan `onClick`. */
export function showNotification(event: NotifyEvent, onClick: () => void): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const notification = new Notification(TITLES[event.kind], {
      body: event.title,
      tag: `jejak-${event.sessionId}-${event.kind}`,
      silent: true,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Fokus jendela tidak tersedia; navigasi tetap dijalankan.
      }
      onClick();
      notification.close();
    };
  } catch {
    // Notifikasi tidak tersedia; peristiwa dilewati.
  }
}

/** Bunyi pendek tanpa berkas audio; dilewati diam-diam bila WebAudio tidak ada. */
export function playBeep(): void {
  try {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (Ctor === undefined) return;
    const context = new Ctor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      void context.close();
    };
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
  } catch {
    // WebAudio tidak tersedia; bunyi dilewati.
  }
}
