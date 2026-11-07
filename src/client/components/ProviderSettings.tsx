import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, type ApiClient, type ConnectionTestView } from "../lib/api";
import { parseRegistryView, type RegistryView } from "../lib/registry-view";
import {
  addProfile,
  isDirty,
  newProfileDraft,
  removeProfile,
  toDraft,
  toPayload,
  updateProfile,
  validateDraft,
  type ProfileDraft,
  type RegistryDraft,
} from "../lib/registry-edit";
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

  const save = useCallback(async (): Promise<boolean> => {
    if (draft === undefined) return false;
    setSaving(true);
    setSaveError(undefined);
    setTestError(undefined);
    try {
      const payload = await api.saveProviders(toPayload(draft));
      // Draf dimuat ulang dari respons; key literal tidak pernah ditampilkan lagi.
      applySavedView(payload);
      await onSaved();
      return true;
    } catch (error) {
      setSaveError(messageOf(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, applySavedView, draft, onSaved]);

  const onSave = (): void => {
    if (!dirty || hasError) return;
    closeTransient();
    void save();
  };

  const onActivate = (profile: ProfileDraft): void => {
    if (draft === undefined || activating) return;
    setActivating(true);
    setActiveError(undefined);
    setTestError(undefined);
    setTestResult(undefined);
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
    if (!window.confirm(`Hapus profil ${profile.name}?`)) return;
    const next = removeProfile(draft, profile.id);
    setDraft(next);
    setSelectedId(pickSelection(next, undefined));
    closeTransient();
  };

  const onAdd = (): void => {
    if (draft === undefined) return;
    const profile = newProfileDraft(draft.profiles.map((entry) => entry.id));
    const next = addProfile(draft, profile);
    setDraft(next);
    setSelectedId(profile.id);
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
    <section class="jk-settings" aria-labelledby="jk-settings-title">
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
                    </button>
                  </li>
                );
              })}
            </ul>

            {draft.profiles.length === 0 && (
              <p class="jk-note">{errors._?.[0] ?? "Belum ada profil."}</p>
            )}

            <button type="button" class="jk-button jk-button-secondary" onClick={onAdd}>
              Tambah profil
            </button>
          </div>

          <div class="jk-profile-form-pane">
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
                errors={errors[selected.id] ?? []}
                dirty={dirty}
                valid={!hasError}
                saving={saving}
                testing={testing}
                activating={activating}
                testResult={testResult}
                testError={testError}
                onChange={(patch) => {
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
              />
            ) : (
              <p class="jk-note">Pilih profil di kiri atau tambah profil baru.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
