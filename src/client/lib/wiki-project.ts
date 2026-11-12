/**
 * Pemilihan proyek wiki secara manual: daftar penyedia GitLab, daftar repo,
 * dan penyimpanan pilihan proyek per folder. Semua fungsi di berkas ini
 * murni; akses localStorage dilakukan tipis di komponen.
 */

/** Penyedia GitLab yang bisa dipilih manual. */
export interface WikiProviderOption {
  id: string;
  name: string;
}

/** Repo penyedia yang bisa dipilih manual. */
export interface WikiRepo {
  name: string;
  fullPath: string;
}

/** Pilihan proyek tersimpan untuk satu folder. */
export interface StoredWikiProject {
  providerId: string;
  fullPath: string;
}

/** Kunci localStorage untuk peta pilihan proyek per folder. */
export const WIKI_PROJECT_STORAGE_KEY = "jejak.wiki.project.v1";

/** Batas jumlah folder yang boleh menyimpan pilihan proyek. */
export const WIKI_PROJECT_MAX_ENTRIES = 50;

/** Batas jumlah repo yang ditampilkan sekaligus. */
export const WIKI_REPO_LIMIT = 50;

/** Bentuk entri pilihan proyek yang sah. */
function isStoredProject(value: unknown): value is StoredWikiProject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const providerId = record["providerId"];
  const fullPath = record["fullPath"];
  return (
    typeof providerId === "string" &&
    providerId.trim() !== "" &&
    typeof fullPath === "string" &&
    fullPath.trim() !== ""
  );
}

/**
 * Baca pilihan proyek tersimpan untuk satu folder. Isi rusak atau bentuk
 * salah dianggap sebagai tidak ada pilihan.
 */
export function readStoredProject(
  raw: string | null | undefined,
  cwd: string,
): StoredWikiProject | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[cwd];
  if (!isStoredProject(entry)) return undefined;
  return { providerId: entry.providerId.trim(), fullPath: entry.fullPath.trim() };
}

/**
 * Susun JSON baru berisi peta pilihan proyek per folder. Proyek `undefined`
 * menghapus entri folder itu. Entri paling lama dibuang bila jumlah folder
 * melebihi batas; folder yang sedang aktif tidak pernah dibuang.
 */
export function writeStoredProject(
  raw: string | null | undefined,
  cwd: string,
  project: StoredWikiProject | undefined,
): string {
  const map = new Map<string, StoredWikiProject>();
  if (raw !== null && raw !== undefined && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isStoredProject(value)) {
            map.set(key, { providerId: value.providerId, fullPath: value.fullPath });
          }
        }
      }
    } catch {
      // Isi rusak diabaikan; peta baru dibangun dari nol.
    }
  }

  if (project === undefined) map.delete(cwd);
  else map.set(cwd, { providerId: project.providerId, fullPath: project.fullPath });

  const entries = [...map.entries()];
  while (entries.length > WIKI_PROJECT_MAX_ENTRIES) {
    const index = entries.findIndex(([key]) => key !== cwd);
    if (index < 0) break;
    entries.splice(index, 1);
  }
  return JSON.stringify(Object.fromEntries(entries));
}

/** Penyedia gitlab saja; jenis lain tidak bisa jadi sumber wiki. */
export function gitlabProviders(
  providers: readonly { id: string; name: string; kind: string }[],
): WikiProviderOption[] {
  return providers
    .filter((provider) => provider.kind === "gitlab")
    .map((provider) => ({ id: provider.id, name: provider.name }));
}

/** Repo yang.fullPath-nya mengandung kata saringan; huruf besar diabaikan. */
export function matchRepos<T extends { fullPath: string }>(
  repos: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...repos];
  return repos.filter((repo) => repo.fullPath.toLowerCase().includes(needle));
}

/** Repo hasil saringan, dibatasi jumlah yang ditampilkan. */
export function filterRepos<T extends { fullPath: string }>(
  repos: readonly T[],
  query: string,
  limit: number = WIKI_REPO_LIMIT,
): T[] {
  return matchRepos(repos, query).slice(0, Math.max(0, limit));
}

/** Pesan galat saat pilihan proyek tersimpan tidak dapat dipakai lagi. */
export function storedProjectErrorMessage(status: number, message?: string): string {
  const text = message?.trim();
  if (text !== undefined && text !== "") {
    return `Pilihan proyek tersimpan gagal dipakai: ${text}`;
  }
  if (status === 404) {
    return "Pilihan proyek tersimpan gagal dipakai: proyek atau penyedia tidak ditemukan.";
  }
  return "Pilihan proyek tersimpan gagal dipakai.";
}
