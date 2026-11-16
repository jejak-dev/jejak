import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type SandboxMode,
  type SandboxState,
} from "../lib/api";
import {
  canSubmit,
  listToText,
  sandboxPatchFrom,
  sandboxStatusLine,
} from "../lib/sandbox";
import { Select } from "./Select";

export interface SandboxSettingsProps {
  api: ApiClient;
}

const NOTE =
  "Membatasi perintah Bash agent: tulis hanya di folder kerja, baca kredensial diblokir, jaringan hanya ke daftar domain. Tool berkas (Read/Edit/Write) tetap diatur izin dan penolak berkas rahasia; server MCP tidak disandbox.";

const MODE_LABELS: { value: SandboxMode; label: string }[] = [
  { value: "standar", label: "Standar (nyala)" },
  { value: "mati", label: "Mati" },
];

/** Peringatan bawaan daftar read-only. */
function DefaultList({ title, values }: { title: string; values: string[] }) {
  return (
    <div class="jk-sandbox-defaults-group">
      <p class="jk-label">{title}</p>
      {values.length === 0 ? (
        <p class="jk-note">Tidak ada.</p>
      ) : (
        <ul class="jk-sandbox-defaults-list">
          {values.map((value) => (
            <li key={value} class="jk-mono">
              {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "terjadi kesalahan";
}

function isDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

export function SandboxSettings({ api }: SandboxSettingsProps) {
  const [state, setState] = useState<SandboxState | undefined>(undefined);
  const [mode, setMode] = useState<SandboxMode>("standar");
  const [domains, setDomains] = useState("");
  const [denyRead, setDenyRead] = useState("");
  const [denyWrite, setDenyWrite] = useState("");
  const [allowWrite, setAllowWrite] = useState("");
  const [allowUnixSockets, setAllowUnixSockets] = useState("");
  const [allowLocalBinding, setAllowLocalBinding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const requestRef = useRef(0);
  const savingRef = useRef(false);

  const load = useCallback(async (silent = false): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    if (!silent) setLoading(true);
    setLoadError(undefined);
    try {
      const next = await api.getSandbox();
      if (ticket !== requestRef.current) return;
      setState(next);
      setMode(next.config.mode);
      setDomains(listToText(next.config.allowedDomains));
      setDenyRead(listToText(next.config.extraDenyRead));
      setDenyWrite(listToText(next.config.extraDenyWrite));
      setAllowWrite(listToText(next.config.extraAllowWrite));
      setAllowUnixSockets(listToText(next.config.extraAllowUnixSockets));
      setAllowLocalBinding(next.config.allowLocalBinding);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setDisabled(isDisabled(caught));
      if (!isDisabled(caught)) setLoadError(messageOf(caught));
    } finally {
      if (ticket === requestRef.current && !silent) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = state?.config;
  const form = { mode, domains, denyRead, denyWrite, allowWrite, allowUnixSockets, allowLocalBinding };
  const result =
    current === undefined
      ? { patch: undefined, error: undefined }
      : sandboxPatchFrom(form, current);
  const dirty = canSubmit(result, saving);

  const save = (): void => {
    if (savingRef.current || state === undefined) return;
    const parsed = sandboxPatchFrom(form, state.config);
    if (parsed.error !== undefined) {
      setError(parsed.error);
      return;
    }
    const patch = parsed.patch;
    if (patch === undefined || Object.keys(patch).length === 0) return;

    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    void (async () => {
      try {
        await api.putSandbox(patch);
        setSaved(true);
        await load(true);
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    save();
  };

  const onChange = (update: () => void): void => {
    update();
    setSaved(false);
    setError(undefined);
  };

  return (
    <section class="jk-sandbox-settings" aria-labelledby="jk-sandbox-title">
      <h2 class="jk-sandbox-title" id="jk-sandbox-title">
        Sandbox Bash
      </h2>
      <p class="jk-help">{NOTE}</p>

      {loading && <p class="jk-note">Memuat sandbox…</p>}

      {!loading && disabled && (
        <p class="jk-note">Sandbox dimatikan (JEJAK_SANDBOX=0).</p>
      )}

      {!loading && !disabled && loadError !== undefined && (
        <div class="jk-sandbox-load-error">
          <p class="jk-error-line" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            class="jk-button jk-button-secondary"
            onClick={() => void load()}
          >
            Coba lagi
          </button>
        </div>
      )}

      {!loading && !disabled && loadError === undefined && state !== undefined && (
        <>
          <p class="jk-note jk-sandbox-status">{sandboxStatusLine(state)}</p>

          {!state.available.ok && state.config.mode !== "mati" && (
            <p class="jk-secret-warning" role="status">
              Sesi baru akan gagal sampai sandbox tersedia atau dimatikan. Jalankan jejak doctor.
            </p>
          )}

          <form class="jk-sandbox-form" onSubmit={onSubmit} aria-busy={saving}>
            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-mode">
                Mode
              </label>
              <Select
                id="jk-sandbox-mode"
                value={mode}
                options={MODE_LABELS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => onChange(() => setMode(value as SandboxMode))}
              />
            </div>

            {mode === "mati" && (
              <p class="jk-secret-warning" role="status">
                Sesi baru berjalan tanpa batas sandbox. Perubahan tercatat di Log audit.
              </p>
            )}

            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-domains">
                Domain tambahan
              </label>
              <textarea
                id="jk-sandbox-domains"
                class="jk-textarea jk-input-code"
                rows={3}
                placeholder="satu domain per baris, mis. *.example.com"
                value={domains}
                onInput={(event) =>
                  onChange(() => setDomains((event.currentTarget as HTMLTextAreaElement).value))
                }
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? "jk-sandbox-error" : undefined}
              />
            </div>

            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-deny-read">
                Jalur dilarang dibaca tambahan
              </label>
              <textarea
                id="jk-sandbox-deny-read"
                class="jk-textarea jk-input-code"
                rows={3}
                placeholder="satu jalur per baris, mis. ~/.config/rahasia"
                value={denyRead}
                onInput={(event) =>
                  onChange(() => setDenyRead((event.currentTarget as HTMLTextAreaElement).value))
                }
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? "jk-sandbox-error" : undefined}
              />
            </div>

            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-deny-write">
                Jalur dilarang ditulis tambahan
              </label>
              <textarea
                id="jk-sandbox-deny-write"
                class="jk-textarea jk-input-code"
                rows={3}
                placeholder="satu jalur per baris, mis. /etc"
                value={denyWrite}
                onInput={(event) =>
                  onChange(() => setDenyWrite((event.currentTarget as HTMLTextAreaElement).value))
                }
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? "jk-sandbox-error" : undefined}
              />
            </div>

            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-allow-write">
                Jalur tulis tambahan
              </label>
              <textarea
                id="jk-sandbox-allow-write"
                class="jk-textarea jk-input-code"
                rows={3}
                placeholder="satu jalur per baris, mis. ~/tmp/proyek"
                value={allowWrite}
                onInput={(event) =>
                  onChange(() => setAllowWrite((event.currentTarget as HTMLTextAreaElement).value))
                }
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? "jk-sandbox-error" : undefined}
              />
              <p class="jk-note">
                Folder kerja sudah bisa ditulis. Jalur di sini memperlebar akses Bash; setiap izin
                tercatat di Log audit.
              </p>
            </div>

            <div class="jk-field">
              <label class="jk-label" for="jk-sandbox-allow-sockets">
                Socket Unix yang diizinkan
              </label>
              <textarea
                id="jk-sandbox-allow-sockets"
                class="jk-textarea jk-input-code"
                rows={3}
                placeholder="satu jalur per baris, mis. ~/.orbstack/run/docker.sock"
                value={allowUnixSockets}
                onInput={(event) =>
                  onChange(() =>
                    setAllowUnixSockets((event.currentTarget as HTMLTextAreaElement).value),
                  )
                }
                aria-invalid={error !== undefined}
                aria-describedby={error !== undefined ? "jk-sandbox-error" : undefined}
              />
              <p class="jk-note">
                Contoh: ~/.orbstack/run/docker.sock dan /var/run/docker.sock. Untuk database lokal
                lewat TCP, tambahkan localhost dan 127.0.0.1 di daftar domain. Setiap izin
                memperlebar akses Bash dan tercatat di Log audit.
              </p>
            </div>

            <div class="jk-field">
              <label class="jk-bypass-check">
                <input
                  id="jk-sandbox-local-binding"
                  type="checkbox"
                  checked={allowLocalBinding}
                  onChange={(event) =>
                    onChange(() =>
                      setAllowLocalBinding((event.currentTarget as HTMLInputElement).checked),
                    )
                  }
                />
                <span>Izinkan bind port localhost</span>
              </label>
              <p class="jk-note">
                Hanya berlaku di macOS. Setiap izin memperlebar akses Bash dan tercatat di Audit
                log.
              </p>
            </div>

            <details class="jk-sandbox-defaults">
              <summary>Bawaan</summary>
              <DefaultList title="Domain bawaan" values={state.defaults.allowedDomains} />
              <DefaultList title="Jalur baca diblokir (relatif home)" values={state.defaults.denyRead} />
              <DefaultList title="Jalur tulis diblokir (relatif proyek)" values={state.defaults.denyWrite} />
            </details>

            <div class="jk-form-actions">
              <button
                type="submit"
                class="jk-button jk-button-primary"
                disabled={!dirty || saving}
              >
                {saving ? "Menyimpan…" : "Simpan"}
              </button>
              <span class="jk-note" role="status">
                {saved ? "Tersimpan." : ""}
              </span>
            </div>
          </form>

          {error !== undefined && (
            <p class="jk-error-line" id="jk-sandbox-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
