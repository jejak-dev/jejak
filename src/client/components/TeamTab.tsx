import { useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { ApiClient } from "../lib/api";
import { formatCost, formatCount } from "../lib/format";
import { childCostUsd, describeChildResult, teamStats } from "../lib/team";

export interface TeamTabProps {
  api: ApiClient;
  /** Sesi induk yang sedang dibuka. */
  session: SessionInfo;
  /** Semua sesi yang diketahui klien; anak diturunkan dari `team.parentId`. */
  sessions: readonly SessionInfo[];
  /** Pindah ke sesi anak. */
  onOpenSession: (id: string) => void;
  /** Muat ulang daftar sesi setelah aksi. */
  onChanged?: () => void;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "terjadi kesalahan";
}

/** Label status anak yang dipakai tabel. */
function statusLabel(session: SessionInfo): string {
  if (session.pendingPermissions > 0) return "menunggu izin";
  switch (session.status) {
    case "berjalan":
      return "berjalan";
    case "selesai":
      return "selesai";
    case "gagal":
      return "gagal";
    case "dibatalkan":
      return "dihentikan";
    default:
      return session.status;
  }
}

/**
 * Tab "Tim": tabel anak sesi induk dengan total biaya, aksi buka/pesan/hentikan.
 *
 * Daftar anak datang dari prop `sessions` yang dipantau `useSessions`, jadi
 * status dan biaya ikut segar tanpa rute baru.
 */
export function TeamTab(props: TeamTabProps) {
  const { api, session, sessions, onOpenSession, onChanged } = props;
  const children = sessions
    .filter((entry) => entry.team?.parentId === session.id)
    .sort((a, b) => (a.team?.spawnedAt ?? "").localeCompare(b.team?.spawnedAt ?? ""));
  const stats = teamStats(children);
  const [pesanUntuk, setPesanUntuk] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const kirim = async (id: string): Promise<void> => {
    const teks = draft.trim();
    if (teks === "" || busyId !== undefined) return;
    setBusyId(id);
    setError(undefined);
    try {
      await api.sendMessage(id, teks);
      setPesanUntuk(undefined);
      setDraft("");
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const hentikan = async (id: string): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setError(undefined);
    try {
      await api.interruptSession(id);
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div class="jk-team-tab">
      <div class="jk-team-head">
        <span class="jk-team-total">
          Total biaya tim: <strong>{formatCost(stats.costUsd)}</strong>
        </span>
        <span class="jk-team-count">
          {formatCount(stats.active)} aktif / {formatCount(stats.total)}
          {stats.waiting > 0 ? ` · ${formatCount(stats.waiting)} menunggu izin` : ""}
        </span>
      </div>

      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}

      {children.length === 0 ? (
        <p class="jk-empty-line">Belum ada anak.</p>
      ) : (
        <div class="jk-team-table-wrap">
          <table class="jk-usage-table jk-team-table">
            <thead>
              <tr>
                <th scope="col">Anak</th>
                <th scope="col">Status</th>
                <th scope="col">Biaya</th>
                <th scope="col">Hasil</th>
                <th scope="col">
                  <span class="jk-visually-hidden">Aksi</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {children.map((child) => {
                const berjalan = child.status === "berjalan";
                const mengirim = busyId === child.id;
                const hasil = describeChildResult(child.team?.result);
                return (
                  <tr key={child.id}>
                    <td>
                      <span class="jk-team-title">{child.title}</span>
                      <span class="jk-team-meta">{child.team?.role ?? "anak"}</span>
                    </td>
                    <td>{statusLabel(child)}</td>
                    <td class="jk-usage-num">{formatCost(childCostUsd(child))}</td>
                    <td title={child.team?.result?.summary}>{hasil}</td>
                    <td>
                      <span class="jk-team-actions">
                        <button
                          type="button"
                          class="jk-link-btn"
                          aria-label={`Buka ${child.title}`}
                          onClick={() => onOpenSession(child.id)}
                        >
                          Buka
                        </button>
                        <button
                          type="button"
                          class="jk-link-btn"
                          aria-expanded={pesanUntuk === child.id}
                          aria-label={`Pesan ke ${child.title}`}
                          onClick={() => {
                            setError(undefined);
                            setDraft("");
                            setPesanUntuk((current) =>
                              current === child.id ? undefined : child.id,
                            );
                          }}
                        >
                          Pesan
                        </button>
                        {berjalan && (
                          <button
                            type="button"
                            class="jk-link-btn jk-session-danger"
                            disabled={busyId !== undefined}
                            aria-label={`Hentikan ${child.title}`}
                            onClick={() => void hentikan(child.id)}
                          >
                            Hentikan
                          </button>
                        )}
                      </span>
                      {pesanUntuk === child.id && (
                        <form
                          class="jk-team-msg"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void kirim(child.id);
                          }}
                        >
                          <input
                            class="jk-input"
                            type="text"
                            value={draft}
                            placeholder="Pesan ke anak…"
                            aria-label={`Pesan ke ${child.title}`}
                            onInput={(event) =>
                              setDraft((event.currentTarget as HTMLInputElement).value)
                            }
                          />
                          <button
                            type="submit"
                            class="jk-link-btn"
                            disabled={mengirim || draft.trim() === ""}
                          >
                            {mengirim ? "Mengirim…" : "Kirim"}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
