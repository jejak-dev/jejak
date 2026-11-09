import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type SecretAllowState } from "../lib/api";
import { shortPath } from "../lib/format";

export interface SecretsTabProps {
  api: ApiClient;
  sessionId: string;
}

const NOTE =
  "Berkas seperti .env, kunci privat, dan kredensial diblokir untuk agent. " +
  "Izinkan berkas tertentu di sini bila agent memang perlu membacanya. " +
  "Daftar disimpan di luar proyek. Pemblokiran lewat Bash hanya upaya terbaik; " +
  "jaminan penuh menunggu sandbox.";

const DISABLED_MESSAGE = "Daftar izin rahasia dimatikan.";
const EMPTY_MESSAGE = "Belum ada berkas yang diizinkan.";

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
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

  const requestRef = useRef(0);
  const addRef = useRef(0);
  const removeRef = useRef(0);

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

  if (disabled !== undefined) {
    return (
      <div class="jk-panel-body">
        <p class="jk-panel-note">{disabled}</p>
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
    </div>
  );
}
