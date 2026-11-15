import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import {
  ApiError,
  type ApiClient,
  type AuditEntryItem,
  type AuditSummaryResult,
} from "../lib/api";
import {
  AUDIT_KIND_LABELS,
  AUDIT_SESSION_TITLE_MAX,
  auditQueryFor,
  formatAuditTime,
  kindLabel,
  kindTone,
  mergeEntries,
  metaLine,
  sessionLabel,
  summaryLine,
} from "../lib/audit";
import { Select } from "./Select";

export interface AuditPageProps {
  api: ApiClient;
  sessions: SessionInfo[];
}

const NOTE =
  "Catatan lokal aksi agent. Tidak memuat isi berkas, output tool, atau isi pesan. Bukan bukti anti-ubah.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "log audit tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

function shortTitle(title: string): string {
  return title.length > AUDIT_SESSION_TITLE_MAX
    ? `${title.slice(0, AUDIT_SESSION_TITLE_MAX)}…`
    : title;
}

const KIND_ORDER = Object.keys(AUDIT_KIND_LABELS);

export function AuditPage({ api, sessions }: AuditPageProps) {
  const [entries, setEntries] = useState<AuditEntryItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [summary, setSummary] = useState<AuditSummaryResult | undefined>(undefined);
  const [filterKind, setFilterKind] = useState("");
  const [filterSession, setFilterSession] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);

  const requestRef = useRef(0);
  const now = new Date();

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    setMoreError(undefined);
    try {
      const [list, ringkasan] = await Promise.all([
        api.listAudit(auditQueryFor({ kind: filterKind, session: filterSession })),
        api.getAuditSummary(),
      ]);
      if (ticket !== requestRef.current) return;
      setEntries(list.entries);
      setNext(list.next);
      setSummary(ringkasan);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      if (isDisabled(caught)) {
        setDisabled(true);
        setError(undefined);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [api, filterKind, filterSession]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (loadingMore || next === null) return;
    const ticket = requestRef.current;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await api.listAudit(
        auditQueryFor({ kind: filterKind, session: filterSession }, next),
      );
      if (ticket !== requestRef.current) return;
      setEntries((current) => mergeEntries(current, page.entries));
      setNext(page.next);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      if (isDisabled(caught)) setDisabled(true);
      else setMoreError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoadingMore(false);
    }
  };

  const sessionCell = (entry: AuditEntryItem) => {
    const id = entry.sessionId;
    if (id === undefined || id === null || id === "") return null;
    const label = sessionLabel(id, sessions);
    const exists = sessions.some((session) => session.id === id);
    return exists ? (
      <a class="jk-audit-session-link" href={`#/s/${encodeURIComponent(id)}`}>
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  };

  const chips =
    summary === undefined
      ? []
      : KIND_ORDER.filter((kind) => (summary.byKind[kind] ?? 0) > 0).map((kind) => ({
          kind,
          count: summary.byKind[kind] ?? 0,
        }));

  return (
    <section class="jk-audit" aria-labelledby="jk-audit-title">
      <header class="jk-settings-head">
        <h2 id="jk-audit-title" tabIndex={-1} class="jk-settings-title">
          Audit log
        </h2>
        <p class="jk-privacy-note">{NOTE}</p>
      </header>

      {disabled ? (
        <p class="jk-note">Audit log dimatikan (JEJAK_AUDIT=0).</p>
      ) : (
        <>
          <div class="jk-audit-top">
            <p class="jk-audit-summary-line">
              {summary === undefined ? "" : summaryLine(summary)}
            </p>
            <div class="jk-audit-chips">
              {chips.map(({ kind, count }) => (
                <button
                  key={kind}
                  type="button"
                  class={`jk-audit-chip${
                    filterKind === kind ? " jk-audit-chip-active" : ""
                  }`}
                  aria-pressed={filterKind === kind}
                  aria-label={`${kindLabel(kind)}: ${count}`}
                  onClick={() => setFilterKind((current) => (current === kind ? "" : kind))}
                >
                  {kindLabel(kind)} <span class="jk-audit-chip-count">{count}</span>
                </button>
              ))}
            </div>
            <div class="jk-audit-filters">
              <Select
                class="jk-audit-select"
                size="compact"
                ariaLabel="Filter jenis"
                value={filterKind}
                options={[
                  { value: "", label: "Semua jenis" },
                  ...KIND_ORDER.map((kind) => ({ value: kind, label: kindLabel(kind) })),
                ]}
                onChange={(value) => setFilterKind(value)}
              />
              <Select
                class="jk-audit-select"
                size="compact"
                ariaLabel="Filter sesi"
                value={filterSession}
                options={[
                  { value: "", label: "Semua sesi" },
                  ...sessions.map((session) => ({
                    value: session.id,
                    label: shortTitle(session.title),
                  })),
                ]}
                onChange={(value) => setFilterSession(value)}
              />
              <button
                type="button"
                class="jk-button jk-audit-refresh"
                disabled={loading}
                onClick={() => void load()}
              >
                Segarkan
              </button>
            </div>
          </div>

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

          {loading && (
            <p class="jk-note" role="status" aria-live="polite">
              Memuat…
            </p>
          )}

          {!loading && error === undefined && entries.length === 0 && (
            <p class="jk-note">Belum ada catatan.</p>
          )}

          {!loading && error === undefined && entries.length > 0 && (
            <table class="jk-audit-table">
              <thead>
                <tr>
                  <th scope="col">Waktu</th>
                  <th scope="col">Jenis</th>
                  <th scope="col">Ringkasan</th>
                  <th scope="col">Sesi</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const tone = kindTone(entry.kind);
                  const meta = metaLine(entry.meta);
                  return (
                    <tr key={entry.id}>
                      <td class="jk-audit-time">{formatAuditTime(entry.ts, now)}</td>
                      <td class="jk-audit-kind-cell">
                        <span
                          class={`jk-audit-kind${tone === "" ? "" : ` jk-audit-kind-${tone}`}`}
                        >
                          {kindLabel(entry.kind)}
                        </span>
                      </td>
                      <td class="jk-audit-summary-cell">
                        <span class="jk-audit-entry-summary">{entry.summary}</span>
                        {meta !== "" && <span class="jk-audit-meta">{meta}</span>}
                      </td>
                      <td class="jk-audit-session-cell">{sessionCell(entry)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {moreError !== undefined && (
            <p class="jk-error-line" role="alert">
              {moreError}
            </p>
          )}

          {!loading && error === undefined && next !== null && (
            <div class="jk-audit-more">
              <button
                type="button"
                class="jk-button jk-audit-more-btn"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Memuat…" : "Muat lebih lama"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
