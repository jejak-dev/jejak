import { describe, expect, test } from "bun:test";
import {
  PACKUMENT_URL,
  REGISTRY_ORIGIN,
  RegistryError,
  SDK_SUPPORTED_RANGE,
  buildTarballUrl,
  downloadTarball,
  fetchPackument,
  pickVersion,
  type PackumentVersion,
} from "../src/server/sdk/registry";
import { computeIntegrity } from "../src/server/sdk/tarball";

const NAMA = "@anthropic-ai/claude-agent-sdk";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
}

/** `fetch` palsu yang mencatat setiap panggilan dan mengembalikan body. */
function fakeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return await handler(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/**
 * Body mengalir bertahap; `pulled` memberi tahu berapa byte yang benar-benar
 * diambil dari sumber, sehingga penghentian stream bisa diamati.
 */
function streamingResponse(
  total: number,
  chunkSize: number,
): { response: Response; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return { response: new Response(stream), pulled: () => sent };
}

function versi(version: string, extra: Partial<PackumentVersion> = {}): PackumentVersion {
  return {
    version,
    integrity: computeIntegrity(new TextEncoder().encode(version)),
    tarball: `${REGISTRY_ORIGIN}/${NAMA}/-/${NAMA.split("/")[1]}-${version}.tgz`,
    ...extra,
  };
}

async function grabError(fn: () => Promise<unknown>): Promise<RegistryError | null> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RegistryError) return error;
    throw error;
  }
  return null;
}

describe("pickVersion", () => {
  test("memakai tag latest saat berada di rentang", () => {
    const picked = pickVersion({
      versions: { "0.3.1": versi("0.3.1"), "0.3.2": versi("0.3.2") },
      latest: "0.3.2",
    });
    expect(picked.version).toBe("0.3.2");
    expect(picked.note).toBeUndefined();
    expect(picked.integrity).toBe(versi("0.3.2").integrity);
  });

  test("memakai versi tertinggi dalam rentang bila latest di luar rentang", () => {
    const picked = pickVersion({
      versions: {
        "0.3.1": versi("0.3.1"),
        "0.3.2": versi("0.3.2"),
        "1.4.0": versi("1.4.0"),
      },
      latest: "1.4.0",
    });
    expect(picked.version).toBe("0.3.2");
    expect(picked.note).toContain("1.4.0");
    expect(picked.note).toContain(SDK_SUPPORTED_RANGE);
  });

  test("prarilis diabaikan dan dijelaskan pada catatan", () => {
    const picked = pickVersion({
      versions: {
        "0.3.1": versi("0.3.1"),
        "0.4.0-beta.1": versi("0.4.0-beta.1"),
      },
      latest: "0.4.0-beta.1",
    });
    expect(picked.version).toBe("0.3.1");
    expect(picked.note).toContain("prarilis");
  });

  test("semver persis yang ada langsung dipakai", () => {
    const picked = pickVersion({
      versions: { "0.3.1": versi("0.3.1"), "0.3.2": versi("0.3.2") },
      latest: "0.3.2",
      requested: "0.3.1",
    });
    expect(picked.version).toBe("0.3.1");
    expect(picked.note).toBeUndefined();
  });

  test("semver persis yang tidak ada ditolak sebagai not-found", async () => {
    const error = await grabError(async () =>
      pickVersion({
        versions: { "0.3.1": versi("0.3.1") },
        latest: "0.3.1",
        requested: "0.9.9",
      }),
    );
    expect(error?.code).toBe("not-found");
  });

  test("semver persis di luar rentang ditolak sebagai out-of-range", async () => {
    const error = await grabError(async () =>
      pickVersion({
        versions: { "0.3.1": versi("0.3.1"), "1.0.0": versi("1.0.0") },
        latest: "0.3.1",
        requested: "1.0.0",
      }),
    );
    expect(error?.code).toBe("out-of-range");
  });

  test("nilai aneh ditolak sebagai invalid", async () => {
    for (const nilai of ["../1.0.0", "1.0", "x", "v1.2.3", "1.2.3.4"]) {
      const error = await grabError(async () =>
        pickVersion({
          versions: { "0.3.1": versi("0.3.1") },
          latest: "0.3.1",
          requested: nilai,
        }),
      );
      expect(error?.code).toBe("invalid");
    }
  });

  test("requested kosong berarti tag latest", () => {
    const picked = pickVersion({
      versions: { "0.3.1": versi("0.3.1"), "0.3.2": versi("0.3.2") },
      latest: "0.3.2",
      requested: "",
    });
    expect(picked.version).toBe("0.3.2");
  });

  test("tidak ada versi dalam rentang ditolak sebagai not-found", async () => {
    const error = await grabError(async () =>
      pickVersion({ versions: { "1.0.0": versi("1.0.0") }, latest: "1.0.0" }),
    );
    expect(error?.code).toBe("not-found");
  });
});

describe("fetchPackument", () => {
  test("mengambil metadata dari host tetap tanpa cookie atau identitas", async () => {
    const fake = fakeFetch(() =>
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.3.2" },
          versions: {
            "0.3.2": {
              dist: {
                integrity: computeIntegrity(new TextEncoder().encode("x")),
                tarball: buildTarballUrl("0.3.2"),
                unpackedSize: 4242,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const packument = await fetchPackument({ fetch: fake.fetch });
    expect(packument.latest).toBe("0.3.2");
    expect(packument.versions["0.3.2"]?.unpackedSize).toBe(4242);

    const call = fake.calls[0];
    expect(call?.url).toBe(PACKUMENT_URL);
    expect(call?.url.startsWith(REGISTRY_ORIGIN)).toBe(true);
    expect(call?.init?.redirect).toBe("manual");
    expect(call?.init?.credentials).toBe("omit");
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.npm.install-v1+json");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  test("menolak pengalihan", async () => {
    const fake = fakeFetch(() => new Response("", { status: 302 }));
    const error = await grabError(() => fetchPackument({ fetch: fake.fetch }));
    expect(error?.code).toBe("redirect");
  });

  test("menolak bentuk metadata yang tidak dikenal", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ lain: true }), { status: 200 }));
    const error = await grabError(() => fetchPackument({ fetch: fake.fetch }));
    expect(error?.code).toBe("bad-response");
  });

  test("menolak metadata yang bukan JSON", async () => {
    const fake = fakeFetch(() => new Response("bukan json", { status: 200 }));
    const error = await grabError(() => fetchPackument({ fetch: fake.fetch }));
    expect(error?.code).toBe("bad-response");
  });

  test("menolak metadata terlalu besar dan menghentikan stream", async () => {
    const stream = streamingResponse(50 * 1024 * 1024, 1024 * 1024);
    const fake = fakeFetch(() => stream.response);
    const error = await grabError(() => fetchPackument({ fetch: fake.fetch }));
    expect(error?.code).toBe("too-large");
    // Stream berhenti jauh sebelum total 50 MB benar-benar dialirkan.
    expect(stream.pulled()).toBeLessThan(13 * 1024 * 1024);
  });

  test("galat waktu habis saat fetch menggantung", async () => {
    const fake = fakeFetch(() => new Promise<Response>(() => {}));
    const error = await grabError(() =>
      fetchPackument({ fetch: fake.fetch, timeoutMs: 60 }),
    );
    expect(error?.code).toBe("timeout");
  });

  test("galat jaringan saat fetch gagal", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("jaringan mati");
    });
    const error = await grabError(() => fetchPackument({ fetch: fake.fetch }));
    expect(error?.code).toBe("network");
  });
});

describe("downloadTarball", () => {
  test("membangun URL sendiri dan mengunduh dari host tetap", async () => {
    const isi = new TextEncoder().encode("isi tarball");
    const fake = fakeFetch(() => new Response(isi, { status: 200 }));
    const { gz } = await downloadTarball("0.3.2", {
      fetch: fake.fetch,
      expectedTarball: buildTarballUrl("0.3.2"),
    });
    expect(gz.byteLength).toBe(isi.byteLength);
    expect(fake.calls[0]?.url).toBe(buildTarballUrl("0.3.2"));
    expect(fake.calls[0]?.url.startsWith(REGISTRY_ORIGIN)).toBe(true);
    expect(fake.calls[0]?.init?.redirect).toBe("manual");
    expect(fake.calls[0]?.init?.credentials).toBe("omit");
  });

  test("metadata yang menunjuk host lain dianggap mencurigakan", async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const error = await grabError(() =>
      downloadTarball("0.3.2", {
        fetch: fake.fetch,
        expectedTarball: "https://contoh.example.com/paket.tgz",
      }),
    );
    expect(error?.code).toBe("bad-response");
    expect(fake.calls.length).toBe(0);
  });

  test("metadata http ditolak", async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const error = await grabError(() =>
      downloadTarball("0.3.2", {
        fetch: fake.fetch,
        expectedTarball: "http://registry.npmjs.org/paket.tgz",
      }),
    );
    expect(error?.code).toBe("bad-response");
  });

  test("menolak unduhan lebih dari 20 MB dan menghentikan stream", async () => {
    const stream = streamingResponse(100 * 1024 * 1024, 4 * 1024 * 1024);
    const fake = fakeFetch(() => stream.response);
    const error = await grabError(() => downloadTarball("0.3.2", { fetch: fake.fetch }));
    expect(error?.code).toBe("too-large");
    // Stream berhenti jauh sebelum total 100 MB benar-benar dialirkan.
    expect(stream.pulled()).toBeLessThan(32 * 1024 * 1024);
  });

  test("menolak status selain 200", async () => {
    const fake = fakeFetch(() => new Response("tidak ada", { status: 500 }));
    const error = await grabError(() => downloadTarball("0.3.2", { fetch: fake.fetch }));
    expect(error?.code).toBe("bad-response");
  });

  test("menolak versi yang bukan semver", async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const error = await grabError(() => downloadTarball("../1.0.0", { fetch: fake.fetch }));
    expect(error?.code).toBe("invalid");
    expect(fake.calls.length).toBe(0);
  });
});
