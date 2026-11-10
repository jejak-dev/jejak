import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type GitProviderItem,
  type IndexedRepoItem,
  type RemoteRepoItem,
} from "../lib/api";
import {
  INDEX_STALE_LABEL,
  emptyProviderForm,
  formFromProvider,
  indexedMeta,
  providerFormError,
  providerInputFrom,
  providerSummary,
  type ProviderForm,
} from "../lib/indexer";

const NOTE =
  "Membuat salinan dangkal hanya-baca di cache Jejak; repo aslinya tidak diubah. Token tetap di server dan tidak dikirim ke model. Hasil indeks diberi label mungkin tertinggal.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

export interface IndexerPanelProps {
  api: ApiClient;
}

export function IndexerPanel({ api }: IndexerPanelProps) {
  const [providers, setProviders] = useState<GitProviderItem[]>([]);
  const [indexed, setIndexed] = useState<IndexedRepoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  const [form, setForm] = useState<ProviderForm | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const [browsing, setBrowsing] = useState<string | undefined>();
  const [remote, setRemote] = useState<RemoteRepoItem[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | undefined>();
  const [busyKey, setBusyKey] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const reqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    reqRef.current += 1;
    const ticket = reqRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const [list, repos] = await Promise.all([api.listGitProviders(), api.listIndexedRepos()]);
      if (ticket !== reqRef.current) return;
      setProviders(list);
      setIndexed(repos);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== reqRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) setDisabled(true);
      else setError(errorMessage(caught));
    } finally {
      if (ticket === reqRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRemote = async (id: string): Promise<void> => {
    setBrowsing(id);
    setRemote([]);
    setRemoteError(undefined);
    setRemoteLoading(true);
    try {
      setRemote(await api.listProviderRepos(id));
    } catch (caught) {
      setRemoteError(errorMessage(caught));
    } finally {
      setRemoteLoading(false);
    }
  };

  const saveProvider = async (): Promise<void> => {
    if (form === undefined || saving) return;
    const problem = providerFormError(form);
    setFormError(problem);
    if (problem !== undefined) return;
    setSaving(true);
    try {
      await api.putGitProvider(form.id, providerInputFrom(form));
      setForm(undefined);
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const removeProvider = async (id: string): Promise<void> => {
    setActionError(undefined);
    try {
      await api.deleteGitProvider(id);
      setConfirmDelete(undefined);
      if (browsing === id) setBrowsing(undefined);
      await load();
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  };

  const indexOne = async (providerId: string, fullPath: string): Promise<void> => {
    if (busyKey !== undefined) return;
    setBusyKey(fullPath);
    setActionError(undefined);
    try {
      await api.indexRepo(providerId, fullPath);
      await load();
      await loadRemote(providerId);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(undefined);
    }
  };

  const removeIndexed = async (key: string): Promise<void> => {
    if (busyKey !== undefined) return;
    setBusyKey(key);
    setActionError(undefined);
    try {
      await api.deleteIndexedRepo(key);
      await load();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(undefined);
    }
  };

  if (disabled) return null;

  return (
    <section class="jk-indexer" aria-labelledby="jk-indexer-title">
      <header class="jk-settings-head">
        <h3 id="jk-indexer-title" class="jk-settings-title jk-indexer-title">
          Repo terindeks
        </h3>
        <p class="jk-privacy-note">{NOTE}</p>
      </header>

      {loading && (
        <p class="jk-note" role="status" aria-live="polite">
          Memuat…
        </p>
      )}
      {!loading && error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {!loading && error === undefined && (
        <>
          <div class="jk-workspace-head">
            <button
              type="button"
              class="jk-button"
              aria-expanded={form !== undefined}
              onClick={() => {
                setForm(form === undefined ? emptyProviderForm() : undefined);
                setFormError(undefined);
              }}
            >
              Tambah penyedia
            </button>
          </div>

          {form !== undefined && (
            <div class="jk-instruksi-new">
              <div class="jk-field-row">
                <div class="jk-field">
                  <label class="jk-label" for="jk-gp-id">
                    Id
                  </label>
                  <input
                    id="jk-gp-id"
                    class="jk-input jk-input-code"
                    value={form.id}
                    autoComplete="off"
                    placeholder="gitlab-kantor"
                    onInput={(event) => setForm({ ...form, id: event.currentTarget.value })}
                  />
                </div>
                <div class="jk-field">
                  <label class="jk-label" for="jk-gp-name">
                    Nama
                  </label>
                  <input
                    id="jk-gp-name"
                    class="jk-input"
                    value={form.name}
                    autoComplete="off"
                    onInput={(event) => setForm({ ...form, name: event.currentTarget.value })}
                  />
                </div>
                <div class="jk-field">
                  <label class="jk-label" for="jk-gp-kind">
                    Jenis
                  </label>
                  <select
                    id="jk-gp-kind"
                    class="jk-select"
                    value={form.kind}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        kind: event.currentTarget.value === "local" ? "local" : "gitlab",
                        token: "",
                        clearToken: false,
                      })
                    }
                  >
                    <option value="gitlab">GitLab</option>
                    <option value="local">Folder lokal</option>
                  </select>
                </div>
              </div>
              <div class="jk-field">
                <label class="jk-label" for="jk-gp-loc">
                  {form.kind === "gitlab" ? "Alamat GitLab (https)" : "Folder berisi repo (path absolut)"}
                </label>
                <input
                  id="jk-gp-loc"
                  class="jk-input jk-input-code"
                  value={form.location}
                  autoComplete="off"
                  placeholder={form.kind === "gitlab" ? "https://git.contoh.id" : "/Users/saya/proyek"}
                  onInput={(event) => setForm({ ...form, location: event.currentTarget.value })}
                />
              </div>
              {form.kind === "gitlab" && (
                <div class="jk-field">
                  <label class="jk-label" for="jk-gp-token">
                    Token baca (read_api, read_repository)
                  </label>
                  <input
                    id="jk-gp-token"
                    class="jk-input jk-input-code"
                    type="password"
                    value={form.token}
                    autoComplete="new-password"
                    placeholder="kosong = pertahankan yang tersimpan"
                    onInput={(event) => setForm({ ...form, token: event.currentTarget.value })}
                  />
                  <label class="jk-bypass-check">
                    <input
                      type="checkbox"
                      checked={form.clearToken}
                      onChange={(event) => setForm({ ...form, clearToken: event.currentTarget.checked })}
                    />
                    <span>Hapus token tersimpan</span>
                  </label>
                </div>
              )}
              {formError !== undefined && (
                <p class="jk-error-line" role="alert">
                  {formError}
                </p>
              )}
              <div class="jk-form-actions">
                <button
                  type="button"
                  class="jk-button jk-button-primary"
                  disabled={saving}
                  onClick={() => void saveProvider()}
                >
                  {saving ? "Menyimpan…" : "Simpan"}
                </button>
                <button type="button" class="jk-button" onClick={() => setForm(undefined)}>
                  Batal
                </button>
              </div>
            </div>
          )}

          {actionError !== undefined && (
            <p class="jk-error-line" role="alert">
              {actionError}
            </p>
          )}

          {providers.length === 0 ? (
            <p class="jk-note">Belum ada penyedia git.</p>
          ) : (
            <ul class="jk-instruksi-list">
              {providers.map((provider) => (
                <li class="jk-indexer-provider" key={provider.id}>
                  <div class="jk-instruksi-row">
                    <span class="jk-instruksi-name">{provider.name}</span>
                    <span class="jk-instruksi-desc" title={providerSummary(provider)}>
                      {providerSummary(provider)}
                    </span>
                    <button
                      type="button"
                      class="jk-link-btn"
                      onClick={() => void loadRemote(provider.id)}
                      aria-expanded={browsing === provider.id}
                    >
                      Lihat repo
                    </button>
                    <button
                      type="button"
                      class="jk-link-btn"
                      onClick={() => {
                        setForm(formFromProvider(provider));
                        setFormError(undefined);
                      }}
                    >
                      Ubah
                    </button>
                    {confirmDelete === provider.id ? (
                      <>
                        <button type="button" class="jk-link-btn" onClick={() => void removeProvider(provider.id)}>
                          Hapus penyedia
                        </button>
                        <button type="button" class="jk-link-btn" onClick={() => setConfirmDelete(undefined)}>
                          Batal
                        </button>
                      </>
                    ) : (
                      <button type="button" class="jk-link-btn" onClick={() => setConfirmDelete(provider.id)}>
                        Hapus
                      </button>
                    )}
                  </div>

                  {browsing === provider.id && (
                    <div class="jk-indexer-remote">
                      {remoteLoading && (
                        <p class="jk-note" role="status" aria-live="polite">
                          Memuat daftar repo…
                        </p>
                      )}
                      {remoteError !== undefined && (
                        <p class="jk-error-line" role="alert">
                          {remoteError}
                        </p>
                      )}
                      {!remoteLoading && remoteError === undefined && remote.length === 0 && (
                        <p class="jk-note">Tidak ada repo.</p>
                      )}
                      <ul class="jk-instruksi-list">
                        {remote.map((repo) => (
                          <li class="jk-instruksi-row" key={repo.fullPath}>
                            <span class="jk-instruksi-name">{repo.fullPath}</span>
                            <span class="jk-instruksi-desc">{repo.indexed ? "terindeks" : ""}</span>
                            <button
                              type="button"
                              class="jk-link-btn"
                              disabled={busyKey !== undefined}
                              onClick={() => void indexOne(provider.id, repo.fullPath)}
                            >
                              {busyKey === repo.fullPath
                                ? "Mengindeks…"
                                : repo.indexed
                                  ? "Segarkan"
                                  : "Indeks"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h4 class="jk-label jk-indexer-sub">Terindeks</h4>
          {indexed.length === 0 ? (
            <p class="jk-note">Belum ada repo yang diindeks.</p>
          ) : (
            <ul class="jk-instruksi-list">
              {indexed.map((repo) => (
                <li class="jk-instruksi-row" key={repo.key}>
                  <span class="jk-instruksi-name">{repo.fullPath}</span>
                  <span class="jk-instruksi-desc" title={indexedMeta(repo)}>
                    {indexedMeta(repo)}
                  </span>
                  <span class="jk-badge jk-badge-muted">{INDEX_STALE_LABEL}</span>
                  <button
                    type="button"
                    class="jk-link-btn"
                    disabled={busyKey !== undefined}
                    onClick={() => void removeIndexed(repo.key)}
                  >
                    {busyKey === repo.key ? "Menghapus…" : "Hapus"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
