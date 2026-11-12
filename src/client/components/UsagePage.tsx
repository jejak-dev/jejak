import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient, type UsageResponse } from "../lib/api";
import {
  barHeights,
  formatCost,
  formatTokensShort,
  rangeLabel,
  shareOf,
} from "../lib/usage";

export interface UsagePageProps {
  api: ApiClient;
  sessions: SessionInfo[];
}

const RANGES = [7, 30, 90] as const;
type UsageRange = (typeof RANGES)[number];

const NOTE =
  "Biaya dihitung dari data SDK; untuk penyedia non-Anthropic angkanya perkiraan.";

const CHART_MAX_PX = 120;

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "ringkasan pemakaian tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

function shortText(value: string, max = 28): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function dayLabel(day: string): string {
  const parts = day.split("-");
  if (parts.length !== 3) return day;
  return `${parts[2]}/${parts[1]}`;
}

/** Keadaan saat pencatatan pemakaian dimatikan. */
export function UsageDisabled() {
  return <p class="jk-note">Pencatatan pemakaian dimatikan.</p>;
}

/** Keadaan galat: pesan singkat dan tombol coba lagi. */
export function UsageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div class="jk-panel-error">
      <p class="jk-note" role="alert">
        {message}
      </p>
      <button type="button" class="jk-link-btn" onClick={onRetry}>
        Coba lagi
      </button>
    </div>
  );
}

export interface UsageBodyProps {
  data: UsageResponse;
  sessions: SessionInfo[];
}

/** Isi halaman: kartu ringkas, diagram, dan tabel. Tanpa hook. */
export function UsageBody({ data, sessions }: UsageBodyProps) {
  const summary = data.summary;
  const days = summary.byDay;
  const heights = barHeights(
    days.map((day) => day.costUsd),
    CHART_MAX_PX,
  );
  const totalCost = summary.totalCostUsd;
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const empty = summary.turns === 0;

  const sessionLabel = (id: string): string => {
    const fromApi = data.sessions[id];
    if (typeof fromApi === "string" && fromApi !== "") return shortText(fromApi);
    const known = sessions.find((session) => session.id === id);
    return known === undefined ? shortText(id, 18) : shortText(known.title);
  };

  const sessionCell = (id: string) => {
    const exists = sessions.some((session) => session.id === id);
    const label = sessionLabel(id);
    return exists ? (
      <a class="jk-usage-session-link" href={`#/s/${encodeURIComponent(id)}`}>
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  };

  return (
    <>
      <div class="jk-usage-cards">
        <div class="jk-usage-card">
          <span class="jk-usage-card-label">Total biaya</span>
          <span class="jk-usage-card-value">{formatCost(totalCost)}</span>
        </div>
        <div class="jk-usage-card">
          <span class="jk-usage-card-label">Token masuk</span>
          <span class="jk-usage-card-value">
            {formatTokensShort(summary.totalInputTokens)}
          </span>
        </div>
        <div class="jk-usage-card">
          <span class="jk-usage-card-label">Token keluar</span>
          <span class="jk-usage-card-value">
            {formatTokensShort(summary.totalOutputTokens)}
          </span>
        </div>
        <div class="jk-usage-card">
          <span class="jk-usage-card-label">Giliran</span>
          <span class="jk-usage-card-value">{summary.turns}</span>
        </div>
      </div>

      {empty ? (
        <p class="jk-note">Belum ada pemakaian dalam rentang ini.</p>
      ) : (
        <>
          <div class="jk-usage-chart-wrap">
            <div
              class="jk-usage-chart"
              role="img"
              aria-label={`Biaya per hari, ${rangeLabel(data.days)}`}
            >
              {days.map((day, index) => (
                <div
                  key={day.day}
                  class="jk-usage-chart-col"
                  title={`${day.day} · ${formatCost(day.costUsd)} · ${day.turns} giliran`}
                >
                  <div
                    class="jk-usage-chart-bar"
                    style={{ height: `${heights[index] ?? 0}px` }}
                  />
                </div>
              ))}
            </div>
            <div class="jk-usage-chart-axis">
              <span>{firstDay === undefined ? "" : dayLabel(firstDay.day)}</span>
              <span>{lastDay === undefined ? "" : dayLabel(lastDay.day)}</span>
            </div>
          </div>

          <div class="jk-usage-grid">
            <section class="jk-usage-panel">
              <h3 class="jk-usage-panel-title">Per model</h3>
              {summary.byModel.length === 0 ? (
                <p class="jk-note">Belum ada data model.</p>
              ) : (
                <table class="jk-usage-table">
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col">Biaya</th>
                      <th scope="col">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byModel.map((row) => (
                      <tr key={row.model}>
                        <td>
                          <span class="jk-usage-name">{row.model}</span>
                          <span
                            class="jk-usage-bar"
                            style={{
                              width: `${Math.round(shareOf(row.costUsd, totalCost) * 100)}%`,
                            }}
                          />
                        </td>
                        <td class="jk-usage-num">{formatCost(row.costUsd)}</td>
                        <td class="jk-usage-num">
                          {formatTokensShort(row.inputTokens + row.outputTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section class="jk-usage-panel">
              <h3 class="jk-usage-panel-title">Per profil</h3>
              {summary.byProfile.length === 0 ? (
                <p class="jk-note">Belum ada data profil.</p>
              ) : (
                <table class="jk-usage-table">
                  <thead>
                    <tr>
                      <th scope="col">Profil</th>
                      <th scope="col">Biaya</th>
                      <th scope="col">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byProfile.map((row) => (
                      <tr key={row.profileId}>
                        <td>
                          <span class="jk-usage-name">{row.profileId}</span>
                          <span
                            class="jk-usage-bar"
                            style={{
                              width: `${Math.round(shareOf(row.costUsd, totalCost) * 100)}%`,
                            }}
                          />
                        </td>
                        <td class="jk-usage-num">{formatCost(row.costUsd)}</td>
                        <td class="jk-usage-num">
                          {formatTokensShort(row.inputTokens + row.outputTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section class="jk-usage-panel">
            <h3 class="jk-usage-panel-title">Sesi teratas</h3>
            {summary.bySession.length === 0 ? (
              <p class="jk-note">Belum ada data sesi.</p>
            ) : (
              <table class="jk-usage-table">
                <thead>
                  <tr>
                    <th scope="col">Sesi</th>
                    <th scope="col">Biaya</th>
                    <th scope="col">Token</th>
                    <th scope="col">Giliran</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.bySession.map((row) => (
                    <tr key={row.sessionId}>
                      <td>{sessionCell(row.sessionId)}</td>
                      <td class="jk-usage-num">{formatCost(row.costUsd)}</td>
                      <td class="jk-usage-num">
                        {formatTokensShort(row.inputTokens + row.outputTokens)}
                      </td>
                      <td class="jk-usage-num">{row.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      <p class="jk-usage-foot">{NOTE}</p>
    </>
  );
}

export function UsagePage({ api, sessions }: UsagePageProps) {
  const [range, setRange] = useState<UsageRange>(30);
  const [data, setData] = useState<UsageResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);

  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.getUsage(range);
      if (ticket !== requestRef.current) return;
      setData(result);
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
  }, [api, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section class="jk-usage" aria-labelledby="jk-usage-title">
      <header class="jk-settings-head">
        <h2 id="jk-usage-title" tabIndex={-1} class="jk-settings-title">
          Usage
        </h2>
        <p class="jk-privacy-note">
          Ringkasan biaya dan token dari buku catatan pemakaian lokal.
        </p>
      </header>

      {disabled ? (
        <UsageDisabled />
      ) : (
        <>
          <div class="jk-usage-top">
            <div class="jk-usage-range" role="group" aria-label="Rentang waktu">
              {RANGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  class={`jk-usage-range-btn${range === option ? " jk-usage-range-btn-active" : ""}`}
                  aria-pressed={range === option}
                  onClick={() => setRange(option)}
                >
                  {option} hari
                </button>
              ))}
            </div>
            <p class="jk-usage-range-label">{rangeLabel(range)}</p>
          </div>

          {error !== undefined && (
            <UsageError message={error} onRetry={() => void load()} />
          )}

          {loading && (
            <p class="jk-note" role="status" aria-live="polite">
              Memuat…
            </p>
          )}

          {!loading && error === undefined && data !== undefined && (
            <UsageBody data={data} sessions={sessions} />
          )}
        </>
      )}
    </section>
  );
}
