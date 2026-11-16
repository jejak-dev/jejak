import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type ClaudePluginItem } from "../lib/api";
import { pluginLabel, pluginSummary, sortPlugins } from "../lib/plugins";
import { DISABLED_NOTE, PluginBrowser } from "./PluginBrowser";

const PLUGINS_NOTE =
  'Plugin dibaca dari instalasi Claude Code (~/.claude/plugins). Plugin baru bisa dipasang dari tab Jelajahi atau lewat perintah "claude plugin install" di terminal. Plugin yang dinyalakan dimuat pada sesi berikutnya dan membawa skills, perintah slash /plugin:nama, subagent, serta hooks-nya; hooks plugin mengikuti saklar "Jalankan hooks Claude".';

const PLUGINS_EMPTY_NOTE = "claude plugin install <nama>@<marketplace>";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "plugin tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

export interface PluginsPanelProps {
  api: ApiClient;
}

export function PluginsPanel({ api }: PluginsPanelProps) {
  const [plugins, setPlugins] = useState<ClaudePluginItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  /** Id plugin yang permintaannya sedang berjalan. */
  const [busy, setBusy] = useState<string | undefined>();
  /** Sub-tab panel: daftar terpasang atau penjelajahan marketplace. */
  const [tab, setTab] = useState<"terpasang" | "jelajahi">("terpasang");
  const reqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    reqRef.current += 1;
    const ticket = reqRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const list = await api.listPlugins();
      if (ticket !== reqRef.current) return;
      setPlugins(list);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== reqRef.current) return;
      setPlugins([]);
      if (isDisabled(caught)) {
        setDisabled(true);
        setError(undefined);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      if (ticket === reqRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (plugin: ClaudePluginItem, enabled: boolean): Promise<void> => {
    if (busy !== undefined) return;
    setBusy(plugin.id);
    setError(undefined);
    // Pembaruan optimistis: saklar langsung mengikuti klik pengguna.
    setPlugins((current) =>
      current.map((item) => (item.id === plugin.id ? { ...item, enabled } : item)),
    );
    try {
      await api.setPluginEnabled(plugin.id, enabled);
    } catch (caught) {
      // Kembalikan saklar ke posisi semula bila server menolak.
      setPlugins((current) =>
        current.map((item) => (item.id === plugin.id ? { ...item, enabled: !enabled } : item)),
      );
      if (isDisabled(caught)) {
        setDisabled(true);
        setError(undefined);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const daftar = sortPlugins(plugins);

  return (
    <div
      class="jk-instruksi-panel"
      role="tabpanel"
      id="jk-instruksi-panel-plugins"
      aria-labelledby="jk-instruksi-tab-plugins"
    >
      <div class="jk-panel-tabs jk-plugin-tabs" role="tablist" aria-label="Bagian plugin">
        <button
          type="button"
          role="tab"
          class={`jk-panel-tab${tab === "terpasang" ? " jk-panel-tab-active" : ""}`}
          aria-selected={tab === "terpasang"}
          onClick={() => setTab("terpasang")}
        >
          Terpasang
        </button>
        <button
          type="button"
          role="tab"
          class={`jk-panel-tab${tab === "jelajahi" ? " jk-panel-tab-active" : ""}`}
          aria-selected={tab === "jelajahi"}
          onClick={() => setTab("jelajahi")}
        >
          Jelajahi
        </button>
      </div>

      {disabled ? (
        <p class="jk-note">{DISABLED_NOTE}</p>
      ) : tab === "jelajahi" ? (
        <PluginBrowser api={api} onChanged={() => void load()} />
      ) : (
        <>
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

          {!loading && error === undefined && daftar.length === 0 && (
            <div class="jk-plugin-empty">
              <p class="jk-note">Belum ada plugin terpasang.</p>
              <p class="jk-note jk-plugin-empty-note">
                Pasang dari tab Jelajahi, atau lewat terminal:{" "}
                <code>{PLUGINS_EMPTY_NOTE}</code>
              </p>
            </div>
          )}

          {!loading && error === undefined && daftar.length > 0 && (
            <ul class="jk-plugin-list">
              {daftar.map((plugin) => (
                <li class="jk-plugin-card" key={plugin.id}>
                  <div class="jk-plugin-head">
                    <span class="jk-plugin-name">{pluginLabel(plugin)}</span>
                    {plugin.marketplace !== "" && (
                      <span class="jk-badge jk-badge-muted">{plugin.marketplace}</span>
                    )}
                    <input
                      type="checkbox"
                      class="jk-plugin-switch"
                      aria-label={`Aktifkan plugin ${plugin.name}`}
                      checked={plugin.enabled}
                      disabled={busy !== undefined}
                      onChange={(event) => void toggle(plugin, event.currentTarget.checked)}
                    />
                  </div>
                  {plugin.description !== "" && (
                    <p class="jk-plugin-desc" title={plugin.description}>
                      {plugin.description}
                    </p>
                  )}
                  <div class="jk-plugin-meta">
                    <span class="jk-plugin-summary">{pluginSummary(plugin)}</span>
                    {plugin.author !== "" && (
                      <span class="jk-plugin-author">{plugin.author}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p class="jk-note jk-instruksi-note">{PLUGINS_NOTE}</p>
    </div>
  );
}
