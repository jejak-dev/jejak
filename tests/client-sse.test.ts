import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/client/lib/api";
import { followSession, parseSse, type SessionStreamItem } from "../src/client/lib/sse";

const encoder = new TextEncoder();

function streamFromChunks(chunks: ReadonlyArray<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(frames: AsyncIterable<{ id?: string; event: string; data: string }>) {
  const out: Array<{ id?: string; event: string; data: string }> = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

async function collectFollow(items: AsyncIterable<SessionStreamItem>): Promise<SessionStreamItem[]> {
  const out: SessionStreamItem[] = [];
  for await (const item of items) out.push(item);
  return out;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

describe("parseSse", () => {
  test("memecah bingkai dan membawa id serta event", async () => {
    const frames = await collect(
      parseSse(
        streamFromChunks([
          'id: 1\nevent: agent\ndata: {"a":1}\n\n',
          "data: dua\n\n",
          "event: end\n\n",
        ]),
      ),
    );
    expect(frames).toEqual([
      { id: "1", event: "agent", data: '{"a":1}' },
      { event: "message", data: "dua" },
      { event: "end", data: "" },
    ]);
  });

  test("mendukung CRLF dan membuang komentar ping", async () => {
    const frames = await collect(
      parseSse(
        streamFromChunks([
          ": ping\r\n\r\n",
          'id: 7\r\nevent: agent\r\ndata: {"x":1}\r\n\r\n',
        ]),
      ),
    );
    expect(frames).toEqual([{ id: "7", event: "agent", data: '{"x":1}' }]);
  });

  test("menggabungkan beberapa baris data dengan newline", async () => {
    const frames = await collect(parseSse(streamFromChunks(["data: satu\ndata: dua\n\n"])));
    expect(frames).toEqual([{ event: "message", data: "satu\ndua" }]);
  });

  test("menghapus satu spasi awal setelah titik dua", async () => {
    const frames = await collect(parseSse(streamFromChunks(["data:  dua spasi\n\n"])));
    expect(frames).toEqual([{ event: "message", data: " dua spasi" }]);
  });

  test("bingkai tanpa data dan tanpa event dibuang", async () => {
    const frames = await collect(parseSse(streamFromChunks(["id: 9\n\n: ping\n\n"])));
    expect(frames).toEqual([]);
  });

  test("sisa buffer tanpa baris kosong penutup dibuang", async () => {
    const frames = await collect(parseSse(streamFromChunks(["data: utuh\n\ndata: sisa"])));
    expect(frames).toEqual([{ event: "message", data: "utuh" }]);
  });

  test("chunk terpotong di tengah bingkai", async () => {
    const frames = await collect(
      parseSse(streamFromChunks(["data: halo du", "nia\n", "\ndata: kedua\n\n"])),
    );
    expect(frames).toEqual([
      { event: "message", data: "halo dunia" },
      { event: "message", data: "kedua" },
    ]);
  });

  test("chunk terpotong di tengah karakter multibyte", async () => {
    const bytes = encoder.encode("data: halo 👋 dunia\n\n");
    const cut = bytes.indexOf(0xf0) + 2;
    const frames = await collect(
      parseSse(streamFromChunks([bytes.slice(0, cut), bytes.slice(cut)])),
    );
    expect(frames).toEqual([{ event: "message", data: "halo 👋 dunia" }]);
  });
});

describe("followSession", () => {
  test("mengeluarkan event berurutan lalu end", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Promise.resolve(
        new Response(
          streamFromChunks([
            'id: 1\nevent: agent\ndata: {"type":"text","text":"a"}\n\n',
            'id: 2\nevent: agent\ndata: {"type":"text","text":"b"}\n\n',
            'event: end\ndata: {"status":"selesai"}\n\n',
          ]),
          { status: 200 },
        ),
      ),
    );

    const items = await collectFollow(followSession("abc", { fetch }));

    expect(items).toEqual([
      { kind: "event", seq: 1, event: { type: "text", text: "a" } },
      { kind: "event", seq: 2, event: { type: "text", text: "b" } },
      { kind: "end", status: "selesai" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/sessions/abc/events");
    expect(calls[0]?.init.headers).toEqual({});
  });

  test("menyambung ulang dengan last-event-id dan mendedup event", async () => {
    const bodies = [
      streamFromChunks(['id: 1\nevent: agent\ndata: {"type":"text","text":"a"}\n\n']),
      streamFromChunks([
        'id: 1\nevent: agent\ndata: {"type":"text","text":"a"}\n\n',
        'id: 2\nevent: agent\ndata: {"type":"text","text":"b"}\n\n',
        'event: end\ndata: {"status":"selesai"}\n\n',
      ]),
    ];
    const { fetch, calls } = fakeFetch(() =>
      Promise.resolve(new Response(bodies[calls.length - 1] ?? bodies[1]!, { status: 200 })),
    );
    const delays: number[] = [];

    const items = await collectFollow(
      followSession("abc", {
        fetch,
        baseUrl: "http://localhost:1",
        retryDelaysMs: [5, 10],
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );

    expect(items).toEqual([
      { kind: "event", seq: 1, event: { type: "text", text: "a" } },
      { kind: "event", seq: 2, event: { type: "text", text: "b" } },
      { kind: "end", status: "selesai" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://localhost:1/api/sessions/abc/events");
    expect(calls[0]?.init.headers).toEqual({});
    expect(calls[1]?.init.headers).toEqual({ "last-event-id": "1" });
    expect(delays).toEqual([5]);
  });

  test("memakai after sebagai last-event-id awal", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Promise.resolve(
        new Response(
          streamFromChunks([
            'id: 4\nevent: agent\ndata: {"type":"text","text":"d"}\n\n',
            'event: end\ndata: {"status":"selesai"}\n\n',
          ]),
          { status: 200 },
        ),
      ),
    );

    await collectFollow(followSession("abc", { fetch, after: 3 }));

    expect(calls[0]?.init.headers).toEqual({ "last-event-id": "3" });
  });

  test("404 melempar ApiError tanpa retry", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: "tidak ada" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const delays: number[] = [];

    let caught: unknown;
    try {
      await collectFollow(
        followSession("hilang", {
          fetch,
          sleep: async (ms) => {
            delays.push(ms);
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("tidak ada");
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("503 diulang lalu 200 sukses", async () => {
    const okBody = streamFromChunks([
      'id: 1\nevent: agent\ndata: {"type":"text","text":"a"}\n\n',
      'event: end\ndata: {"status":"selesai"}\n\n',
    ]);
    const { fetch, calls } = fakeFetch((_call, index) =>
      Promise.resolve(
        index === 0
          ? new Response(JSON.stringify({ error: "sibuk" }), { status: 503 })
          : new Response(okBody, { status: 200 }),
      ),
    );
    const delays: number[] = [];

    const items = await collectFollow(
      followSession("abc", {
        fetch,
        retryDelaysMs: [7],
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );

    expect(items).toEqual([
      { kind: "event", seq: 1, event: { type: "text", text: "a" } },
      { kind: "end", status: "selesai" },
    ]);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([7]);
  });

  test("429 diulang tanpa melempar", async () => {
    const okBody = streamFromChunks(['event: end\ndata: {"status":"selesai"}\n\n']);
    const { fetch, calls } = fakeFetch((_call, index) =>
      Promise.resolve(
        index === 0
          ? new Response(JSON.stringify({ error: "terlalu banyak" }), { status: 429 })
          : new Response(okBody, { status: 200 }),
      ),
    );
    const delays: number[] = [];

    const items = await collectFollow(
      followSession("abc", {
        fetch,
        retryDelaysMs: [3],
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );

    expect(items).toEqual([{ kind: "end", status: "selesai" }]);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([3]);
  });

  test("abort saat menunggu retry setelah 500 berhenti tanpa error", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "meledak" }), { status: 500 })),
    );

    const items = await collectFollow(
      followSession("abc", {
        fetch,
        signal: controller.signal,
        retryDelaysMs: [1000],
        sleep: async () => {
          controller.abort();
        },
      }),
    );

    expect(items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("signal yang sudah abort selesai tanpa error dan tanpa fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = fakeFetch(() => Promise.reject(new Error("tidak boleh dipanggil")));

    const items = await collectFollow(followSession("abc", { fetch, signal: controller.signal }));

    expect(items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("abort saat menunggu retry menghentikan iterasi", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch(() => Promise.resolve(new Response(streamFromChunks([]))));

    const items = await collectFollow(
      followSession("abc", {
        fetch,
        signal: controller.signal,
        retryDelaysMs: [1000],
        sleep: async () => {
          controller.abort();
        },
      }),
    );

    expect(items).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("JSON rusak dilewati tetapi bingkai berikutnya tetap dipakai", async () => {
    const { fetch } = fakeFetch(() =>
      Promise.resolve(
        new Response(
          streamFromChunks([
            "id: 1\nevent: agent\ndata: {rusak\n\n",
            'id: 2\nevent: agent\ndata: {"type":"thinking","text":"t"}\n\n',
            'event: end\ndata: {"status":"selesai"}\n\n',
          ]),
          { status: 200 },
        ),
      ),
    );

    const items = await collectFollow(followSession("abc", { fetch }));

    expect(items).toEqual([
      { kind: "event", seq: 2, event: { type: "thinking", text: "t" } },
      { kind: "end", status: "selesai" },
    ]);
  });

  test("mengulang delay terakhir dan mereset saat ada event baru", async () => {
    const bodies = [
      streamFromChunks([": ping\n\n"]),
      streamFromChunks([": ping\n\n"]),
      streamFromChunks([": ping\n\n"]),
      streamFromChunks(['id: 1\nevent: agent\ndata: {"type":"text","text":"a"}\n\n']),
      streamFromChunks(['event: end\ndata: {"status":"selesai"}\n\n']),
    ];
    const { fetch } = fakeFetch(() =>
      Promise.resolve(new Response(bodies[fetchCount++] ?? bodies[4]!, { status: 200 })),
    );
    let fetchCount = 0;
    const delays: number[] = [];

    await collectFollow(
      followSession("abc", {
        fetch,
        retryDelaysMs: [10, 20],
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    );

    expect(delays).toEqual([10, 20, 20, 10]);
    expect(fetchCount).toBe(5);
  });
});
