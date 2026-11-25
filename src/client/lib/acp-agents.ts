/**
 * Agent ACP (mis. Antigravity) yang bisa dipakai sebagai anak tim. Jejak tidak
 * menyimpan kredensial: login dilakukan di terminal milik pengguna.
 */

export type AcpAgentState = "tidak-terpasang" | "belum-login" | "siap" | "galat";

/** Ringkasan satu agent untuk daftar di Pengaturan. */
export interface AcpAgentInfo {
  id: string;
  label: string;
  installed: boolean;
  installHint: string;
  loginHint: string;
}

/** Hasil probe satu agent; bentuknya sama dengan status di server. */
export interface AcpAgentStatus {
  id: string;
  label: string;
  state: AcpAgentState;
  hint?: string;
  authMethods?: { id: string; name: string }[];
  models?: number;
  detail?: string;
}

const STATES: readonly AcpAgentState[] = ["tidak-terpasang", "belum-login", "siap", "galat"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is AcpAgentState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** Baca daftar agent; bentuk asing atau nilai tak dikenal dilempar sebagai galat. */
export function parseAcpAgentList(raw: unknown): AcpAgentInfo[] {
  if (!isRecord(raw) || !Array.isArray(raw.agents)) {
    throw new Error("Daftar agent tidak valid.");
  }
  return raw.agents.map((item, index): AcpAgentInfo => {
    if (!isRecord(item)) throw new Error(`Agent ke-${index + 1} tidak valid.`);
    const { id, label, installed, installHint, loginHint } = item;
    if (
      typeof id !== "string" ||
      typeof label !== "string" ||
      typeof installed !== "boolean" ||
      typeof installHint !== "string" ||
      typeof loginHint !== "string"
    ) {
      throw new Error(`Agent ke-${index + 1} tidak valid.`);
    }
    return { id, label, installed, installHint, loginHint };
  });
}

/** Baca status probe; bentuk asing atau state tak dikenal dilempar sebagai galat. */
export function parseAcpAgentStatus(raw: unknown): AcpAgentStatus {
  if (!isRecord(raw)) throw new Error("Status agent tidak valid.");
  if (typeof raw.id !== "string" || typeof raw.label !== "string" || !isState(raw.state)) {
    throw new Error("Status agent tidak valid.");
  }
  const status: AcpAgentStatus = { id: raw.id, label: raw.label, state: raw.state };
  if (typeof raw.hint === "string") status.hint = raw.hint;
  if (typeof raw.detail === "string") status.detail = raw.detail;
  if (typeof raw.models === "number") status.models = raw.models;
  if (Array.isArray(raw.authMethods)) {
    const methods: { id: string; name: string }[] = [];
    for (const item of raw.authMethods) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") {
        throw new Error("Status agent tidak valid.");
      }
      methods.push({ id: item.id, name: item.name });
    }
    status.authMethods = methods;
  }
  return status;
}

/** Teks Indonesia untuk lencana status; `undefined` berarti belum diperiksa. */
export function acpStateLabel(state: AcpAgentState | undefined): string {
  switch (state) {
    case "tidak-terpasang":
      return "Tidak terpasang";
    case "belum-login":
      return "Belum login";
    case "siap":
      return "Siap";
    case "galat":
      return "Galat";
    default:
      return "Belum diperiksa";
  }
}
