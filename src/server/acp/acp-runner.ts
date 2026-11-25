/**
 * AcpRunner: menjalankan satu giliran lewat agent ACP (mis. `agy acp`) lalu
 * menerjemahkan update ACP menjadi `AgentEvent`. Runner tidak tahu agent mana
 * pun; perintah dan petunjuk datang dari `AcpAgentDef`.
 *
 * Isi prompt, env, dan teks agent tidak pernah dicatat ke log di sini.
 */
import {
  AcpClient,
  AcpError,
  spawnTransport,
  type AcpUpdate,
  type PermissionRequest as AcpPermissionRequest,
} from "./acp-client";
import type { AcpAgentDef } from "./agent-defs";
import type { AgentEvent, AgentRunner, RunInput } from "../agent/events";

export interface AcpRunnerDeps {
  spawnTransport?: typeof spawnTransport;
  /** Variabel lingkungan tambahan; diteruskan ke `spawnTransport`. */
  env?: Record<string, string>;
  /** Jeda sebelum proses sesi ditutup setelah giliran selesai. */
  idleMs?: number;
  /** Batas waktu `initialize`/`session/new`. */
  requestTimeoutMs?: number;
}

export interface AcpRunner extends AgentRunner {
  /** Tutup proses untuk sesi ACP ini (mis. saat sesi Jejak dihapus). Aman dipanggil berulang. */
  release(acpSessionId: string): void;
  /** Tutup semua proses hidup (saat server berhenti). */
  dispose(): void;
}

const IDLE_BAWAAN_MS = 600_000;
const TIMEOUT_PERMINTAAN_BAWAAN_MS = 60_000;
const BATAS_PESAN_GALAT = 300;
const BATAS_RINGKASAN = 4_000;
const BATAS_KELUARAN_TOOL = 20_000;
const BATAS_TUNGGU_BATAL_MS = 3_000;
const POLA_RAHASIA = /(key|token|secret|password)\s*[=:]\s*\S+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pesanGalat(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Buang string mirip rahasia lalu potong panjangnya. */
function samarkan(teks: string): string {
  return teks.replace(POLA_RAHASIA, "$1=[disamarkan]").slice(0, BATAS_PESAN_GALAT);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const t = timer as unknown as { unref?: () => void };
  t.unref?.();
}

function tunggu(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function teksDariKonten(content: unknown): string | undefined {
  if (!isRecord(content) || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

/** Nama tampilan tool dari objek toolCall ACP (`title`, lalu `kind`, lalu "tool"). */
function namaTool(toolCall: Record<string, unknown>): string {
  if (typeof toolCall.title === "string" && toolCall.title !== "") return toolCall.title;
  if (typeof toolCall.kind === "string" && toolCall.kind !== "") return toolCall.kind;
  return "tool";
}

interface Sink {
  handleUpdate(u: AcpUpdate): void;
  flush(): void;
  teksTerakhir(): string;
}

/** Penerjemah `session/update` satu giliran menjadi event; buffer teks per blok. */
function buatSink(push: (e: AgentEvent) => void): Sink {
  let pesan = "";
  let pikiran = "";
  let terakhir = "";
  let counter = 0;
  const toolDikenal = new Set<string>();

  const flushPikiran = (): void => {
    if (pikiran === "") return;
    const teks = pikiran;
    pikiran = "";
    push({ type: "thinking", text: teks });
  };

  const flushPesan = (): void => {
    if (pesan === "") return;
    const teks = pesan;
    pesan = "";
    terakhir = teks;
    push({ type: "text", text: teks });
  };

  function keluaranTool(raw: Record<string, unknown>): string {
    const bagian: string[] = [];
    if (Array.isArray(raw.content)) {
      for (const item of raw.content) {
        if (!isRecord(item) || item.type !== "content") continue;
        const teks = teksDariKonten(item.content);
        if (teks !== undefined) bagian.push(teks);
      }
    }
    let hasil = bagian.join("\n");
    if (hasil === "" && raw.rawOutput !== undefined) {
      try {
        hasil = JSON.stringify(raw.rawOutput);
      } catch {
        hasil = String(raw.rawOutput);
      }
    }
    return hasil.slice(0, BATAS_KELUARAN_TOOL);
  }

  function handleUpdate(u: AcpUpdate): void {
    const raw = isRecord(u.raw) ? u.raw : {};
    switch (u.kind) {
      case "agent_message_chunk": {
        flushPikiran();
        const teks = teksDariKonten(raw.content);
        if (teks !== undefined && teks !== "") {
          pesan += teks;
          push({ type: "text_delta", text: teks });
        }
        return;
      }
      case "agent_thought_chunk": {
        flushPesan();
        const teks = teksDariKonten(raw.content);
        if (teks !== undefined) pikiran += teks;
        return;
      }
      case "tool_call": {
        flushPikiran();
        flushPesan();
        const id =
          typeof raw.toolCallId === "string" && raw.toolCallId !== ""
            ? raw.toolCallId
            : `acp-${(counter += 1)}`;
        toolDikenal.add(id);
        push({ type: "tool_call", id, name: namaTool(raw), input: raw.rawInput ?? {} });
        return;
      }
      case "tool_call_update": {
        const id = typeof raw.toolCallId === "string" ? raw.toolCallId : "";
        const status = typeof raw.status === "string" ? raw.status : "";
        // Id tak dikenal dan status selain completed/failed diabaikan.
        if (id === "" || !toolDikenal.has(id)) return;
        if (status !== "completed" && status !== "failed") return;
        flushPikiran();
        flushPesan();
        push({ type: "tool_result", id, output: keluaranTool(raw), isError: status === "failed" });
        return;
      }
      case "usage_update": {
        flushPikiran();
        flushPesan();
        const used = raw.used;
        const size = raw.size;
        if (typeof used === "number" && typeof size === "number") {
          push({ type: "context", tokens: used, window: size });
        }
        return;
      }
      case "plan": {
        flushPikiran();
        flushPesan();
        const langkah = Array.isArray(raw.entries)
          ? raw.entries.length
          : Array.isArray(raw.plan)
            ? raw.plan.length
            : 0;
        push({ type: "notice", text: `Rencana agent: ${langkah} langkah`, level: "info" });
        return;
      }
      default:
        // user_message_chunk, available_commands_update, current_mode_update, dll.
        flushPikiran();
        flushPesan();
        return;
    }
  }

  return {
    handleUpdate,
    flush(): void {
      flushPikiran();
      flushPesan();
    },
    teksTerakhir(): string {
      return terakhir;
    },
  };
}

interface Turn {
  input: RunInput;
  sink: Sink;
  push: (e: AgentEvent) => void;
}

interface Sesi {
  client: AcpClient;
  hidup: boolean;
  exitCode?: number | null;
  timer?: ReturnType<typeof setTimeout>;
  turn?: Turn;
}

interface Antrean {
  push: (e: AgentEvent) => void;
  tutup: () => void;
  iterate: () => AsyncGenerator<AgentEvent>;
}

/** Antrean event + promise: jembatan callback klien ke iterasi async. */
function buatAntrean(): Antrean {
  const antrean: AgentEvent[] = [];
  let bangun: (() => void) | undefined;
  let selesai = false;

  const push = (e: AgentEvent): void => {
    antrean.push(e);
    const r = bangun;
    bangun = undefined;
    r?.();
  };
  const tutup = (): void => {
    selesai = true;
    const r = bangun;
    bangun = undefined;
    r?.();
  };
  async function* iterate(): AsyncGenerator<AgentEvent> {
    while (true) {
      const ev = antrean.shift();
      if (ev !== undefined) {
        yield ev;
        continue;
      }
      if (selesai) return;
      await new Promise<void>((resolve) => {
        bangun = resolve;
      });
    }
  }
  return { push, tutup, iterate };
}

function janjiBatal(signal: AbortSignal): { promise: Promise<void>; bersihkan: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(), bersihkan: () => {} };
  let handler: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    handler = () => resolve();
    signal.addEventListener("abort", handler, { once: true });
  });
  const terpasang = handler;
  return {
    promise,
    bersihkan: () => {
      if (terpasang !== undefined) signal.removeEventListener("abort", terpasang);
    },
  };
}

export function createAcpRunner(def: AcpAgentDef, deps?: AcpRunnerDeps): AcpRunner {
  const spawn = deps?.spawnTransport ?? spawnTransport;
  const env = deps?.env;
  const idleMs = deps?.idleMs ?? IDLE_BAWAAN_MS;
  const requestTimeoutMs = deps?.requestTimeoutMs ?? TIMEOUT_PERMINTAAN_BAWAAN_MS;
  const sesiMap = new Map<string, Sesi>();

  function releaseSesi(id: string): void {
    const sesi = sesiMap.get(id);
    if (sesi === undefined) return;
    sesiMap.delete(id);
    sesi.hidup = false;
    if (sesi.timer !== undefined) {
      clearTimeout(sesi.timer);
      sesi.timer = undefined;
    }
    try {
      sesi.client.close();
    } catch {
      // Sudah tertutup.
    }
  }

  function jadwalkanIdle(id: string, sesi: Sesi): void {
    if (sesi.timer !== undefined) clearTimeout(sesi.timer);
    const timer = setTimeout(() => {
      sesi.timer = undefined;
      if (sesiMap.get(id) === sesi) releaseSesi(id);
    }, idleMs);
    unrefTimer(timer);
    sesi.timer = timer;
  }

  function pilihOpsi(opsi: AcpPermissionRequest["options"], kind: string): string | undefined {
    return opsi.find((o) => o.kind === kind)?.optionId;
  }

  function pesanUntukGalat(error: unknown, sesi: Sesi | undefined): string {
    if (error instanceof AcpError && error.needsAuth) {
      return `${def.label} belum login. ${def.loginHint}`;
    }
    const mentah = pesanGalat(error);
    if (sesi?.exitCode === 127 || /kode 127/.test(mentah)) {
      return `${def.label} tidak terpasang. ${def.installHint}`;
    }
    return samarkan(mentah);
  }

  async function tanganiIzin(
    sesi: Sesi | undefined,
    params: AcpPermissionRequest,
  ): Promise<{ optionId: string } | "cancelled"> {
    const turn = sesi?.turn;
    const input = turn?.input;
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
    const title = namaTool(toolCall);
    const rawInput = toolCall.rawInput ?? {};
    const mode = input?.permissionMode;

    const tolak = (): { optionId: string } | "cancelled" => {
      const sekali = pilihOpsi(params.options, "reject_once");
      if (sekali !== undefined) return { optionId: sekali };
      const selalu = pilihOpsi(params.options, "reject_always");
      if (selalu !== undefined) return { optionId: selalu };
      return "cancelled";
    };
    const izinkan = (): { optionId: string } | "cancelled" => {
      // Jangan pernah memilih allow_always bila allow_once tersedia.
      const sekali = pilihOpsi(params.options, "allow_once");
      if (sekali !== undefined) return { optionId: sekali };
      const selalu = pilihOpsi(params.options, "allow_always");
      if (selalu !== undefined) return { optionId: selalu };
      return tolak();
    };

    if (mode === "plan") {
      turn?.push({ type: "notice", text: `Mode rencana: aksi ${title} ditolak`, level: "info" });
      const sekali = pilihOpsi(params.options, "reject_once");
      return sekali !== undefined ? { optionId: sekali } : "cancelled";
    }

    if (mode === "acceptEdits" && typeof toolCall.kind === "string" && toolCall.kind === "edit") {
      return izinkan();
    }

    // "default", undefined, DAN "bypassPermissions" selalu tanya pengguna.
    // Mode bypass TIDAK PERNAH melewati kartu izin untuk agent ACP (keputusan
    // keamanan: agent eksternal di luar kendali Jejak).
    const handler = input?.requestPermission;
    if (handler === undefined) return tolak();
    const signal = input?.signal;
    if (signal?.aborted === true) return "cancelled";
    try {
      const keputusan = await handler(
        { toolUseId: toolCallId, name: title, input: rawInput },
        signal ?? new AbortController().signal,
      );
      return keputusan.behavior === "allow" ? izinkan() : tolak();
    } catch {
      return "cancelled";
    }
  }

  function buatKlien(input: RunInput): Sesi {
    const transport = spawn(def.command, input.cwd, env);
    let sesiRef: Sesi | undefined;
    const client = new AcpClient(transport, {
      requestTimeoutMs,
      onUpdate: (u) => {
        sesiRef?.turn?.sink.handleUpdate(u);
      },
      onExit: (code) => {
        if (sesiRef === undefined) return;
        sesiRef.hidup = false;
        sesiRef.exitCode = code;
        for (const [id, value] of sesiMap) {
          if (value === sesiRef) sesiMap.delete(id);
        }
      },
      onPermission: (params) => tanganiIzin(sesiRef, params),
    });
    const sesi: Sesi = { client, hidup: true };
    sesiRef = sesi;
    return sesi;
  }

  async function jalankanGiliran(
    input: RunInput,
    push: (e: AgentEvent) => void,
    tutup: () => void,
  ): Promise<void> {
    const signal = input.signal;
    let sesi: Sesi | undefined;
    let sid = "";
    let sink: Sink | undefined;
    let onAbort: (() => void) | undefined;
    let batal: { promise: Promise<void>; bersihkan: () => void } | undefined;

    try {
      // 1. Pilih sesi: pakai proses hidup bila resume cocok.
      const resumeId = input.resumeSessionId;
      let notice: string | undefined;
      if (resumeId !== undefined) {
        const ada = sesiMap.get(resumeId);
        if (ada !== undefined && ada.hidup) {
          sesi = ada;
          sid = resumeId;
        } else {
          notice = "Sesi agent sebelumnya sudah berhenti; konteks percakapan dimulai ulang.";
        }
      }

      if (sesi === undefined) {
        sesi = buatKlien(input);
        await sesi.client.initialize();
        const baru = await sesi.client.newSession(input.cwd);
        sid = baru.sessionId;
        sesiMap.set(sid, sesi);
      }

      // Giliran baru membatalkan timer idle lama.
      if (sesi.timer !== undefined) {
        clearTimeout(sesi.timer);
        sesi.timer = undefined;
      }

      push({ type: "session", sessionId: sid });
      if (notice !== undefined) push({ type: "notice", text: notice, level: "warn" });
      if (input.noTools === true) {
        push({
          type: "notice",
          text: "Agent ACP tidak bisa dibatasi tanpa tool; permintaan noTools diabaikan.",
          level: "warn",
        });
      }

      const sinkAktif = buatSink(push);
      sink = sinkAktif;
      sesi.turn = { input, sink: sinkAktif, push };

      // 5. Abort: kirim cancel, tunggu prompt (maks 3 dtk), lalu tutup proses.
      onAbort = (): void => {
        try {
          sesi?.client.cancel(sid);
        } catch {
          // Proses mungkin sudah tertutup.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      batal = signal !== undefined ? janjiBatal(signal) : undefined;

      // 4. Prompt.
      const janjiPrompt = sesi.client.prompt(sid, input.prompt);
      let stopReason: string;
      if (batal !== undefined) {
        const hasil = await Promise.race([
          janjiPrompt
            .then((v) => ({ jenis: "selesai" as const, v }))
            .catch((e: unknown) => ({ jenis: "galat" as const, e })),
          batal.promise.then(() => ({ jenis: "batal" as const })),
        ]);
        if (hasil.jenis === "batal") {
          await Promise.race([janjiPrompt.catch(() => undefined), tunggu(BATAS_TUNGGU_BATAL_MS)]);
          releaseSesi(sid);
          sinkAktif.flush();
          push({ type: "result", ok: false, error: "dibatalkan" });
          return;
        }
        if (hasil.jenis === "galat") throw hasil.e;
        stopReason = hasil.v.stopReason;
      } else {
        stopReason = (await janjiPrompt).stopReason;
      }

      sinkAktif.flush();
      if (stopReason === "cancelled") {
        push({ type: "result", ok: false, error: "dibatalkan" });
      } else {
        push({
          type: "result",
          ok: stopReason !== "refusal",
          summary: sinkAktif.teksTerakhir().slice(0, BATAS_RINGKASAN),
        });
      }
      jadwalkanIdle(sid, sesi);
    } catch (error) {
      if (sesi !== undefined) {
        if (sid !== "") {
          releaseSesi(sid);
        } else {
          sesi.hidup = false;
          try {
            sesi.client.close();
          } catch {
            // Sudah tertutup.
          }
        }
      }
      push({ type: "error", message: pesanUntukGalat(error, sesi) });
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      batal?.bersihkan();
      if (sesi !== undefined && sink !== undefined && sesi.turn?.sink === sink) {
        sesi.turn = undefined;
      }
      tutup();
    }
  }

  return {
    run(input: RunInput): AsyncIterable<AgentEvent> {
      return (async function* (): AsyncGenerator<AgentEvent> {
        if (input.signal?.aborted === true) {
          yield { type: "result", ok: false, error: "dibatalkan" };
          return;
        }
        const antrean = buatAntrean();
        void jalankanGiliran(input, antrean.push, antrean.tutup).catch(() => {
          antrean.tutup();
        });
        for await (const ev of antrean.iterate()) yield ev;
      })();
    },
    release(id: string): void {
      releaseSesi(id);
    },
    dispose(): void {
      for (const id of Array.from(sesiMap.keys())) releaseSesi(id);
    },
  };
}
