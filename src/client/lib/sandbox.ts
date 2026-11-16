import type { SandboxConfigItem, SandboxMode, SandboxPatch, SandboxState } from "./api";

export const SANDBOX_MAX_LIST_ENTRIES = 100;
export const SANDBOX_MAX_ENTRY_PREVIEW = 40;

const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export type SandboxBadge = { label: string; title: string; tone: "warn" };

/** Lencana header hanya untuk sesi yang berjalan tanpa sandbox. */
export function sandboxBadge(
  session: { sandbox?: SandboxMode },
): SandboxBadge | undefined {
  if (session.sandbox !== "mati") return undefined;
  return {
    label: "Tanpa sandbox",
    title: "Bash agent berjalan tanpa batas berkas dan jaringan dari sandbox. Lihat Log audit.",
    tone: "warn",
  };
}

function previewOf(entry: string): string {
  return entry.length > SANDBOX_MAX_ENTRY_PREVIEW
    ? `${entry.slice(0, SANDBOX_MAX_ENTRY_PREVIEW)}…`
    : entry;
}

function splitEntries(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function uniqueEntries(entries: string[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function checkCommon(value: string, label: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return `${label} "${previewOf(value)}" tidak boleh memuat karakter kontrol.`;
  }
  return undefined;
}

function domainError(entry: string): string | undefined {
  const common = checkCommon(entry, "Domain");
  if (common !== undefined) return common;
  if (!DOMAIN_PATTERN.test(entry)) {
    return `Domain "${previewOf(entry)}" tidak valid; pakai huruf kecil tanpa skema, jalur, atau port.`;
  }
  return undefined;
}

function pathError(entry: string): string | undefined {
  const common = checkCommon(entry, "Jalur");
  if (common !== undefined) return common;
  if (!entry.startsWith("/") && !entry.startsWith("~/")) {
    return `Jalur "${previewOf(entry)}" harus absolut atau diawali ~/.`;
  }
  if (entry.split("/").includes("..")) {
    return `Jalur "${previewOf(entry)}" tidak boleh memuat segmen ...`;
  }
  return undefined;
}

function normalize(entry: string, kind: "domain" | "path"): string {
  return kind === "domain" ? entry.toLowerCase() : entry;
}

/**
 * Pisah input baris/koma menjadi daftar unik; domain di-lowercase.
 * Galat menyebut entri pertama yang bermasalah (dipotong 40 karakter).
 */
export function parseListInput(
  text: string,
  kind: "domain" | "path",
): { values?: string[]; error?: string } {
  const entries = uniqueEntries(splitEntries(text).map((entry) => normalize(entry, kind)));
  if (entries.length > SANDBOX_MAX_LIST_ENTRIES) {
    return { error: `Maksimal ${SANDBOX_MAX_LIST_ENTRIES} entri.` };
  }
  for (const entry of entries) {
    const error = kind === "domain" ? domainError(entry) : pathError(entry);
    if (error !== undefined) return { error };
  }
  return { values: entries };
}

/** Satu nilai per baris untuk textarea. */
export function listToText(values: string[]): string {
  return values.join("\n");
}

export function sandboxStatusLine(state: SandboxState): string {
  if (state.config.mode === "mati") return "Sandbox mati secara global";
  if (!state.available.ok) {
    return `Sandbox belum tersedia di mesin ini: ${state.available.detail}`;
  }
  return `Sandbox standar · ${state.available.detail}`;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export interface SandboxForm {
  mode: SandboxMode;
  domains: string;
  denyRead: string;
  denyWrite: string;
  allowWrite: string;
  allowUnixSockets: string;
  allowLocalBinding: boolean;
}

/**
 * Tombol Simpan aktif juga saat input tidak valid, supaya galat bisa tampil.
 * Saat menyimpan atau tanpa perubahan (patch kosong) tombol nonaktif.
 */
export function canSubmit(
  result: { patch?: SandboxPatch; error?: string },
  saving: boolean,
): boolean {
  if (saving) return false;
  if (result.error !== undefined) return true;
  return result.patch !== undefined && Object.keys(result.patch).length > 0;
}

/** Patch hanya field yang berubah; `{}` bila tidak ada perubahan. */
export function sandboxPatchFrom(
  form: SandboxForm,
  current: SandboxConfigItem,
): { patch?: SandboxPatch; error?: string } {
  const domains = parseListInput(form.domains, "domain");
  if (domains.error !== undefined) return { error: domains.error };
  const denyRead = parseListInput(form.denyRead, "path");
  if (denyRead.error !== undefined) return { error: denyRead.error };
  const denyWrite = parseListInput(form.denyWrite, "path");
  if (denyWrite.error !== undefined) return { error: denyWrite.error };
  const allowWrite = parseListInput(form.allowWrite, "path");
  if (allowWrite.error !== undefined) return { error: allowWrite.error };
  const allowUnixSockets = parseListInput(form.allowUnixSockets, "path");
  if (allowUnixSockets.error !== undefined) return { error: allowUnixSockets.error };

  const patch: SandboxPatch = {};
  if (form.mode !== current.mode) patch.mode = form.mode;
  if (!sameList(domains.values ?? [], current.allowedDomains)) {
    patch.allowedDomains = domains.values ?? [];
  }
  if (!sameList(denyRead.values ?? [], current.extraDenyRead)) {
    patch.extraDenyRead = denyRead.values ?? [];
  }
  if (!sameList(denyWrite.values ?? [], current.extraDenyWrite)) {
    patch.extraDenyWrite = denyWrite.values ?? [];
  }
  if (!sameList(allowWrite.values ?? [], current.extraAllowWrite)) {
    patch.extraAllowWrite = allowWrite.values ?? [];
  }
  if (!sameList(allowUnixSockets.values ?? [], current.extraAllowUnixSockets)) {
    patch.extraAllowUnixSockets = allowUnixSockets.values ?? [];
  }
  if (form.allowLocalBinding !== current.allowLocalBinding) {
    patch.allowLocalBinding = form.allowLocalBinding;
  }
  return { patch };
}
