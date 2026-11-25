/**
 * Agent ACP palsu untuk tes. Membaca JSON-RPC per baris dari stdin dan
 * berperilaku sesuai `FAKE_ACP_MODE`.
 */
const mode = process.env.FAKE_ACP_MODE ?? "ok";

function send(pesan: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(pesan)}\n`);
}

interface Balasan {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let idAgent = 100;
const tertunda = new Map<number, (balasan: Balasan) => void>();
/** Prompt mode `hang` yang belum dijawab, per sesi. */
const promptTertunda = new Map<string, number>();
/** Urutan prompt pada proses ini (mode `multi`). */
let jumlahPrompt = 0;

/** Kirim request dari agent ke klien dan tunggu balasannya. */
function minta(method: string, params: unknown): Promise<Balasan> {
  const id = idAgent++;
  return new Promise((resolve) => {
    tertunda.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function kirimUpdate(update: Record<string, unknown>): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update },
  });
}

function kirimTeksChunk(sessionUpdate: string, text: string): void {
  kirimUpdate({ sessionUpdate, content: { type: "text", text } });
}

/** Mode `rich`: seluruh urutan update + satu permintaan izin. */
async function tanganiPromptRich(id: number): Promise<void> {
  kirimTeksChunk("agent_thought_chunk", "pikir");
  kirimTeksChunk("agent_message_chunk", "ha");
  kirimTeksChunk("agent_message_chunk", "lo");
  kirimUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Edit a.txt",
    kind: "edit",
    rawInput: { path: "a.txt" },
  });

  const balasan = await minta("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Edit a.txt", kind: "edit", rawInput: { path: "a.txt" } },
    options: [
      { optionId: "ya-sekali", name: "Ya sekali", kind: "allow_once" },
      { optionId: "ya-selalu", name: "Ya selalu", kind: "allow_always" },
      { optionId: "tidak", name: "Tidak", kind: "reject_once" },
    ],
  });
  let dipilih = "cancelled";
  const outcome = balasan.result?.outcome;
  if (typeof outcome === "object" && outcome !== null) {
    const data = outcome as Record<string, unknown>;
    if (data.outcome === "selected" && typeof data.optionId === "string") dipilih = data.optionId;
  }

  kirimUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "selesai" } }],
  });
  kirimUpdate({ sessionUpdate: "usage_update", used: 120, size: 1000 });
  kirimTeksChunk("agent_message_chunk", `dipilih:${dipilih}`);
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

async function tanganiPrompt(msg: Record<string, unknown>): Promise<void> {
  const id = msg.id as number;

  if (mode === "rich") {
    await tanganiPromptRich(id);
    return;
  }

  if (mode === "multi") {
    jumlahPrompt += 1;
    kirimTeksChunk("agent_message_chunk", `giliran-${jumlahPrompt}:${process.pid}`);
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (mode === "hang") {
    // Tidak dijawab sampai klien mengirim session/cancel.
    promptTertunda.set("s1", id);
    return;
  }

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "halo dari agent palsu" },
      },
    },
  });

  let stopReason = "end_turn";
  if (mode === "ok") {
    const balasan = await minta("session/request_permission", {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Tulis berkas" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = balasan.result?.outcome;
    if (typeof outcome === "object" && outcome !== null) {
      const data = outcome as Record<string, unknown>;
      stopReason = data.outcome === "selected" ? `end_turn:${String(data.optionId)}` : "cancelled";
    } else {
      stopReason = "cancelled";
    }
  } else if (mode === "unknown-method") {
    const balasan = await minta("fs/read_text_file", { sessionId: "s1", path: "README.md" });
    stopReason = `end_turn:${String(balasan.error?.code)}`;
  }

  send({ jsonrpc: "2.0", id, result: { stopReason } });
}

function tanganiRequest(msg: Record<string, unknown>, method: string): void {
  const id = msg.id as number;
  const balas = (isi: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", id, ...isi });
  };

  if (method === "initialize") {
    balas({
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "oauth-personal", name: "Google" }],
        agentCapabilities: { loadSession: false },
      },
    });
    return;
  }

  if (method === "session/new") {
    if (mode === "exit") {
      // Keluar tanpa menjawab, meninggalkan request klien menggantung.
      process.exit(3);
    }    if (mode === "auth") {
      balas({ error: { code: -32000, message: "Authentication required" } });
      return;
    }
    if (mode === "slow") return; // tidak pernah menjawab
    if (mode === "models") {
      balas({
        result: {
          sessionId: "s1",
          configOptions: [
            {
              id: "model",
              category: "model",
              options: [
                { optionId: "model-a", name: "Model A" },
                { optionId: "model-b", name: "Model B" },
              ],
            },
            { id: "mode", category: "mode" },
          ],
        },
      });
      return;
    }
    balas({ result: { sessionId: "s1", configOptions: [] } });
    return;
  }

  if (method === "session/prompt") {
    void tanganiPrompt(msg);
    return;
  }

  balas({ error: { code: -32601, message: "Method not found" } });
}

function tanganiBaris(baris: string): void {
  if (baris.trim() === "") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(baris) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof msg.method === "string") {
    if (msg.method === "session/cancel") {
      // Mode `hang`: cancel menjawab prompt yang tertunda.
      const params = msg.params;
      const sid =
        typeof params === "object" && params !== null
          ? String((params as Record<string, unknown>).sessionId ?? "s1")
          : "s1";
      const promptId = promptTertunda.get(sid);
      if (promptId !== undefined) {
        promptTertunda.delete(sid);
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      }
      return;
    }
    if (msg.id !== undefined && msg.id !== null) tanganiRequest(msg, msg.method);
    return; // notifikasi dari klien diabaikan
  }
  const id = msg.id;
  if (typeof id !== "number") return;
  const tunggu = tertunda.get(id);
  if (!tunggu) return;
  tertunda.delete(id);
  tunggu(msg as unknown as Balasan);
}

if (mode === "noisy") {
  process.stdout.write("plugin: memuat konfigurasi (baris log biasa)\n");
}

const decoder = new TextDecoder();
let buffer = "";
const pembaca = Bun.stdin.stream().getReader();

while (true) {
  const { value, done } = await pembaca.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const baris = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    tanganiBaris(baris);
    index = buffer.indexOf("\n");
  }
}

export {};
