import { formatTokens } from "../lib/context";
import { formatCount, formatCost } from "../lib/format";
import type { Telemetry } from "../lib/telemetry";
import { CopyButton } from "./CopyButton";

export interface ContextTabProps {
  /** Telemetri sesi; dihitung dari event sesi yang sudah ada di klien. */
  telemetry: Telemetry;
  /** Model aktif sesi (dari SessionInfo). */
  model?: string;
  /** Id profil provider aktif (dari SessionInfo). */
  profileId?: string;
}

const EMPTY_CONTEXT = "Belum ada data konteks.";
const EMPTY_TOOLS = "Belum ada penggunaan alat.";

/** Dua kolom label dan nilai; dipakai untuk ringkasan angka. */
function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <table class="jk-ctx-table">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td class="jk-ctx-num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Ringkasan teks ringkas untuk tombol salin. */
export function telemetrySummary(
  telemetry: Telemetry,
  model?: string,
  profileId?: string,
): string {
  const lines: string[] = [];
  const context = telemetry.context;
  if (context === undefined) {
    lines.push(`Konteks: ${EMPTY_CONTEXT.toLowerCase()}`);
  } else {
    const jendela =
      context.window === undefined ? "" : ` dari ${formatTokens(context.window)}`;
    const persen = context.percent === undefined ? "" : ` (${context.percent}%)`;
    lines.push(`Konteks: ${formatTokens(context.tokens)}${jendela} token${persen}`);
  }
  lines.push(
    `Token: ${formatCount(telemetry.inputTokens)} masuk, ${formatCount(telemetry.outputTokens)} keluar, ` +
      `${formatCount(telemetry.cacheReadTokens)} dibaca cache, ${formatCount(telemetry.cacheWriteTokens)} ditulis cache`,
  );
  lines.push(`Giliran model: ${formatCount(telemetry.numTurns)}`);
  if (telemetry.cost !== undefined) {
    const label = telemetry.cost.estimated ? "Biaya (perkiraan)" : "Biaya";
    lines.push(`${label}: ${formatCost(telemetry.cost.usd)}`);
  }
  const alat = telemetry.tools
    .slice(0, 3)
    .map((tool) => `${tool.name} (${formatCount(tool.calls)})`)
    .join(", ");
  if (alat !== "") lines.push(`Alat teratas: ${alat}`);
  if (model !== undefined && model !== "") lines.push(`Model: ${model}`);
  if (profileId !== undefined && profileId !== "") lines.push(`Profil: ${profileId}`);
  return lines.join("\n");
}

/**
 * Tab Konteks: telemetri satu sesi (konteks, pemakaian, alat, giliran).
 *
 * Komponen murni: hanya menerima data, tanpa hook dan tanpa permintaan
 * jaringan. Perhitungannya sudah selesai di `lib/telemetry`.
 */
export function ContextTab({ telemetry, model, profileId }: ContextTabProps) {
  const context = telemetry.context;
  const persen = context?.percent;

  return (
    <div class="jk-panel-body jk-ctx-tab">
      <section class="jk-ctx-block">
        <h3 class="jk-ctx-title">Konteks</h3>
        {context === undefined ? (
          <p class="jk-panel-note">{EMPTY_CONTEXT}</p>
        ) : (
          <>
            <p class="jk-ctx-line">
              {formatTokens(context.tokens)} token
              {context.window === undefined
                ? ""
                : ` dari ${formatTokens(context.window)}`}
              {persen === undefined ? "" : ` (${persen}%)`}
            </p>
            {persen !== undefined && (
              <div
                class={`jk-ctx-bar jk-ctx-${context.level}`}
                role="img"
                aria-label={`Konteks terpakai ${persen}%`}
              >
                <span class="jk-ctx-bar-fill" style={{ width: `${persen}%` }} />
              </div>
            )}
          </>
        )}
      </section>

      <section class="jk-ctx-block">
        <h3 class="jk-ctx-title">Pemakaian</h3>
        <Facts
          rows={[
            ["Token masuk", formatCount(telemetry.inputTokens)],
            ["Token keluar", formatCount(telemetry.outputTokens)],
            ["Cache baca", formatCount(telemetry.cacheReadTokens)],
            ["Cache tulis", formatCount(telemetry.cacheWriteTokens)],
            ["Giliran model", formatCount(telemetry.numTurns)],
            [
              telemetry.cost?.estimated === true ? "Biaya (perkiraan)" : "Biaya",
              telemetry.cost === undefined ? "–" : formatCost(telemetry.cost.usd),
            ],
          ]}
        />
      </section>

      <section class="jk-ctx-block">
        <h3 class="jk-ctx-title">Alat</h3>
        {telemetry.tools.length === 0 ? (
          <p class="jk-panel-note">{EMPTY_TOOLS}</p>
        ) : (
          <>
            <table class="jk-ctx-table">
              <thead>
                <tr>
                  <th scope="col">Alat</th>
                  <th scope="col">Dipanggil</th>
                  <th scope="col">Galat</th>
                </tr>
              </thead>
              <tbody>
                {telemetry.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td>{tool.name}</td>
                    <td class="jk-ctx-num">{formatCount(tool.calls)}</td>
                    <td class="jk-ctx-num">{formatCount(tool.errors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {telemetry.otherTools > 0 && (
              <p class="jk-panel-note">dan {formatCount(telemetry.otherTools)} lainnya</p>
            )}
            {telemetry.subagentCalls > 0 && (
              <p class="jk-panel-note">
                oleh subagen: {formatCount(telemetry.subagentCalls)}
              </p>
            )}
          </>
        )}
      </section>

      <section class="jk-ctx-block">
        <h3 class="jk-ctx-title">Giliran</h3>
        <Facts
          rows={[
            ["Pesan pengguna", formatCount(telemetry.userMessages)],
            ["Hasil sukses", formatCount(telemetry.resultsOk)],
            ["Hasil gagal", formatCount(telemetry.resultsFailed)],
            ["Model", model === undefined || model === "" ? "–" : model],
            ["Profil", profileId === undefined || profileId === "" ? "–" : profileId],
          ]}
        />
      </section>

      <div class="jk-ctx-foot">
        <CopyButton
          text={() => telemetrySummary(telemetry, model, profileId)}
          label="Salin ringkasan"
        />
      </div>
    </div>
  );
}
