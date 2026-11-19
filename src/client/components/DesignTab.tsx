import { useMemo, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../lib/api";
import { createCaptureRunner, type CaptureFn } from "../lib/design-capture";
import { SAMPLE_PROMPT, pageRows } from "../lib/design-ui";
import { useDesign } from "../lib/use-design";
import { useDesignComments } from "../lib/use-design-comments";
import { useDesignTokens } from "../lib/use-design-tokens";
import { DesignCanvas } from "./DesignCanvas";

export interface DesignTabProps {
  api: ApiClient;
  sessionId: string;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
  /** Tab sedang terlihat; polling hanya berjalan saat true. */
  active: boolean;
  /** Mode lebar sedang aktif. */
  wide: boolean;
  /** Nyalakan atau matikan mode lebar. */
  onWideChange: (on: boolean) => void;
  /** Mode fokus sedang aktif: kanvas mengisi seluruh jendela. */
  focus?: boolean;
  /** Nyalakan atau matikan mode fokus. */
  onFocusChange?: (on: boolean) => void;
  /** Tempel teks ke kolom pesan; tidak mengirim apa pun. */
  onQuote: (text: string) => void;
}

const EMPTY_TITLE = "Belum ada desain.";
const EMPTY_NOTE =
  "Buat folder design/ berisi aturan, token, dan satu halaman contoh, lalu minta agent merancang halaman berikutnya.";

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "desain tidak dapat dimulai";
}

/**
 * Tab Desain: pintu masuk ke kanvas. Hanya daftar halaman dan tombol mode
 * lebar; kanvasnya sendiri dipasang di komit berikutnya.
 */
export function DesignTab(props: DesignTabProps) {
  const { api, sessionId, repo, active, wide, onWideChange, focus, onFocusChange, onQuote } =
    props;
  // Penangkap didaftarkan kanvas saat terpasang; mode daftar membuatnya
  // undefined sehingga permintaan dijawab `no-frame`.
  const captureRef = useRef<CaptureFn | undefined>(undefined);
  const runner = useMemo(
    () =>
      createCaptureRunner({
        capture: () => captureRef.current,
        upload: (requestId, body) => api.uploadDesignCapture(sessionId, requestId, body, repo),
      }),
    [api, sessionId, repo],
  );
  const { design, loading, error, refresh } = useDesign(
    api,
    sessionId,
    repo,
    active,
    (requests) => runner.handle(requests),
  );
  const comments = useDesignComments(api, sessionId, repo, active, design);
  // Token dimuat ulang saat `tokens.css` berubah, termasuk perubahan oleh
  // agent (cap waktu token ikut berubah).
  const tokenState = useDesignTokens(api, sessionId, repo, active, design?.tokens.mtime);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [tracked, setTracked] = useState(false);

  const mulai = async (): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api.initDesign(sessionId, repo, { tracked });
      await refresh();
      onQuote(SAMPLE_PROMPT);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const galat = actionError ?? error;

  if (design === undefined) {
    return (
      <div class="jk-panel-body">
        {galat !== undefined ? (
          <div class="jk-panel-error">
            <p class="jk-error-line" role="alert">
              {galat}
            </p>
          </div>
        ) : (
          <p class="jk-panel-note" role="status">
            Memuat desain…
          </p>
        )}
      </div>
    );
  }

  if (!design.exists) {
    return (
      <div class="jk-panel-body">
        <p class="jk-panel-note">{EMPTY_TITLE}</p>
        <p class="jk-panel-note">{EMPTY_NOTE}</p>
        {galat !== undefined && (
          <div class="jk-panel-error">
            <p class="jk-error-line" role="alert">
              {galat}
            </p>
          </div>
        )}
        <button
          type="button"
          class="jk-button jk-button-primary"
          disabled={busy}
          onClick={() => void mulai()}
        >
          Mulai desain
        </button>
        <label class="jk-bypass-check">
          <input
            type="checkbox"
            checked={tracked}
            disabled={busy}
            onChange={(event) => setTracked((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Ikut git (jangan abaikan design/)</span>
        </label>
      </div>
    );
  }

  const rows = pageRows(design.pages);
  const peringatan = [...design.warnings];
  if (design.manifestError !== undefined) peringatan.unshift(design.manifestError);

  // Mode lebar: kanvas mengisi badan tab; daftar tetap untuk panel biasa.
  if (wide && design.exists) {
    return (
      <div class="jk-panel-body jk-panel-body-canvas">
        <DesignCanvas
          api={api}
          sessionId={sessionId}
          repo={repo}
          design={design}
          refresh={refresh}
          onExit={() => onWideChange(false)}
          focus={focus === true}
          onFocusChange={onFocusChange}
          onQuote={onQuote}
          registerCapture={(fn) => {
            captureRef.current = fn;
          }}
          comments={comments.comments}
          commentError={comments.error}
          onAddComment={(input) => comments.add(input)}
          onCommentStatus={(id, status) => void comments.setStatus(id, status)}
          onRemoveComment={(id) => void comments.remove(id)}
          tokens={tokenState.tokens}
          tokenError={tokenState.error}
          onSaveTokens={async (next) => {
            await tokenState.save(next);
            // Muat ulang model desain supaya cap waktu token ikut baru dan
            // frame memuat ulang `tokens.css` yang baru.
            await refresh();
          }}
          onSyncDoc={async () => api.syncDesignDoc(sessionId, repo)}
          onCreateVariant={async (slug, variant) => {
            await api.createDesignVariant(sessionId, { slug, variant }, repo);
            // Muat ulang model desain supaya halaman baru ikut ke kanvas.
            await refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div class="jk-panel-body">
      <div class="jk-form-actions">
        <button
          type="button"
          class="jk-button jk-button-primary"
          onClick={() => onWideChange(!wide)}
        >
          {wide ? "Keluar dari mode lebar" : "Buka kanvas lebar"}
        </button>
        <button
          type="button"
          class="jk-button jk-button-secondary"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Segarkan
        </button>
      </div>

      {galat !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {galat}
          </p>
        </div>
      )}

      {peringatan.length > 0 && (
        <ul class="jk-panel-list" aria-label="Peringatan desain">
          {peringatan.map((text, index) => (
            <li class="jk-panel-note" key={`${index}-${text}`}>
              {text}
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p class="jk-panel-note">Belum ada halaman terdaftar.</p>
      ) : (
        <ul class="jk-panel-list" aria-label="Halaman desain">
          {rows.map((row) => (
            <li key={row.slug}>
              <span class="jk-panel-name">{row.title}</span>{" "}
              <span class="jk-panel-note">
                {row.deviceLabel} · {row.sizeLabel}
                {row.route === undefined ? "" : ` · ${row.route}`}
              </span>
              {row.missing && <span class="jk-panel-note">Berkas belum ada</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
