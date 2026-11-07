import type { ConnectionTestView } from "../lib/api";
import { describeToolCalling } from "../lib/format";
import type { KeyMode, ProfileDraft } from "../lib/registry-edit";

export interface ProfileFormProps {
  profile: ProfileDraft;
  hasStoredKey: boolean;
  activeProfileId?: string;
  errors: string[];
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  testing: boolean;
  activating: boolean;
  testResult?: ConnectionTestView;
  testError?: string;
  onChange: (patch: Partial<ProfileDraft>) => void;
  onSave: () => void;
  onActivate: () => void;
  onRemove: () => void;
  onTest: () => void;
}

const KEY_OPTIONS: { value: KeyMode; label: string }[] = [
  { value: "env", label: "Dari variabel env" },
  { value: "literal", label: "Simpan di berkas ini" },
  { value: "none", label: "Tanpa key" },
];

const KEEP_OPTION: { value: KeyMode; label: string } = {
  value: "keep",
  label: "Pertahankan key tersimpan",
};

type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";

const PRICE_FIELDS: { key: PriceKey; label: string }[] = [
  { key: "input", label: "Masuk" },
  { key: "output", label: "Keluar" },
  { key: "cacheRead", label: "Cache baca" },
  { key: "cacheWrite", label: "Cache tulis" },
];

function splitModels(text: string): string[] {
  const models: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (id !== "" && !models.includes(id)) models.push(id);
  }
  return models;
}

function fieldOf(message: string): string {
  if (message.startsWith("ID ")) return "id";
  if (message.startsWith("Nama variabel env")) return "apiKeyEnv";
  if (message.startsWith("Nama ")) return "name";
  if (message.startsWith("Base URL")) return "baseUrl";
  if (message.startsWith("API key")) return "apiKey";
  if (message.startsWith("Model utama")) return "defaultModel";
  if (message.startsWith("Model ringan")) return "lightModel";
  if (message.startsWith("Tarif ")) return "prices";
  if (message.startsWith("Model ")) return "models";
  return "lain";
}

function describedBy(...ids: (string | undefined)[]): string | undefined {
  const joined = ids.filter((id): id is string => id !== undefined).join(" ");
  return joined === "" ? undefined : joined;
}

function FieldError({ id, messages }: { id: string; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <p class="jk-field-error" id={id}>
      {messages.join(" ")}
    </p>
  );
}

function ConnectionResult({ result }: { result: ConnectionTestView }) {
  const tone = result.ok ? "success" : "danger";
  const toolCalling = describeToolCalling(result.toolCalling);

  return (
    <div class={`jk-test-result jk-test-result-${tone}`} role="status">
      <p class="jk-test-meta">
        <span class={`jk-badge jk-badge-${tone}`}>{result.ok ? "ok" : "gagal"}</span>
        {result.status !== undefined && <span>Status HTTP: {result.status}</span>}
        <span>Latensi: {result.latencyMs} ms</span>
        {result.model !== undefined && <span>Model: {result.model}</span>}
      </p>
      <p class={`jk-test-tool jk-tone-${toolCalling.tone}`}>{toolCalling.label}</p>
      {result.error !== undefined && <p class="jk-test-error">{result.error}</p>}
    </div>
  );
}

export function ProfileForm({
  profile,
  hasStoredKey,
  activeProfileId,
  errors,
  dirty,
  valid,
  saving,
  testing,
  activating,
  testResult,
  testError,
  onChange,
  onSave,
  onActivate,
  onRemove,
  onTest,
}: ProfileFormProps) {
  const models = splitModels(profile.modelsText);
  const grouped = new Map<string, string[]>();
  for (const message of errors) {
    const key = fieldOf(message);
    const list = grouped.get(key) ?? [];
    list.push(message);
    grouped.set(key, list);
  }
  const messagesFor = (key: string): string[] => grouped.get(key) ?? [];
  const invalid = (key: string): boolean => messagesFor(key).length > 0;
  const errorId = (key: string): string | undefined =>
    invalid(key) ? `jk-pf-${key}-error` : undefined;

  const keyOptions = hasStoredKey ? [...KEY_OPTIONS, KEEP_OPTION] : KEY_OPTIONS;

  const busy = saving || testing || activating;
  const onSubmit = (event: Event): void => {
    event.preventDefault();
    onSave();
  };

  const updatePrice = (modelId: string, key: PriceKey, value: string): void => {
    const current = profile.modelPrices[modelId] ?? {
      input: "",
      output: "",
      cacheRead: "",
      cacheWrite: "",
    };
    onChange({ modelPrices: { ...profile.modelPrices, [modelId]: { ...current, [key]: value } } });
  };

  return (
    <form class="jk-profile-form" onSubmit={onSubmit} aria-busy={saving || testing}>
      <h3 class="jk-profile-form-title">{profile.name.trim() === "" ? "Profil" : profile.name}</h3>

      <div class="jk-field-row">
        <div class="jk-field">
          <label class="jk-label" for="jk-pf-id">
            ID
          </label>
          <input
            id="jk-pf-id"
            class="jk-input jk-input-code"
            type="text"
            value={profile.id}
            readOnly={!profile.isNew}
            autoComplete="off"
            onInput={(event) => onChange({ id: (event.currentTarget as HTMLInputElement).value })}
            aria-invalid={invalid("id")}
            aria-describedby={describedBy("jk-pf-id-help", errorId("id"))}
          />
          {!profile.isNew && (
            <p class="jk-help" id="jk-pf-id-help">
              ID tidak bisa diubah setelah profil tersimpan.
            </p>
          )}
          <FieldError id="jk-pf-id-error" messages={messagesFor("id")} />
        </div>

        <div class="jk-field">
          <label class="jk-label" for="jk-pf-name">
            Nama
          </label>
          <input
            id="jk-pf-name"
            class="jk-input"
            type="text"
            value={profile.name}
            autoComplete="off"
            onInput={(event) => onChange({ name: (event.currentTarget as HTMLInputElement).value })}
            aria-invalid={invalid("name")}
            aria-describedby={errorId("name")}
          />
          <FieldError id="jk-pf-name-error" messages={messagesFor("name")} />
        </div>
      </div>

      <div class="jk-field">
        <label class="jk-label" for="jk-pf-baseUrl">
          Base URL
        </label>
        <input
          id="jk-pf-baseUrl"
          class="jk-input jk-input-code"
          type="text"
          placeholder="https://api.anthropic.com"
          value={profile.baseUrl}
          autoComplete="off"
          onInput={(event) =>
            onChange({ baseUrl: (event.currentTarget as HTMLInputElement).value })
          }
          aria-invalid={invalid("baseUrl")}
          aria-describedby={describedBy("jk-pf-baseUrl-help", errorId("baseUrl"))}
        />
        <p class="jk-help" id="jk-pf-baseUrl-help">
          Kosongkan untuk memakai API Anthropic
        </p>
        <FieldError id="jk-pf-baseUrl-error" messages={messagesFor("baseUrl")} />
      </div>

      <fieldset
        class="jk-fieldset"
        aria-describedby={describedBy(errorId("apiKeyEnv"), errorId("apiKey"))}
      >
        <legend class="jk-label">Key</legend>
        <div class="jk-radio-group">
          {keyOptions.map((option) => (
            <label class="jk-radio" key={option.value}>
              <input
                type="radio"
                name="jk-pf-keyMode"
                value={option.value}
                checked={profile.keyMode === option.value}
                onChange={() => onChange({ keyMode: option.value })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>

        {profile.keyMode === "env" && (
          <div class="jk-field jk-nested-field">
            <label class="jk-label" for="jk-pf-apiKeyEnv">
              Nama variabel env
            </label>
            <input
              id="jk-pf-apiKeyEnv"
              class="jk-input jk-input-code"
              type="text"
              value={profile.apiKeyEnv}
              autoComplete="off"
              onInput={(event) =>
                onChange({ apiKeyEnv: (event.currentTarget as HTMLInputElement).value })
              }
              aria-invalid={invalid("apiKeyEnv")}
              aria-describedby={describedBy("jk-pf-apiKeyEnv-help", errorId("apiKeyEnv"))}
            />
            <p class="jk-help" id="jk-pf-apiKeyEnv-help">
              Nilai dibaca dari lingkungan server saat sesi berjalan.
            </p>
            <FieldError id="jk-pf-apiKeyEnv-error" messages={messagesFor("apiKeyEnv")} />
          </div>
        )}

        {profile.keyMode === "literal" && (
          <div class="jk-field jk-nested-field">
            <label class="jk-label" for="jk-pf-apiKey">
              API key
            </label>
            <input
              id="jk-pf-apiKey"
              class="jk-input jk-input-code"
              type="password"
              autoComplete="off"
              value={profile.apiKey}
              onInput={(event) =>
                onChange({ apiKey: (event.currentTarget as HTMLInputElement).value })
              }
              aria-invalid={invalid("apiKey")}
              aria-describedby={describedBy("jk-pf-apiKey-help", errorId("apiKey"))}
            />
            <p class="jk-help" id="jk-pf-apiKey-help">
              Tersimpan di ~/.jejak/providers.json dengan izin 600 di mesin ini. Lebih aman
              memakai variabel env.
            </p>
            <FieldError id="jk-pf-apiKey-error" messages={messagesFor("apiKey")} />
          </div>
        )}
      </fieldset>

      <div class="jk-field">
        <label class="jk-label" for="jk-pf-models">
          Model
        </label>
        <textarea
          id="jk-pf-models"
          class="jk-textarea jk-models-textarea"
          rows={4}
          value={profile.modelsText}
          onInput={(event) =>
            onChange({ modelsText: (event.currentTarget as HTMLTextAreaElement).value })
          }
          aria-invalid={invalid("models")}
          aria-describedby={describedBy("jk-pf-models-help", errorId("models"))}
        />
        <p class="jk-help" id="jk-pf-models-help">
          Satu model per baris.
        </p>
        <FieldError id="jk-pf-models-error" messages={messagesFor("models")} />
      </div>

      <div class="jk-field-row">
        <div class="jk-field">
          <label class="jk-label" for="jk-pf-defaultModel">
            Model utama
          </label>
          {models.length === 0 ? (
            <input
              id="jk-pf-defaultModel"
              class="jk-input jk-input-code"
              type="text"
              placeholder="Bawaan"
              value={profile.defaultModel}
              autoComplete="off"
              onInput={(event) =>
                onChange({ defaultModel: (event.currentTarget as HTMLInputElement).value })
              }
              aria-invalid={invalid("defaultModel")}
              aria-describedby={errorId("defaultModel")}
            />
          ) : (
            <select
              id="jk-pf-defaultModel"
              class="jk-select"
              value={profile.defaultModel}
              onChange={(event) =>
                onChange({ defaultModel: (event.currentTarget as HTMLSelectElement).value })
              }
              aria-invalid={invalid("defaultModel")}
              aria-describedby={errorId("defaultModel")}
            >
              <option value="">Bawaan</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
          <FieldError id="jk-pf-defaultModel-error" messages={messagesFor("defaultModel")} />
        </div>

        <div class="jk-field">
          <label class="jk-label" for="jk-pf-lightModel">
            Model ringan
          </label>
          {models.length === 0 ? (
            <input
              id="jk-pf-lightModel"
              class="jk-input jk-input-code"
              type="text"
              placeholder="Bawaan"
              value={profile.lightModel}
              autoComplete="off"
              onInput={(event) =>
                onChange({ lightModel: (event.currentTarget as HTMLInputElement).value })
              }
              aria-invalid={invalid("lightModel")}
              aria-describedby={errorId("lightModel")}
            />
          ) : (
            <select
              id="jk-pf-lightModel"
              class="jk-select"
              value={profile.lightModel}
              onChange={(event) =>
                onChange({ lightModel: (event.currentTarget as HTMLSelectElement).value })
              }
              aria-invalid={invalid("lightModel")}
              aria-describedby={errorId("lightModel")}
            >
              <option value="">Bawaan</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
          <FieldError id="jk-pf-lightModel-error" messages={messagesFor("lightModel")} />
        </div>
      </div>

      {models.length > 0 && (
        <div class="jk-field">
          <span class="jk-label">Tarif (opsional)</span>
          <p class="jk-help">
            USD per 1 juta token. Dipakai untuk menghitung biaya sendiri, karena angka biaya
            dari SDK memakai tarif Claude.
          </p>
          <div class="jk-price-list">
            {models.map((modelId) => (
              <div class="jk-price-row" key={modelId}>
                <span class="jk-price-model jk-mono">{modelId}</span>
                <div class="jk-price-fields">
                  {PRICE_FIELDS.map((field) => (
                    <label class="jk-price-field" key={field.key}>
                      <span class="jk-label">{field.label}</span>
                      <input
                        class="jk-input jk-input-code jk-input-price"
                        type="text"
                        inputmode="decimal"
                        value={profile.modelPrices[modelId]?.[field.key] ?? ""}
                        placeholder="0"
                        onInput={(event) =>
                          updatePrice(
                            modelId,
                            field.key,
                            (event.currentTarget as HTMLInputElement).value,
                          )
                        }
                        aria-label={`${field.label} tarif model ${modelId}`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <FieldError id="jk-pf-prices-error" messages={messagesFor("prices")} />
        </div>
      )}

      <div class="jk-form-actions">
        <button type="submit" class="jk-button jk-button-primary" disabled={!dirty || !valid || busy}>
          {saving ? "Menyimpan…" : "Simpan perubahan"}
        </button>

        {!profile.isNew && activeProfileId !== profile.id && (
          <button
            type="button"
            class="jk-button jk-button-secondary"
            onClick={onActivate}
            disabled={busy}
          >
            {activating ? "Mengaktifkan…" : "Jadikan aktif"}
          </button>
        )}

        <button
          type="button"
          class="jk-button jk-button-secondary jk-button-danger"
          onClick={onRemove}
          disabled={busy}
        >
          Hapus profil
        </button>

        <button
          type="button"
          class="jk-button jk-button-secondary"
          onClick={onTest}
          disabled={busy}
          aria-busy={testing}
        >
          {testing ? "Menguji…" : "Tes koneksi"}
        </button>
      </div>

      {testError !== undefined && (
        <p class="jk-error-line" role="alert">
          {testError}
        </p>
      )}
      {testResult !== undefined && <ConnectionResult result={testResult} />}
    </form>
  );
}
