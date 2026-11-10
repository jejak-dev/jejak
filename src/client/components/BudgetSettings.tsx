import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type BudgetConfigItem,
  type BudgetStatusResult,
} from "../lib/api";
import { budgetLine, parseUsdInput, parseWarnPercent } from "../lib/budget";

export interface BudgetSettingsProps {
  api: ApiClient;
}

const NOTE =
  "Hanya peringatan: sesi tidak dihentikan saat batas terlewati. Angka adalah estimasi dari harga di registry; model tanpa harga tidak dihitung.";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "terjadi kesalahan";
}

function isDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

function textOf(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function percentText(warnAt: number): string {
  return String(Math.round(warnAt * 100));
}

function fill(config: BudgetConfigItem): {
  sessionText: string;
  dailyText: string;
  warnText: string;
} {
  return {
    sessionText: textOf(config.sessionUsd),
    dailyText: textOf(config.dailyUsd),
    warnText: percentText(config.warnAt),
  };
}

export function BudgetSettings({ api }: BudgetSettingsProps) {
  const [status, setStatus] = useState<BudgetStatusResult | undefined>(undefined);
  const [sessionText, setSessionText] = useState("");
  const [dailyText, setDailyText] = useState("");
  const [warnText, setWarnText] = useState("");
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
      const next = await api.getBudgetStatus();
      if (ticket !== requestRef.current) return;
      setStatus(next);
      const fields = fill(next.config);
      setSessionText(fields.sessionText);
      setDailyText(fields.dailyText);
      setWarnText(fields.warnText);
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

  const save = (): void => {
    if (savingRef.current) return;
    const session = parseUsdInput(sessionText);
    if (session.error !== undefined) {
      setError(`Batas per sesi: ${session.error}`);
      return;
    }
    const daily = parseUsdInput(dailyText);
    if (daily.error !== undefined) {
      setError(`Batas per hari: ${daily.error}`);
      return;
    }
    const warn = parseWarnPercent(warnText);
    if (warn.error !== undefined) {
      setError(warn.error);
      return;
    }

    const patch = {
      sessionUsd: session.value ?? null,
      dailyUsd: daily.value ?? null,
      warnAt: warn.value ?? 0.8,
    };
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    void (async () => {
      try {
        await api.putBudget(patch);
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

  return (
    <section class="jk-budget" aria-labelledby="jk-budget-title">
      <h2 class="jk-budget-title" id="jk-budget-title">
        Budget
      </h2>
      <p class="jk-help">{NOTE}</p>

      {loading && <p class="jk-note">Memuat anggaran…</p>}

      {!loading && disabled && (
        <p class="jk-note">Budget dimatikan (JEJAK_BUDGET=0).</p>
      )}

      {!loading && !disabled && loadError !== undefined && (
        <p class="jk-error-line" role="alert">
          {loadError}
        </p>
      )}

      {!loading && !disabled && loadError === undefined && (
        <>
          <form class="jk-budget-form" onSubmit={onSubmit} aria-busy={saving}>
            <div class="jk-field-row">
              <div class="jk-field">
                <label class="jk-label" for="jk-budget-session">
                  Batas per sesi (USD)
                </label>
                <input
                  id="jk-budget-session"
                  class="jk-input jk-input-code"
                  type="text"
                  inputmode="decimal"
                  placeholder="Tanpa batas"
                  value={sessionText}
                  onInput={(event) => {
                    setSessionText((event.currentTarget as HTMLInputElement).value);
                    setSaved(false);
                  }}
                  aria-invalid={error !== undefined && error.startsWith("Batas per sesi")}
                  aria-describedby={error !== undefined ? "jk-budget-error" : undefined}
                />
              </div>
              <div class="jk-field">
                <label class="jk-label" for="jk-budget-daily">
                  Batas per hari (USD)
                </label>
                <input
                  id="jk-budget-daily"
                  class="jk-input jk-input-code"
                  type="text"
                  inputmode="decimal"
                  placeholder="Tanpa batas"
                  value={dailyText}
                  onInput={(event) => {
                    setDailyText((event.currentTarget as HTMLInputElement).value);
                    setSaved(false);
                  }}
                  aria-invalid={error !== undefined && error.startsWith("Batas per hari")}
                  aria-describedby={error !== undefined ? "jk-budget-error" : undefined}
                />
              </div>
              <div class="jk-field">
                <label class="jk-label" for="jk-budget-warn">
                  Peringatan di (%)
                </label>
                <input
                  id="jk-budget-warn"
                  class="jk-input jk-input-code"
                  type="text"
                  inputmode="numeric"
                  value={warnText}
                  onInput={(event) => {
                    setWarnText((event.currentTarget as HTMLInputElement).value);
                    setSaved(false);
                  }}
                  aria-invalid={error !== undefined && !error.startsWith("Batas per")}
                  aria-describedby={error !== undefined ? "jk-budget-error" : undefined}
                />
              </div>
            </div>

            <div class="jk-form-actions">
              <button type="submit" class="jk-button jk-button-primary" disabled={saving}>
                {saving ? "Menyimpan…" : "Simpan"}
              </button>
              <span class="jk-note">{saved ? "Tersimpan." : ""}</span>
            </div>
          </form>

          {error !== undefined && (
            <p class="jk-error-line" id="jk-budget-error" role="alert">
              {error}
            </p>
          )}

          {status !== undefined && <p class="jk-budget-line">{budgetLine(status)}</p>}
        </>
      )}
    </section>
  );
}
