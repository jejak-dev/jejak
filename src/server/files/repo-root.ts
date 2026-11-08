import { realpath } from "node:fs/promises";
import type { SessionInfo, WorkspaceResolver } from "../sessions/session-manager";
import { FileError } from "./path";

/** Bagian SessionInfo yang dibutuhkan pemilihan akar repo. */
export type RepoRootSession = Pick<SessionInfo, "cwd" | "workspaceId">;

const NO_WORKSPACE = "Sesi ini tidak punya workspace.";
const UNKNOWN_REPO = "Repo tidak ada di workspace.";
const MISSING_REPO = "Folder repo tidak ditemukan.";
const INVALID_REPO = "Parameter repo tidak valid.";

function invalid(message: string): FileError {
  return new FileError(message, "tidak-valid");
}

/**
 * Akar folder untuk panel berkas/perubahan.
 * Tanpa `repo` perilaku lama dipertahankan: cwd sesi apa adanya. Dengan `repo`,
 * nama dicari di workspace sesi dan yang dipakai selalu path dari workspace
 * (hasil realpath), tidak pernah nilai `repo` itu sendiri.
 */
export async function resolveRepoRoot(
  session: RepoRootSession,
  repoParam: unknown,
  resolver: WorkspaceResolver | undefined,
): Promise<string> {
  if (repoParam === undefined) {
    return session.cwd;
  }
  if (typeof repoParam !== "string" || repoParam === "") {
    throw invalid(INVALID_REPO);
  }

  const workspaceId = session.workspaceId;
  if (workspaceId === undefined || resolver === undefined) {
    throw invalid(NO_WORKSPACE);
  }

  let view;
  try {
    view = await resolver.get(workspaceId);
  } catch {
    view = undefined;
  }
  if (view === undefined) {
    throw invalid(NO_WORKSPACE);
  }

  const repo = view.repos.find((item) => item.name === repoParam);
  if (repo === undefined) {
    throw invalid(UNKNOWN_REPO);
  }
  if (repo.missing) {
    throw invalid(MISSING_REPO);
  }

  try {
    return await realpath(repo.path);
  } catch {
    throw invalid(MISSING_REPO);
  }
}

/**
 * Kunci snapshot undo untuk repo terpilih. Repo yang realpath-nya sama dengan
 * cwd dihitung sebagai cwd sehingga snapshot lama tetap satu jalur.
 */
export async function repoSnapshotName(
  session: RepoRootSession,
  repoParam: unknown,
  root: string,
): Promise<string | undefined> {
  if (typeof repoParam !== "string") return undefined;
  try {
    if ((await realpath(session.cwd)) === root) return undefined;
  } catch {
    // cwd tidak terbaca: perlakukan sebagai repo lain.
  }
  return repoParam;
}

/** Membaca field `repo` dari body yang belum/telah di-parse, tanpa melempar galat. */
export function repoFieldFromBody(body: unknown): unknown {
  let parsed: unknown = body;
  if (typeof body === "string") {
    if (body.trim() === "") return undefined;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as Record<string, unknown>).repo;
}
