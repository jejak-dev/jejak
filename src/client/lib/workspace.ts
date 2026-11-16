import type { ServiceCardItem, ServiceKind, WorkspaceItem } from "./api";
import { folderName, shortPath } from "./format";

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

export interface WorkspaceRepoOption {
  value: string;
  label: string;
  missing: boolean;
  primary: boolean;
}

/** Opsi repo untuk pemilih di dialog sesi baru; repo pertama adalah repo utama. */
export function workspaceRepoOptions(workspace: WorkspaceItem): WorkspaceRepoOption[] {
  return workspace.repos.map((repo, index) => ({
    value: repo.path,
    label: repo.missing ? `${repo.name} (hilang)` : repo.name,
    missing: repo.missing,
    primary: index === 0,
  }));
}

/** Path repo utama yang masih ada; undefined bila repo utama hilang atau daftar kosong. */
export function defaultRepoPath(workspace: WorkspaceItem): string | undefined {
  const primary = workspaceRepoOptions(workspace).find((repo) => repo.primary);
  if (primary === undefined || primary.missing) return undefined;
  return primary.value;
}

export interface SessionRepo {
  name: string;
  primary: boolean;
  missing: boolean;
}

export interface PanelRepoOption {
  value: string;
  label: string;
  missing: boolean;
}

/** Daftar repo untuk pilihan; repo utama diberi label "(utama)". */
export function panelRepoOptions(repos: readonly SessionRepo[]): PanelRepoOption[] {
  return repos.map((repo) => ({
    value: repo.name,
    label: repo.primary ? `${repo.name} (utama)` : repo.name,
    missing: repo.missing,
  }));
}

/** Nama repo yang efektif dipakai: pilihan bila masih ada dan tidak hilang, selain itu repo utama. */
export function effectivePanelRepo(
  repos: readonly SessionRepo[],
  selected: string | undefined,
): string | undefined {
  const chosen = repos.find((repo) => repo.name === selected && !repo.missing);
  if (chosen !== undefined) return chosen.name;
  return repos.find((repo) => repo.primary)?.name;
}

/**
 * Nilai `repo` untuk permintaan API: undefined bila efektifnya repo utama
 * (perilaku lama), selain itu nama repo.
 */
export function repoForRequest(
  repos: readonly SessionRepo[],
  selected: string | undefined,
): string | undefined {
  const effective = effectivePanelRepo(repos, selected);
  if (effective === undefined) return undefined;
  const repo = repos.find((item) => item.name === effective);
  return repo?.primary ? undefined : effective;
}

/**
 * Catatan tab Titik untuk sesi ber-workspace; undefined bila tanpa workspace.
 * Titik tidak ikut pemilih repo pada irisan ini.
 */
export function checkpointRepoNote(
  repos: readonly SessionRepo[] | undefined,
): string | undefined {
  if (repos === undefined) return undefined;
  const primary = repos.find((repo) => repo.primary);
  return primary === undefined
    ? "Titik hanya untuk repo utama sesi."
    : `Titik hanya untuk repo utama sesi (${primary.name}).`;
}

/**
 * Subjudul header sesi: nama folder terakhir cwd bila tanpa workspace, dan
 * "<nama workspace> · <folder terakhir cwd>" bila ada workspace.
 */
export function sessionSubtitle(input: {
  workspaceName?: string;
  cwd?: string;
}): string {
  if (input.workspaceName !== undefined && input.workspaceName !== "") {
    return sessionContextLabel(input);
  }
  const cwd = input.cwd ?? "";
  if (cwd === "") return "";
  return folderName(cwd);
}

/** "<nama workspace> · <folder terakhir cwd>", atau path cwd seperti biasa tanpa workspace. */
export function sessionContextLabel(input: {
  workspaceName?: string;
  cwd?: string;
}): string {
  const cwd = input.cwd ?? "";
  if (input.workspaceName === undefined || input.workspaceName === "") {
    return shortPath(cwd);
  }
  const folder = cwd === "" ? "" : shortPath(folderName(cwd));
  if (folder === "") return input.workspaceName;
  return `${input.workspaceName} · ${folder}`;
}
