import { expect, test } from "bun:test";
import type { AgentEvent } from "../src/server/agent/events";
import { createMockRunner } from "../src/server/agent/mock-runner";

const PROVIDER = { profileId: "test" };

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function baseInput(signal?: AbortSignal) {
  return { prompt: "halo", cwd: "/tmp", provider: PROVIDER, signal };
}

test("skrip default menghasilkan urutan event demo dengan satu result", async () => {
  const events = await collect(createMockRunner().run(baseInput()));

  expect(events.map((event) => event.type)).toEqual([
    "session",
    "thinking",
    "text",
    "tool_call",
    "tool_result",
    "text",
    "result",
  ]);

  const session = events[0]!;
  expect(session.type).toBe("session");
  if (session.type === "session") {
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);
  }

  const toolCall = events[3]!;
  if (toolCall.type === "tool_call") {
    expect(toolCall.name).toBe("Read");
  }

  const result = events[events.length - 1]!;
  expect(result.type).toBe("result");
  if (result.type === "result") {
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(typeof result.inputTokens).toBe("number");
    expect(typeof result.outputTokens).toBe("number");
  }

  expect(events.filter((event) => event.type === "result")).toHaveLength(1);
});

test("skrip kustom dipakai apa adanya bila sudah memuat result", async () => {
  const script: AgentEvent[] = [
    { type: "text", text: "satu" },
    { type: "result", ok: false, error: "gagal kustom" },
  ];

  const events = await collect(createMockRunner({ script }).run(baseInput()));

  expect(events).toEqual(script);
});

test("skrip kustom tanpa result mendapat result ok:true di akhir", async () => {
  const events = await collect(
    createMockRunner({ script: [{ type: "text", text: "satu" }] }).run(baseInput()),
  );

  expect(events).toHaveLength(2);
  expect(events[0]).toEqual({ type: "text", text: "satu" });
  expect(events[1]!.type).toBe("result");
  if (events[1]!.type === "result") {
    expect(events[1]!.ok).toBe(true);
  }
});

test("abort di tengah menghentikan skrip dengan error dan tepat satu result", async () => {
  const controller = new AbortController();
  const script: AgentEvent[] = Array.from({ length: 10 }, (_, index) => ({
    type: "text",
    text: `bagian-${index}`,
  }));

  const events: AgentEvent[] = [];
  for await (const event of createMockRunner({ script }).run(baseInput(controller.signal))) {
    events.push(event);
    if (events.length === 1) controller.abort();
  }

  expect(events).toHaveLength(3);
  expect(events[0]).toEqual({ type: "text", text: "bagian-0" });
  expect(events[1]).toEqual({ type: "error", message: "dibatalkan" });
  expect(events[2]).toEqual({ type: "result", ok: false, error: "dibatalkan" });
  expect(events.filter((event) => event.type === "result")).toHaveLength(1);
});

test("signal yang sudah aborted langsung menghasilkan error dan satu result", async () => {
  const controller = new AbortController();
  controller.abort();

  const events = await collect(createMockRunner().run(baseInput(controller.signal)));

  expect(events).toEqual([
    { type: "error", message: "dibatalkan" },
    { type: "result", ok: false, error: "dibatalkan" },
  ]);
});

test("resumeSessionId diterima dan skrip tetap berjalan dengan event session", async () => {
  const events = await collect(
    createMockRunner().run({ ...baseInput(), resumeSessionId: "s-lama" }),
  );

  expect(events[0]?.type).toBe("session");
  const session = events[0]!;
  if (session.type === "session") {
    expect(typeof session.sessionId).toBe("string");
  }
  expect(events[events.length - 1]?.type).toBe("result");
});

interface MemoryCall {
  name: string;
  args: unknown;
}

function fakeMemory(): {
  memory: {
    indexLine: string;
    call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>;
  };
  calls: MemoryCall[];
} {
  const calls: MemoryCall[] = [];
  return {
    calls,
    memory: {
      indexLine: "Jejak menyimpan memory.",
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "memory_search") {
          return { text: "Data memory:\n- [profile/confirmed] Gaya: singkat", isError: false };
        }
        return { text: "Usulan dicatat dan menunggu persetujuan pengguna.", isError: false };
      },
    },
  };
}

test("[memori] memanggil memory_search dan mengeluarkan tool_call + tool_result", async () => {
  const { memory, calls } = fakeMemory();
  const events = await collect(
    createMockRunner().run({ ...baseInput(), prompt: "[memori] gaya jawaban", memory }),
  );

  expect(calls).toEqual([{ name: "memory_search", args: { query: "gaya jawaban" } }]);
  expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "result"]);

  const call = events[0]!;
  expect(call.type).toBe("tool_call");
  if (call.type === "tool_call") {
    expect(call.name).toBe("mcp__jejak-memory__memory_search");
    expect(call.input).toEqual({ query: "gaya jawaban" });
  }
  const result = events[1]!;
  expect(result.type).toBe("tool_result");
  if (result.type === "tool_result") {
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Gaya: singkat");
  }
});

test("[memori] tanpa teks memakai query 'memori'", async () => {
  const { memory, calls } = fakeMemory();
  await collect(createMockRunner().run({ ...baseInput(), prompt: "[memori]", memory }));
  expect(calls).toEqual([{ name: "memory_search", args: { query: "memori" } }]);
});

test("[usul] memanggil memory_propose dengan usulan demo", async () => {
  const { memory, calls } = fakeMemory();
  const events = await collect(
    createMockRunner().run({ ...baseInput(), prompt: "[usul] tolong ingat ini", memory }),
  );

  expect(calls).toEqual([
    {
      name: "memory_propose",
      args: { layer: "profile", title: "Usulan demo", body: "Pengguna suka jawaban singkat." },
    },
  ]);
  const call = events[0]!;
  expect(call.type).toBe("tool_call");
  if (call.type === "tool_call") {
    expect(call.name).toBe("mcp__jejak-memory__memory_propose");
  }
  const result = events[1]!;
  if (result.type === "tool_result") {
    expect(result.output).toContain("menunggu persetujuan");
  }
  expect(events[events.length - 1]?.type).toBe("result");
});

test("penanda tanpa memory memakai perilaku lama", async () => {
  const events = await collect(createMockRunner().run({ ...baseInput(), prompt: "[memori] x" }));
  expect(events.map((event) => event.type)).toEqual([
    "session",
    "thinking",
    "text",
    "tool_call",
    "tool_result",
    "text",
    "result",
  ]);
});
