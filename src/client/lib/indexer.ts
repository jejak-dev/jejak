import type { GitProviderInput, GitProviderItem, IndexedRepoItem } from "./api";
import { memoryDateLabel } from "./memory";

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ProviderForm {
  id: string;
  name: string;
  kind: "gitlab" | "local";
  /** GitLab: alamat dasar; lokal: folder. */
  location: string;
  /** Kosong = pertahankan token tersimpan. */
  token: string;
  clearToken: boolean;
}

export function emptyProviderForm(): ProviderForm {
  return { id: "", name: "", kind: "gitlab", location: "", token: "", clearToken: false };
}

/** Isi formulir dari penyedia yang ada (token dikosongkan: tidak pernah diterima dari server). */
export function formFromProvider(provider: GitProviderItem): ProviderForm {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    location: (provider.kind === "gitlab" ? provider.baseUrl : provider.root) ?? "",
    token: "",
    clearToken: false,
  };
}

/** Galat validasi sisi klien (server tetap memeriksa ulang). */
export function providerFormError(form: ProviderForm): string | undefined {
  if (!PROVIDER_ID_PATTERN.test(form.id)) return "Id: huruf kecil, angka, atau tanda hubung (maks 32).";
  if (form.name.trim() === "" || form.name.trim().length > 80) return "Nama 1-80 karakter.";
  if (form.location.trim() === "") return form.kind === "gitlab" ? "Isi alamat GitLab." : "Isi folder lokal.";
  if (form.kind === "local" && !form.location.trim().startsWith("/")) return "Folder lokal harus path absolut.";
  if (form.token !== "" && /\s/.test(form.token)) return "Token tidak boleh memuat spasi.";
  if (form.kind === "local" && (form.token !== "" || form.clearToken)) return "Penyedia lokal tidak memakai token.";
  return undefined;
}

export function providerInputFrom(form: ProviderForm): GitProviderInput {
  const input: GitProviderInput = { name: form.name.trim(), kind: form.kind };
  if (form.kind === "gitlab") input.baseUrl = form.location.trim();
  else input.root = form.location.trim();
  if (form.clearToken) input.token = "";
  else if (form.token !== "") input.token = form.token;
  return input;
}

export function providerSummary(provider: GitProviderItem): string {
  const where = (provider.kind === "gitlab" ? provider.baseUrl : provider.root) ?? "";
  const kind = provider.kind === "gitlab" ? "GitLab" : "Folder lokal";
  const token = provider.kind === "gitlab" ? (provider.hasToken ? " · token tersimpan" : " · tanpa token") : "";
  return `${kind} · ${where}${token}`;
}

/** Baris meta repo terindeks; selalu menyebut bahwa salinannya mungkin tertinggal. */
export function indexedMeta(repo: IndexedRepoItem): string {
  const date = memoryDateLabel(repo.indexedAt);
  const parts = [`commit ${repo.commit.slice(0, 7)}`, `${repo.files} berkas`];
  if (date !== "") parts.push(`diindeks ${date}`);
  return parts.join(" · ");
}

export const INDEX_STALE_LABEL = "Dari indeks (mungkin tertinggal)";
