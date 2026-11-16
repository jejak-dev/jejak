import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { QueueList } from "../src/client/components/QueueList";
import { ApiError, createApiClient } from "../src/client/lib/api";
import { QUEUE_PREVIEW_MAX, queuePreview } from "../src/client/lib/queue";
import {
  find,
  findByAttr,
  fire,
  installDom,
  mount,
  type FakeNode,
} from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Logika murni ---------- */

describe("queuePreview", () => {
  test("teks pendek dipakai apa adanya", () => {
    expect(queuePreview("halo")).toBe("halo");
  });

  test("baris baru dirapatkan jadi satu baris", () => {
    expect(queuePreview("  halo\n  dunia  ")).toBe("halo dunia");
  });

  test("teks panjang dipotong elipsis", () => {
    const preview = queuePreview("a".repeat(QUEUE_PREVIEW_MAX + 40));
    expect(preview.length).toBe(QUEUE_PREVIEW_MAX);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("batas kecil tetap menghasilkan elipsis", () => {
    expect(queuePreview("abcdef", 3)).toBe("ab…");
    expect(queuePreview("abcdef", 1)).toBe("…");
  });
});

/* ---------- Komponen ---------- */

function tombol(root: FakeNode, label: string): FakeNode {
  const found = findByAttr(root, "aria-label", label);
  expect(found).toBeDefined();
  return found!;
}

function tombolKirim(root: FakeNode): FakeNode {
  const found = find(
    root,
    (node) => node.localName === "button" && node.textContent.includes("Kirim sekarang"),
  );
  expect(found).toBeDefined();
  return found!;
}

describe("QueueList", () => {
  test("tak merender apa pun saat antrean kosong", () => {
    const root = mount(h(QueueList, { items: [], onSendNow: () => {}, onRemove: () => {} }));
    expect(find(root, (node) => node.className.includes("jk-queue"))).toBeUndefined();
  });

  test("satu baris per pesan dengan teks dipotong dan teks penuh di title", () => {
    const panjang = "b".repeat(QUEUE_PREVIEW_MAX + 10);
    const root = mount(
      h(QueueList, {
        items: [
          { id: "a", text: panjang },
          { id: "b", text: "pendek" },
        ],
        onSendNow: () => {},
        onRemove: () => {},
      }),
    );

    const baris = findAllRows(root);
    expect(baris).toHaveLength(2);

    const teks = find(root, (node) => node.className === "jk-queue-text");
    expect(teks?.textContent?.endsWith("…")).toBe(true);
    expect(teks?.getAttribute("title")).toBe(panjang);
  });

  test("klik Kirim sekarang dan Hapus dari antrean memanggil penangan", () => {
    const terkirim: string[] = [];
    const dihapus: string[] = [];
    const root = mount(
      h(QueueList, {
        items: [{ id: "a", text: "halo" }],
        onSendNow: (id: string) => terkirim.push(id),
        onRemove: (id: string) => dihapus.push(id),
      }),
    );

    fire(tombolKirim(root), "click");
    fire(tombol(root, "Hapus dari antrean"), "click");

    expect(terkirim).toEqual(["a"]);
    expect(dihapus).toEqual(["a"]);
  });

  test("tombol Arahkan hanya tampil bila onSteer ada dan memanggil penangan", () => {
    const tanpa = mount(
      h(QueueList, { items: [{ id: "a", text: "halo" }], onSendNow: () => {}, onRemove: () => {} }),
    );
    expect(
      find(tanpa, (node) => node.localName === "button" && node.textContent.includes("Arahkan")),
    ).toBeUndefined();

    const diarahkan: string[] = [];
    const root = mount(
      h(QueueList, {
        items: [{ id: "a", text: "halo" }],
        onSendNow: () => {},
        onSteer: (id: string) => diarahkan.push(id),
        onRemove: () => {},
      }),
    );
    const arahkan = find(
      root,
      (node) => node.localName === "button" && node.textContent.includes("Arahkan"),
    );
    expect(arahkan).toBeDefined();
    fire(arahkan!, "click");
    expect(diarahkan).toEqual(["a"]);
  });

  test("tombol Kirim sekarang mati saat sesi tak berjalan", () => {
    const root = mount(
      h(QueueList, {
        items: [{ id: "a", text: "halo" }],
        onSendNow: () => {},
        onRemove: () => {},
        disabled: true,
      }),
    );

    expect(tombolKirim(root).getAttribute("disabled")).not.toBeNull();
    expect(tombol(root, "Hapus dari antrean").getAttribute("disabled")).toBeNull();
  });

  test("tombol hapus bisa dimatikan terpisah", () => {
    const root = mount(
      h(QueueList, {
        items: [{ id: "a", text: "halo" }],
        onSendNow: () => {},
        onRemove: () => {},
        removeDisabled: true,
      }),
    );

    expect(tombol(root, "Hapus dari antrean").getAttribute("disabled")).not.toBeNull();
    expect(tombolKirim(root).getAttribute("disabled")).toBeNull();
  });
});

function findAllRows(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        if (child.className === "jk-queue-row") out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/* ---------- Klien API ---------- */

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("antrean di klien API", () => {
  test("removeQueued memanggil DELETE pada rute antrean", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.removeQueued("s1", "q1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/sessions/s1/queue/q1");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("sendQueuedNow memanggil POST pada rute send-now", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.sendQueuedNow("s1", "q1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/sessions/s1/queue/q1/send-now");
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("steerQueued memanggil POST pada rute steer", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    expect(await api.steerQueued("s1", "q1")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("/api/sessions/s1/queue/q1/steer");
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("id pesan di-encode pada URL", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.removeQueued("s 1", "q/1");
    expect(calls[0]?.url).toBe("/api/sessions/s%201/queue/q%2F1");
  });

  test("galat server jadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "pesan antrean tidak ditemukan" }, 404),
    );
    const api = createApiClient({ fetch });

    const galat = await api.sendQueuedNow("s1", "q1").catch((caught) => caught);
    expect(galat).toBeInstanceOf(ApiError);
    expect((galat as ApiError).status).toBe(404);
    expect((galat as ApiError).message).toContain("antrean");
  });
});
