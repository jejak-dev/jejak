import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  ApiError,
  type ApiClient,
  type CommandEnvState,
  type SecretAllowState,
} from "../lib/api";
import { shortPath } from "../lib/format";

export interface SecretsTabProps {
  api: ApiClient;
  sessionId: string;
}

const NOTE =
  "Berkas seperti .env, kunci privat, dan kredensial diblokir untuk agent. " +
  "Izinkan berkas tertentu di sini bila agent memang perlu membacanya. " +
  "Daftar disimpan di luar proyek. Pemblokiran lewat Bash hanya upaya terbaik; " +
  "jaminan penuh menunggu sandbox. Berkas .env yang dipakai sebagai env perintah " +
  "tetap diblokir untuk dibaca langsung oleh agent.";

const DISABLED_MESSAGE = "Daftar izin rahasia dimatikan.";
const EMPTY_MESSAGE = "Belum ada berkas yang diizinkan.";

const COMMAND_ENV_NOTE =
  "Pilih berkas .env (boleh di luar proyek). Setiap perintah Bash agent dijalankan " +
  "dengan isinya sebagai variabel lingkungan; agent hanya melihat nama kunci, " +
  "nilainya disamarkan. Berkas harus berformat shell (KEY=value; beri tanda petik " +
  "bila ada spasi). Penyamaran bersifat upaya terbaik.";

const COMMAND_ENV_DISABLED = "Env perintah dimatikan.";
const COMMAND_ENV_EMPTY_KEYS = "Tidak ada kunci yang terbaca dari berkas ini.";

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

export interface CommandEnvSectionViewProps {
  state: CommandEnvState | undefined;
  loading: boolean;
  error: string | undefined;
  disabled: string | undefined;
  path: string;
  formError: string | undefined;
  saving: boolean;
  clearing: boolean;
  onPath: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  onRetry: () => void;
}

/** Bagian env perintah tanpa hook; dipakai uji render tanpa DOM. */
export function CommandEnvSectionView(props: CommandEnvSectionViewProps): VNode {
  const state = props.state;
  return (
    <section class="jk-command-env" aria-labelledby="jk-command-env-title">
      <p class="jk-label" id="jk-command-env-title">
        Env untuk perintah
      </p>
      <p class="jk-panel-note">{COMMAND_ENV_NOTE}</p>

      {props.disabled !== undefined && <p class="jk-panel-note">{props.disabled}</p>}

      {props.disabled === undefined && props.loading && state === undefined && (
        <p class="jk-panel-note">Memuat…</p>
      )}

      {props.disabled === undefined && props.error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {props.error}
          </p>
          <button type="button" class="jk-link-btn" onClick={props.onRetry}>
            Coba lagi
          </button>
        </div>
      )}

      {props.disabled === undefined && state !== undefined && (
        <>
          {state.path === undefined ? (
            <div class="jk-secret-allow-form">
              <label class="jk-visually-hidden" for="jk-command-env-path">
                Jalur berkas env perintah
              </label>
              <input
                id="jk-command-env-path"
                class="jk-input"
                type="text"
                placeholder="mis. /home/saya/proyek/.env"
                value={props.path}
                spellcheck={false}
                aria-invalid={props.formError !== undefined}
                aria-describedby={
                  props.formError !== undefined ? "jk-command-env-error" : undefined
                }
                onInput={(event) =>
                  props.onPath((event.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.onSave();
                  }
                }}
              />
              <button
                type="button"
                class="jk-button"
                disabled={props.saving}
                onClick={props.onSave}
              >
                {props.saving ? "Menyimpan…" : "Simpan"}
              </button>
            </div>
          ) : (
            <>
              <div class="jk-secret-allow-item">
                <span class="jk-secret-allow-path" title={state.path}>
                  {shortPath(state.path)}
                </span>
                <button
                  type="button"
                  class="jk-link-btn"
                  aria-label={`Hapus env perintah ${state.path}`}
                  disabled={props.clearing}
                  onClick={props.onClear}
                >
                  {props.clearing ? "Menghapus…" : "Hapus"}
                </button>
              </div>
              {state.keys.length === 0 ? (
                <p class="jk-panel-note">{COMMAND_ENV_EMPTY_KEYS}</p>
              ) : (
                <ul class="jk-command-env-keys" aria-label="Nama kunci env">
                  {state.keys.map((key) => (
                    <li class="jk-command-env-key" key={key}>
                      {key}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {props.formError !== undefined && (
            <p id="jk-command-env-error" class="jk-error-line" role="alert">
              {props.formError}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function SecretsTab({ api, sessionId }: SecretsTabProps) {
  const [data, setData] = useState<SecretAllowState | undefined>(undefined);
  const [disabled, setDisabled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | undefined>(undefined);

  const [envState, setEnvState] = useState<CommandEnvState | undefined>(undefined);
  const [envDisabled, setEnvDisabled] = useState<string | undefined>(undefined);
  const [envError, setEnvError] = useState<string | undefined>(undefined);
  const [envLoading, setEnvLoading] = useState(false);
  const [envPath, setEnvPath] = useState("");
  const [envFormError, setEnvFormError] = useState<string | undefined>(undefined);
  const [envSaving, setEnvSaving] = useState(false);
  const [envClearing, setEnvClearing] = useState(false);

  const requestRef = useRef(0);
  const addRef = useRef(0);
  const removeRef = useRef(0);
  const envRef = useRef(0);
  const envSaveRef = useRef(0);
  const envClearRef = useRef(0);

  const loadEnv = async (): Promise<void> => {
    envRef.current += 1;
    const ticket = envRef.current;
    setEnvLoading(true);
    setEnvError(undefined);
    try {
      const state = await api.getCommandEnv(sessionId);
      if (ticket !== envRef.current) return;
      setEnvDisabled(undefined);
      setEnvState(state);
    } catch (caught) {
      if (ticket !== envRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setEnvDisabled(COMMAND_ENV_DISABLED);
        setEnvState(undefined);
        return;
      }
      setEnvError(errorMessage(caught, "env perintah tidak dapat dimuat"));
    } finally {
      if (ticket === envRef.current) setEnvLoading(false);
    }
  };

  const saveEnv = async (): Promise<void> => {
    if (envSaving) return;
    const value = envPath.trim();
    if (value === "") {
      setEnvFormError("Isi jalur berkas dulu.");
      return;
    }
    envSaveRef.current += 1;
    const ticket = envSaveRef.current;
    setEnvSaving(true);
    setEnvFormError(undefined);
    try {
      const state = await api.setCommandEnv(sessionId, value);
      if (ticket !== envSaveRef.current) return;
      setEnvState(state);
      setEnvPath("");
    } catch (caught) {
      if (ticket !== envSaveRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setEnvDisabled(COMMAND_ENV_DISABLED);
        setEnvState(undefined);
        return;
      }
      setEnvFormError(errorMessage(caught, "env perintah tidak dapat disimpan"));
    } finally {
      if (ticket === envSaveRef.current) setEnvSaving(false);
    }
  };

  const clearEnv = async (): Promise<void> => {
    if (envClearing) return;
    envClearRef.current += 1;
    const ticket = envClearRef.current;
    setEnvClearing(true);
    setEnvError(undefined);
    try {
      await api.clearCommandEnv(sessionId);
      if (ticket !== envClearRef.current) return;
      setEnvState({ keys: [] });
    } catch (caught) {
      if (ticket !== envClearRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setEnvDisabled(COMMAND_ENV_DISABLED);
        setEnvState(undefined);
        return;
      }
      setEnvError(errorMessage(caught, "env perintah tidak dapat dihapus"));
    } finally {
      if (ticket === envClearRef.current) setEnvClearing(false);
    }
  };

  const load = async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const state = await api.getSecretAllow(sessionId);
      if (ticket !== requestRef.current) return;
      setDisabled(undefined);
      setData(state);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setData(undefined);
        return;
      }
      setError(errorMessage(caught, "daftar izin rahasia tidak dapat dimuat"));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  // Tab dipasang hanya saat dipilih, jadi muat sekali per sesi.
  useEffect(() => {
    void load();
    void loadEnv();
    // load stabil secara perilaku; deps sengaja dibatasi sesi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const submit = async (): Promise<void> => {
    if (adding) return;
    const value = path.trim();
    if (value === "") {
      setFormError("Isi jalur berkas dulu.");
      return;
    }
    addRef.current += 1;
    const ticket = addRef.current;
    setAdding(true);
    setFormError(undefined);
    try {
      const result = await api.addSecretAllow(sessionId, value);
      if (ticket !== addRef.current) return;
      setData((current) => ({
        root: current?.root ?? "",
        allowed: result.allowed,
      }));
      setPath("");
    } catch (caught) {
      if (ticket !== addRef.current) return;
      setFormError(errorMessage(caught, "berkas tidak dapat diizinkan"));
    } finally {
      if (ticket === addRef.current) setAdding(false);
    }
  };

  const remove = async (target: string): Promise<void> => {
    if (removingPath !== undefined) return;
    removeRef.current += 1;
    const ticket = removeRef.current;
    setRemovingPath(target);
    setError(undefined);
    try {
      const result = await api.removeSecretAllow(sessionId, target);
      if (ticket !== removeRef.current) return;
      setData((current) => ({
        root: current?.root ?? "",
        allowed: result.allowed,
      }));
    } catch (caught) {
      if (ticket !== removeRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setData(undefined);
        return;
      }
      setError(errorMessage(caught, "izin tidak dapat dicabut"));
    } finally {
      if (ticket === removeRef.current) setRemovingPath(undefined);
    }
  };

  const envSection = (
    <CommandEnvSectionView
      state={envState}
      loading={envLoading}
      error={envError}
      disabled={envDisabled}
      path={envPath}
      formError={envFormError}
      saving={envSaving}
      clearing={envClearing}
      onPath={setEnvPath}
      onSave={() => void saveEnv()}
      onClear={() => void clearEnv()}
      onRetry={() => void loadEnv()}
    />
  );

  if (disabled !== undefined) {
    return (
      <div class="jk-panel-body">
        <p class="jk-panel-note">{disabled}</p>
        {envSection}
      </div>
    );
  }

  return (
    <div class="jk-panel-body">
      <p class="jk-label">Izin berkas rahasia</p>
      <p class="jk-panel-note">{NOTE}</p>

      {loading && data === undefined && <p class="jk-panel-note">Memuat…</p>}

      {error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {data !== undefined && (
        <>
          <p class="jk-panel-note">
            Akar proyek: <span class="jk-mono" title={data.root}>{shortPath(data.root)}</span>
          </p>

          <div class="jk-secret-allow-form">
            <label class="jk-visually-hidden" for="jk-secret-allow-path">
              Jalur berkas rahasia
            </label>
            <input
              id="jk-secret-allow-path"
              class="jk-input"
              type="text"
              placeholder="mis. .env atau config/prod.env"
              value={path}
              spellcheck={false}
              aria-invalid={formError !== undefined}
              aria-describedby={formError !== undefined ? "jk-secret-allow-error" : undefined}
              onInput={(event) => setPath((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              class="jk-button"
              disabled={adding}
              onClick={() => void submit()}
            >
              {adding ? "Mengizinkan…" : "Izinkan"}
            </button>
          </div>

          {formError !== undefined && (
            <p id="jk-secret-allow-error" class="jk-error-line" role="alert">
              {formError}
            </p>
          )}

          {data.allowed.length === 0 ? (
            <p class="jk-panel-note">{EMPTY_MESSAGE}</p>
          ) : (
            <ul class="jk-secret-allow-list">
              {data.allowed.map((entry) => (
                <li class="jk-secret-allow-item" key={entry}>
                  <span class="jk-secret-allow-path" title={entry}>
                    {shortPath(entry)}
                  </span>
                  <button
                    type="button"
                    class="jk-link-btn"
                    aria-label={`Cabut izin ${entry}`}
                    disabled={removingPath !== undefined}
                    onClick={() => void remove(entry)}
                  >
                    {removingPath === entry ? "Mencabut…" : "Cabut"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {envSection}
    </div>
  );
}
