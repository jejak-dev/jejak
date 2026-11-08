import type { ServiceCardItem, ServiceKind } from "./api";

/**
 * Batas yang sama dengan server (`src/server/workspaces/workspace-files.ts`
 * dan `workspace-service.ts`). Disalin agar bundel klien tidak menarik modul
 * server (node:fs, node:crypto).
 */
export const WORKSPACE_NAME_MAX = 80;
export const WORKSPACE_REPOS_MAX = 20;
export const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const CARD_DESCRIPTION_MAX = 1000;
export const CARD_LIST_MAX = 100;
export const CARD_ENTRY_MAX = 120;

export const KIND_OPTIONS: { id: ServiceKind; label: string }[] = [
  { id: "backend", label: "Backend" },
  { id: "frontend", label: "Frontend" },
  { id: "worker", label: "Worker" },
  { id: "library", label: "Library" },
  { id: "lainnya", label: "Lainnya" },
];

export function kindLabel(kind: ServiceKind): string {
  return KIND_OPTIONS.find((option) => option.id === kind)?.label ?? "Lainnya";
}

/** Folder terakhir dijadikan nama repo pendek yang sah. */
export function repoNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  const last = segments[segments.length - 1] ?? "";
  const normalized = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40)
    .replace(/[^a-z0-9]+$/, "");
  return normalized === "" ? "repo" : normalized;
}

export function linesToList(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
  }
  return items;
}

export function listToLines(list: readonly string[]): string {
  return list.join("\n");
}

export interface WorkspaceRepoDraft {
  name: string;
  path: string;
}

export interface WorkspaceDraft {
  name: string;
  repos: WorkspaceRepoDraft[];
}

export function validateWorkspaceDraft(draft: WorkspaceDraft): string | undefined {
  const name = draft.name.trim();
  if (name === "" || name.length > WORKSPACE_NAME_MAX) {
    return `Nama workspace harus 1-${WORKSPACE_NAME_MAX} karakter.`;
  }
  if (draft.repos.length > WORKSPACE_REPOS_MAX) {
    return `Maks ${WORKSPACE_REPOS_MAX} repo per workspace.`;
  }
  const names = new Set<string>();
  for (const repo of draft.repos) {
    const repoName = repo.name.trim();
    if (!REPO_NAME_PATTERN.test(repoName)) {
      return "Nama repo harus huruf kecil, angka, titik, garis bawah, atau strip (maks 40).";
    }
    if (names.has(repoName)) {
      return `Nama repo "${repoName}" duplikat dalam workspace.`;
    }
    names.add(repoName);
    const path = repo.path.trim();
    if (path === "") {
      return `Path repo "${repoName}" wajib diisi.`;
    }
    if (!path.startsWith("/")) {
      return `Path repo "${repoName}" harus path absolut.`;
    }
  }
  return undefined;
}

export interface CardDraft {
  description: string;
  tables: string;
  queues: string;
  calls: string;
}

export function validateCardDraft(draft: CardDraft): string | undefined {
  if (draft.description.trim().length > CARD_DESCRIPTION_MAX) {
    return `Deskripsi maks ${CARD_DESCRIPTION_MAX} karakter.`;
  }
  const lists: [string, string][] = [
    ["Tabel", draft.tables],
    ["Queue", draft.queues],
    ["Memanggil", draft.calls],
  ];
  for (const [label, text] of lists) {
    const entries = linesToList(text);
    if (entries.length > CARD_LIST_MAX) {
      return `${label} maks ${CARD_LIST_MAX} entri.`;
    }
    const tooLong = entries.some((entry) => entry.length > CARD_ENTRY_MAX);
    if (tooLong) {
      return `Tiap entri ${label.toLowerCase()} maks ${CARD_ENTRY_MAX} karakter.`;
    }
  }
  return undefined;
}

/** Ringkasan singkat isi kartu untuk baris repo. */
export function cardSummary(card: ServiceCardItem): string {
  const parts: string[] = [];
  const hasContent =
    card.description.trim() !== "" ||
    card.tables.length > 0 ||
    card.queues.length > 0 ||
    card.calls.length > 0 ||
    card.kind !== "lainnya";
  if (!hasContent) return "Belum diisi";
  parts.push(kindLabel(card.kind));
  if (card.tables.length > 0) parts.push(`${card.tables.length} tabel`);
  if (card.queues.length > 0) parts.push(`${card.queues.length} queue`);
  if (card.calls.length > 0) parts.push(`${card.calls.length} panggilan`);
  return parts.join(" · ");
}
