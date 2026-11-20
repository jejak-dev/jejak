import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, type ApiClient, type ConnectionTestView } from "../lib/api";
import { parseRegistryView, type RegistryView } from "../lib/registry-view";
import {
  addProfile,
  blockingDraftErrors,
  draftAfterRemoval,
  fallbackName,
  fallbackOptions,
  isDirty,
  isUnsavedProfile,
  newProfileDraft,
  toDraft,
  toPayload,
  updateProfile,
  validateDraft,
  type ProfileDraft,
  type RegistryDraft,
} from "../lib/registry-edit";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProfileForm } from "./ProfileForm";

export interface ProviderSettingsProps {
  api: ApiClient;
  onSaved: () => void | Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    if (error.message !== "") return error.message;
  }
  return "terjadi kesalahan";
}

function pickSelection(draft: RegistryDraft, current: string | undefined): string | undefined {
  if (current !== undefined && draft.profiles.some((profile) => profile.id === current)) {
    return current;
  }
  return draft.activeProfileId ?? draft.profiles[0]?.id;
}

/** Nama profil untuk ditampilkan; profil tanpa nama memakai ID-nya. */
function providerName(profile: ProfileDraft): string {
  return profile.name.trim() === "" ? profile.id : profile.name;
}

export function ProviderSettings({ api, onSaved }: ProviderSettingsProps) {
  const [view, setView] = useState<RegistryView | undefined>(undefined);
  const [original, setOriginal] = useState<RegistryDraft | undefined>(undefined);
  const [draft, setDraft] = useState<RegistryDraft | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [activeError, setActiveError] = useState<string | undefined>(undefined);
  const [testError, setTestError] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<ConnectionTestView | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | undefined>(undefined);
  const [pendingRemove, setPendingRemove] = useState<ProfileDraft | undefined>(undefined);
  const [removeNote, setRemoveNote] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const payload = await api.getProviders();
      const nextView = parseRegistryView(payload);
      const nextDraft = toDraft(nextView);
      setView(nextView);
      setOriginal(nextDraft);
      setDraft(nextDraft);
      setSelectedId((current) => pickSelection(nextDraft, current));
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const applySavedView = useCallback((payload: unknown): void => {
    const nextView = parseRegistryView(payload);
    const nextDraft = toDraft(nextView);
    setView(nextView);
    setOriginal(nextDraft);
    setDraft(nextDraft);
    setSelectedId((current) => pickSelection(nextDraft, current));
  }, []);

  const dirty = original !== undefined && draft !== undefined && isDirty(original, draft);
  const errors = draft !== undefined ? validateDraft(draft) : {};
  const hasError = Object.keys(errors).length > 0;

  const closeTransient = (): void => {
    setSaveError(undefined);
    setActiveError(undefined);
    setTestError(undefined);
    setTestResult(undefined);
  };

  const save = useCallback(async (target: RegistryDraft | undefined = draft): Promise<boolean> => {
    if (target === undefined) return false;
    setSaving(true);
    setSaveError(undefined);
    setTestError(undefined);
    try {
      const payload = await api.saveProviders(toPayload(target));
      // Draf dimuat ulang dari respons; key literal tidak pernah ditampilkan lagi.
      applySavedView(payload);
      setRemoveNote(undefined);
      await onSaved();
      return true;
    } catch (error) {
      setSaveError(messageOf(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, applySavedView, draft, onSaved]);

  const loadModels = useCallback(
    async (profileId: string): Promise<void> => {
      setLoadingModels(true);
      setModelsNote(undefined);
      try {
        const result = await api.listProviderModels(profileId);
        if (!result.ok) {
          setModelsNote(`Gagal memuat model: ${result.error ?? "tidak diketahui"}`);
          return;
        }
        if (result.models.length === 0) {
          setModelsNote("Provider tidak mengembalikan model.");
          return;
        }
        const windows = result.contextWindows ?? {};
        setDraft((current) => {
          if (current === undefined) return current;
          const profile = current.profiles.find((candidate) => candidate.id === profileId);
          // Jendela yang sudah diisi pengguna tidak ditimpa.
          const modelWindows = { ...(profile?.modelWindows ?? {}) };
          for (const [id, value] of Object.entries(windows)) {
            if ((modelWindows[id] ?? "").trim() === "") modelWindows[id] = String(value);
          }
          return updateProfile(current, profileId, { modelsText: result.models.join("\n"), modelWindows });
        });
        const filled = Object.keys(windows).length;
        setModelsNote(
          `${result.models.length} model dimuat${filled > 0 ? `, ${filled} dengan jendela konteks` : ""}. Simpan untuk menerapkan.`,
        );
      } catch (error) {
        setModelsNote(`Gagal memuat model: ${messageOf(error)}`);
      } finally {
        setLoadingModels(false);
      }
    },
    [api],
  );

  const onSave = (): void => {
    if (!dirty || hasError) return;
    closeTransient();
    const target = draft?.profiles.find((profile) => profile.id === selectedId);
    const autoLoad = target !== undefined && target.modelsText.trim() === "";
    void (async () => {
      const saved = await save();
      // Profil baru tanpa daftar model: muat otomatis dari provider.
      if (saved && autoLoad && target !== undefined) await loadModels(target.id);
    })();
  };

  const onLoadModels = (profile: ProfileDraft): void => {
    if (loadingModels || saving) return;
    closeTransient();
    void (async () => {
      if (dirty) {
        if (hasError) {
          setModelsNote("Perbaiki isian yang belum valid sebelum memuat model.");
          return;
        }
        if (!(await save())) return;
      }
      await loadModels(profile.id);
    })();
  };

  const onActivate = (profile: ProfileDraft): void => {
    if (draft === undefined || activating) return;
    setActivating(true);
    setActiveError(undefined);
    setTestError(undefined);
    setTestResult(undefined);
    setRemoveNote(undefined);
    void (async () => {
      try {
        const payload = await api.setActiveProvider(profile.id);
        const nextView = parseRegistryView(payload);
        setView(nextView);
        setDraft((current) =>
          current === undefined
            ? toDraft(nextView)
            : { ...current, activeProfileId: profile.id },
        );
        setOriginal((current) =>
          current === undefined ? toDraft(nextView) : { ...current, activeProfileId: profile.id },
        );
        await onSaved();
      } catch (error) {
        setActiveError(messageOf(error));
      } finally {
        setActivating(false);
      }
    })();
  };

  const onRemove = (profile: ProfileDraft): void => {
    if (draft === undefined) return;
    // Profil baru yang belum pernah tersimpan: buang dari draf tanpa modal dan tanpa simpan.
    if (isUnsavedProfile(original, profile)) {
      const next = draftAfterRemoval(draft, profile.id);
      setDraft(next);
      setSelectedId(pickSelection(next, undefined));
      setRemoveNote(undefined);
      closeTransient();
      return;
    }
    // Penghapusan diminta lewat modal; baru diterapkan setelah konfirmasi.
    setPendingRemove(profile);
  };

  const onConfirmRemove = (): void => {
    if (draft === undefined || pendingRemove === undefined) return;
    const next = draftAfterRemoval(draft, pendingRemove.id);
    setPendingRemove(undefined);
    setDraft(next);
    setSelectedId(pickSelection(next, undefined));
    closeTransient();
    const blocking = blockingDraftErrors(next);
    if (blocking.length > 0) {
      // Draf tetap berisi penghapusan; user bisa memperbaiki lalu menyimpan.
      setSaveError(`Perbaiki isian berikut sebelum menyimpan: ${blocking.join(" ")}`);
      return;
    }
    void (async () => {
      // Penghapusan langsung tersimpan; tidak perlu tombol Simpan perubahan.
      const saved = await save(next);
      if (saved) setRemoveNote("Provider dihapus.");
    })();
  };

  const onAdd = (): void => {
    if (draft === undefined) return;
    const profile = newProfileDraft(
      draft.profiles.map((entry) => entry.id),
      draft.profiles.map((entry) => entry.name),
    );
    const next = addProfile(draft, profile);
    setDraft(next);
    setSelectedId(profile.id);
    setModelsNote(undefined);
    setRemoveNote(undefined);
    closeTransient();
  };

  const onTest = (profile: ProfileDraft): void => {
    if (draft === undefined || testing) return;
    if (dirty && hasError) {
      setTestError("Perbaiki isian yang belum valid sebelum menguji koneksi.");
      return;
    }
    setTesting(true);
    setTestError(undefined);
    setTestResult(undefined);
    void (async () => {
      try {
        let saved = !dirty;
        if (dirty) {
          saved = await save();
        }
        if (!saved) return;
        const result = await api.testProvider({ profileId: profile.id });
        setTestResult(result);
      } catch (error) {
        setTestError(messageOf(error));
      } finally {
        setTesting(false);
      }
    })();
  };

  const selected = draft?.profiles.find((profile) => profile.id === selectedId) ?? undefined;
  const selectedHasStoredKey =
    selected !== undefined &&
    (view?.profiles.find((profile) => profile.id === selected.id)?.hasKey ?? false);

  return (
    <section class="jk-settings-content" aria-labelledby="jk-settings-title">
      <header class="jk-settings-head">
        <h2 id="jk-settings-title" class="jk-settings-title">
          Provider
        </h2>
        <p class="jk-privacy-note">
          Isi folder kerja, percakapan, dan hasil tool dikirim ke penyedia pada base URL profil
          yang dipakai sesi. Pilih penyedia yang sesuai kebijakan data kamu.
        </p>
      </header>

      {loading && <p class="jk-note">Memuat provider…</p>}

      {loadError !== undefined && (
        <p class="jk-error-line" role="alert">
          {loadError}
        </p>
      )}

      {!loading && loadError === undefined && draft !== undefined && (
        <div class="jk-settings-body">
          <div class="jk-profile-list-pane">
            <h3 class="jk-profile-list-title">Profil</h3>
            <ul class="jk-profile-list">
              {draft.profiles.map((profile) => {
                const active = draft.activeProfileId === profile.id;
                const current = profile.id === selectedId;
                const fallback = fallbackName(draft, profile);
                return (
                  <li key={profile.id}>
                    <button
                      type="button"
                      class={`jk-profile-item${current ? " jk-profile-item-current" : ""}`}
                      onClick={() => {
                        setSelectedId(profile.id);
                        closeTransient();
                      }}
                      aria-current={current ? "true" : undefined}
                    >
                      <span class="jk-profile-item-name">{profile.name || profile.id}</span>
                      {active && <span class="jk-badge jk-badge-accent">aktif</span>}
                      <span class="jk-profile-item-id jk-mono">{profile.id}</span>
                      {fallback !== undefined && (
                        <span class="jk-help jk-profile-item-fallback">cadangan: {fallback}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {draft.profiles.length === 0 && (
              <p class="jk-note">{errors._?.[0] ?? "Belum ada profil."}</p>
            )}

            <button type="button" class="jk-button jk-button-secondary" onClick={onAdd}>
              Tambah provider
            </button>
          </div>

          <div class="jk-profile-form-pane">
            {removeNote !== undefined && (
              <p class="jk-note" role="status">
                {removeNote}
              </p>
            )}

            {saveError !== undefined && (
              <p class="jk-error-line" role="alert">
                {saveError}
              </p>
            )}
            {activeError !== undefined && (
              <p class="jk-error-line" role="alert">
                {activeError}
              </p>
            )}

            {selected !== undefined ? (
              <ProfileForm
                profile={selected}
                hasStoredKey={selectedHasStoredKey}
                activeProfileId={draft.activeProfileId}
                fallbackOptions={fallbackOptions(draft, selected.id)}
                errors={errors[selected.id] ?? []}
                dirty={dirty}
                valid={!hasError}
                saving={saving}
                testing={testing}
                activating={activating}
                testResult={testResult}
                testError={testError}
                onChange={(patch) => {
                  setRemoveNote(undefined);
                  if (patch.id === undefined) {
                    setDraft((current) => updateProfile(current!, selected.id, patch));
                    return;
                  }
                  const previousId = selected.id;
                  const nextId = patch.id;
                  setDraft((current) => {
                    if (current === undefined) return current;
                    const updated = updateProfile(current, previousId, patch);
                    return current.activeProfileId === previousId
                      ? { ...updated, activeProfileId: nextId }
                      : updated;
                  });
                  setSelectedId(nextId);
                  setTestResult(undefined);
                  setTestError(undefined);
                }}
                onSave={onSave}
                onActivate={() => onActivate(selected)}
                onRemove={() => onRemove(selected)}
                onTest={() => onTest(selected)}
                loadingModels={loadingModels}
                modelsNote={modelsNote}
                onLoadModels={() => onLoadModels(selected)}
              />
            ) : (
              <p class="jk-note">Pilih profil di kiri atau tambah profil baru.</p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove !== undefined}
        title="Hapus provider?"
        message={
          pendingRemove === undefined
            ? undefined
            : `Provider ${providerName(pendingRemove)} akan dihapus dan perubahan langsung disimpan.`
        }
        confirmLabel="Hapus"
        tone="danger"
        onConfirm={onConfirmRemove}
        onCancel={() => setPendingRemove(undefined)}
      />
    </section>
  );
}
