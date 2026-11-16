import { contextUsage, reduceContext, type ContextState, type ContextUsage } from "./context";

/**
 * Bentuk event yang dipakai telemetri. Sengaja longgar supaya cocok dengan
 * `AgentEvent` milik server tanpa mengimpor tipenya, dan supaya event baru
 * tak langsung merusak perhitungan.
 */
export interface TelemetryEvent {
  type: string;
  id?: string;
  name?: string;
  parentToolUseId?: string;
  isError?: boolean;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  numTurns?: number;
  tokens?: number;
  window?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** Medan lain event diabaikan; ada supaya bentuk tak asing tetap diterima. */
  [key: string]: unknown;
}

/** Pemakaian satu alat di seluruh sesi. */
export interface TelemetryToolStat {
  /** Nama alat seperti yang dikirim model. */
  name: string;
  /** Jumlah alat dipanggil. */
  calls: number;
  /** Jumlah pemanggilan yang berakhir dengan galat. */
  errors: number;
}

/** Biaya sesi; `estimated` true bila angkanya perkiraan, bukan dari SDK. */
export interface TelemetryCost {
  /** Jumlah dolar. */
  usd: number;
  /** true bila hanya ada `estimatedCostUsd` (tanpa `costUsd`). */
  estimated: boolean;
}

/** Ringkasan telemetri satu sesi, dihitung dari event yang sama milik klien. */
export interface Telemetry {
  /** Pemakaian konteks saat ini; undefined bila belum ada data. */
  context?: ContextUsage;
  /** Token masuk dari seluruh event `result`. */
  inputTokens: number;
  /** Token keluar dari seluruh event `result`. */
  outputTokens: number;
  /** Token dibaca dari cache. */
  cacheReadTokens: number;
  /** Token ditulis ke cache. */
  cacheWriteTokens: number;
  /** Jumlah giliran model (jumlah `numTurns`). */
  numTurns: number;
  /** Biaya sesi; undefined bila tak ada event `result` yang menyebut biaya. */
  cost?: TelemetryCost;
  /** Hitungan per alat, urut terbanyak; dibatasi {@link MAX_TELEMETRY_TOOLS}. */
  tools: TelemetryToolStat[];
  /** Jumlah nama alat di luar baris yang ditampilkan. */
  otherTools: number;
  /** Jumlah pemanggilan alat yang dilakukan subagen. */
  subagentCalls: number;
  /** Jumlah pesan pengguna. */
  userMessages: number;
  /** Jumlah hasil sukses. */
  resultsOk: number;
  /** Jumlah hasil gagal. */
  resultsFailed: number;
}

/** Batas baris tabel alat; sisanya diringkas jadi "dan N lainnya". */
export const MAX_TELEMETRY_TOOLS = 12;

interface CallRecord {
  name: string;
  id?: string;
}

/**
 * Hitung telemetri satu sesi dari event mentahnya.
 *
 * Konteks memakai `reduceContext`/`contextUsage` yang sama dengan komposer,
 * jadi angkanya sama dengan cincin penggunaan di bawah kolom pesan. Biaya,
 * token, dan giliran dijumlah dari event `result`; alat dari event
 * `tool_call` dengan galat dipasangkan lewat `id` event `tool_result`.
 */
export function computeTelemetry(events: ReadonlyArray<TelemetryEvent>): Telemetry {
  let contextState: ContextState | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let numTurns = 0;
  let costUsd = 0;
  let biayaSd = false;
  let estimatedUsd = 0;
  let adaPerkiraan = false;
  let userMessages = 0;
  let resultsOk = 0;
  let resultsFailed = 0;
  let subagentCalls = 0;
  const calls: CallRecord[] = [];
  const idGalat = new Set<string>();

  for (const event of events) {
    contextState = reduceContext(contextState, event);

    if (event.type === "result") {
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
      cacheReadTokens += event.cacheReadTokens ?? 0;
      cacheWriteTokens += event.cacheWriteTokens ?? 0;
      numTurns += event.numTurns ?? 0;
      if (event.costUsd !== undefined) {
        costUsd += event.costUsd;
        biayaSd = true;
      }
      if (event.estimatedCostUsd !== undefined) {
        estimatedUsd += event.estimatedCostUsd;
        adaPerkiraan = true;
      }
      if (event.ok === true) resultsOk += 1;
      else resultsFailed += 1;
    } else if (event.type === "tool_call") {
      const name = event.name ?? "(tanpa nama)";
      calls.push(event.id === undefined ? { name } : { name, id: event.id });
      if (event.parentToolUseId !== undefined) subagentCalls += 1;
    } else if (event.type === "tool_result") {
      if (event.isError === true && event.id !== undefined) idGalat.add(event.id);
    } else if (event.type === "user_message") {
      userMessages += 1;
    }
  }

  const perTool = new Map<string, { calls: number; errors: number }>();
  for (const call of calls) {
    const galat = call.id !== undefined && idGalat.has(call.id) ? 1 : 0;
    const entry = perTool.get(call.name);
    if (entry === undefined) perTool.set(call.name, { calls: 1, errors: galat });
    else {
      entry.calls += 1;
      entry.errors += galat;
    }
  }

  const semua = [...perTool.entries()]
    .map(([name, stat]) => ({ name, calls: stat.calls, errors: stat.errors }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const tools = semua.slice(0, MAX_TELEMETRY_TOOLS);

  let cost: TelemetryCost | undefined;
  if (biayaSd) cost = { usd: costUsd, estimated: false };
  else if (adaPerkiraan) cost = { usd: estimatedUsd, estimated: true };

  const context = contextUsage(contextState);
  return {
    ...(context === undefined ? {} : { context }),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    numTurns,
    ...(cost === undefined ? {} : { cost }),
    tools,
    otherTools: semua.length - tools.length,
    subagentCalls,
    userMessages,
    resultsOk,
    resultsFailed,
  };
}
