import { useCallback, useEffect, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import {
  acpStateLabel,
  type AcpAgentInfo,
  type AcpAgentState,
  type AcpAgentStatus,
} from "../lib/acp-agents";
import { featureErrorMessage } from "../lib/features";

export interface AcpAgentSettingsViewProps {
  /** Daftar agent dari server. */
  agents: AcpAgentInfo[] | undefined;
  /** Sedang memuat daftar dari server. */
  loading: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** Hasil probe terakhir per id agent. */
  statuses: Record<string, AcpAgentStatus | undefined>;
  /** Id agent yang sedang diperiksa. */
  probing: Record<string, boolean>;
  /** Tombol "Periksa" ditekan. */
  onProbe: (id: string) => void;
}

/** Nada lencana mengikuti state; teksnya selalu tampil, bukan hanya warna. */
function badgeClass(state: AcpAgentState | undefined): string {
  switch (state) {
    case "siap":
      return "jk-badge jk-badge-success";
    case "belum-login":
      return "jk-badge jk-badge-warning";
    case "galat":
      return "jk-badge jk-badge-danger";
    default:
      return "jk-badge jk-badge-muted";
  }
}

/** Tampilan kartu Agent eksternal tanpa hook; dipakai uji render tanpa DOM. */
export function AcpAgentSettingsView(props: AcpAgentSettingsViewProps) {
  return (
    <section class="jk-feature-settings" aria-labelledby="jk-acp-title">
      <h2 class="jk-feature-title" id="jk-acp-title">
        Agent eksternal
      </h2>
      <p class="jk-help">
        Agent ini dapat dijalankan sebagai anak tim (tool team_spawn dengan parameter harness).
        Jejak tidak menyimpan kredensial: login dilakukan di terminal.
      </p>

      {props.loading && <p class="jk-note">Memuat agent…</p>}

      {props.error !== undefined && (
        <p class="jk-error-line" role="alert">
          {props.error}
        </p>
      )}

      {props.agents !== undefined && props.agents.length === 0 && (
        <p class="jk-note">Belum ada agent eksternal yang dikenal.</p>
      )}

      {props.agents !== undefined && props.agents.length > 0 && (
        <ul class="jk-feature-list">
          {props.agents.map((agent) => {
            const status = props.statuses[agent.id];
            const state = status?.state;
            const terpasang = state === undefined ? agent.installed : state !== "tidak-terpasang";
            const hint =
              status?.hint ??
              (!terpasang
                ? agent.installHint
                : state === "belum-login"
                  ? agent.loginHint
                  : undefined);
            const busy = props.probing[agent.id] === true;
            return (
              <li class="jk-feature-row" key={agent.id}>
                <div class="jk-feature-text">
                  <span class="jk-feature-name">
                    {agent.label}{" "}
                    <span class={badgeClass(state)}>
                      {state === undefined && !agent.installed
                        ? acpStateLabel("tidak-terpasang")
                        : acpStateLabel(state)}
                    </span>
                  </span>
                  {hint !== undefined && <p class="jk-note">{hint}</p>}
                  {state === "galat" && status?.detail !== undefined && (
                    <p class="jk-note">{status.detail}</p>
                  )}
                  {state === "siap" && status?.models !== undefined && (
                    <p class="jk-note">{status.models} model tersedia.</p>
                  )}
                </div>
                <button
                  type="button"
                  class="jk-button jk-button-secondary"
                  aria-label={`Periksa ${agent.label}`}
                  disabled={busy}
                  onClick={() => props.onProbe(agent.id)}
                >
                  {busy ? "Memeriksa…" : "Periksa"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Kartu Agent eksternal di halaman Pengaturan. Probe hanya saat tombol ditekan. */
export function AcpAgentSettings({ api }: { api: ApiClient }) {
  const [agents, setAgents] = useState<AcpAgentInfo[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [statuses, setStatuses] = useState<Record<string, AcpAgentStatus | undefined>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setAgents(await api.getAcpAgents());
      setError(undefined);
    } catch (caught) {
      setError(featureErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const onProbe = useCallback(
    (id: string): void => {
      setProbing((current) => ({ ...current, [id]: true }));
      setError(undefined);
      void (async (): Promise<void> => {
        try {
          const status = await api.probeAcpAgent(id);
          setStatuses((current) => ({ ...current, [id]: status }));
        } catch (caught) {
          setError(featureErrorMessage(caught));
        } finally {
          setProbing((current) => ({ ...current, [id]: false }));
        }
      })();
    },
    [api],
  );

  return (
    <AcpAgentSettingsView
      agents={agents}
      loading={loading}
      error={error}
      statuses={statuses}
      probing={probing}
      onProbe={onProbe}
    />
  );
}
