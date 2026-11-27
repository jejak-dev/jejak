import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ApiError, createApiClient, type UsageResponse } from "../src/client/lib/api";
import {
  barHeights,
  formatCost,
  formatTokensShort,
  groupUsageSessions,
  rangeLabel,
  shareOf,
} from "../src/client/lib/usage";
import { UsageBody, UsageDisabled, UsageError } from "../src/client/components/UsagePage";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function byTag(node: ComponentChild, tag: string): VNode[] {
  return findNodes(node, (vnode) => vnode.type === tag);
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

/* ---------- Fungsi murni ---------- */

describe("formatCost", () => {
  test("nol, di bawah satu dolar, dan di atas satu dolar", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0123)).toBe("$0.0123");
    expect(formatCost(12.34)).toBe("$12.34");
  });

  test("nilai tidak sah menjadi nol", () => {
    expect(formatCost(Number.NaN)).toBe("$0.00");
    expect(formatCost(-1)).toBe("$0.00");
  });
});

describe("formatTokensShort", () => {
  test("ribuan dan jutaan diringkas", () => {
    expect(formatTokensShort(950)).toBe("950");
    expect(formatTokensShort(1200)).toBe("1.2k");
    expect(formatTokensShort(3_400_000)).toBe("3.4M");
    expect(formatTokensShort(0)).toBe("0");
  });
});

describe("barHeights", () => {
  test("berskala relatif terhadap nilai terbesar", () => {
    expect(barHeights([10, 5, 0], 100)).toEqual([100, 50, 0]);
  });

  test("nilai positif minimal dua piksel", () => {
    expect(barHeights([1000, 1], 100)).toEqual([100, 2]);
  });

  test("semua nol menghasilkan tanpa batang", () => {
    expect(barHeights([0, 0], 100)).toEqual([0, 0]);
  });
});

describe("shareOf", () => {
  test("bagian terhadap total", () => {
    expect(shareOf(1, 4)).toBe(0.25);
    expect(shareOf(5, 4)).toBe(1);
    expect(shareOf(1, 0)).toBe(0);
  });
});

describe("rangeLabel", () => {
  test("menyebut jumlah hari", () => {
    expect(rangeLabel(7)).toBe("7 hari terakhir");
    expect(rangeLabel(90)).toBe("90 hari terakhir");
  });
});

/* ---------- Klien API ---------- */

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
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

const RESPONSE: UsageResponse = {
  days: 30,
  summary: {
    totalCostUsd: 1.5,
    totalInputTokens: 1200,
    totalOutputTokens: 300,
    turns: 4,
    byDay: [
      {
        day: "2026-11-01",
        costUsd: 1,
        inputTokens: 1000,
        outputTokens: 200,
        turns: 3,
      },
      {
        day: "2026-11-02",
        costUsd: 0.5,
        inputTokens: 200,
        outputTokens: 100,
        turns: 1,
      },
    ],
    byModel: [
      {
        model: "claude-a",
        costUsd: 1.5,
        inputTokens: 1200,
        outputTokens: 300,
        turns: 4,
      },
    ],
    byProfile: [
      {
        profileId: "p_1",
        costUsd: 1.5,
        inputTokens: 1200,
        outputTokens: 300,
        turns: 4,
      },
    ],
    bySession: [
      {
        sessionId: "s_1",
        costUsd: 1.5,
        inputTokens: 1200,
        outputTokens: 300,
        turns: 4,
        lastTs: "2026-11-02T10:00:00.000Z",
      },
    ],
  },
  retentionDays: 90,
  sessions: { s_1: "Sesi pertama" },
};

describe("api.getUsage", () => {
  test("memanggil /api/usage dengan hari dan zona waktu klien", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(RESPONSE));
    const api = createApiClient({ fetch });

    const result = await api.getUsage(30);

    expect(result.days).toBe(30);
    expect(result.summary.totalCostUsd).toBe(1.5);
    expect(calls[0]?.url).toBe(
      `/api/usage?days=30&tz=${-new Date().getTimezoneOffset()}`,
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("hari tujuh memakai parameter tujuh", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(RESPONSE));
    const api = createApiClient({ fetch });

    await api.getUsage(7);

    expect(calls[0]?.url).toContain("days=7");
  });

  test("respons tidak valid menghasilkan ApiError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ days: 30 }));
    const api = createApiClient({ fetch });

    await expect(api.getUsage(30)).rejects.toBeInstanceOf(ApiError);
  });

  test("503 mengikuti pola ApiError dengan pesan server", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Pencatatan pemakaian dimatikan." }, 503),
    );
    const api = createApiClient({ fetch });

    const error = await api.getUsage(30).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).message).toBe("Pencatatan pemakaian dimatikan.");
  });
});

/* ---------- Komponen ---------- */

describe("UsageBody", () => {
  test("menampilkan kartu ringkas dan tabel", () => {
    const vnode = UsageBody({ data: RESPONSE, sessions: [] }) as VNode;

    expect(byTag(vnode, "table")).toHaveLength(3);
    expect(textOf(vnode)).toContain("$1.50");
    expect(textOf(vnode)).toContain("Per model");
    expect(textOf(vnode)).toContain("Sesi teratas");
    expect(textOf(vnode)).toContain(
      "Biaya dihitung dari tarif model yang dikenal. Model tanpa tarif (mis. DeepSeek, MiniMax) tidak dicatat di sini",
    );
    expect(textOf(vnode)).toContain("angka itu hanya perkiraan SDK.");
  });

  test("kondisi kosong menyuruh pengguna", () => {
    const kosong: UsageResponse = {
      ...RESPONSE,
      summary: {
        ...RESPONSE.summary,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turns: 0,
        byModel: [],
        byProfile: [],
        bySession: [],
      },
    };

    const vnode = UsageBody({ data: kosong, sessions: [] }) as VNode;

    expect(textOf(vnode)).toContain(
      "Belum ada pemakaian yang tercatat dalam rentang ini. Sesi dengan model tanpa tarif tidak ikut dicatat.",
    );
    expect(byTag(vnode, "table")).toHaveLength(0);
  });
});

describe("UsageDisabled", () => {
  test("menyatakan pencatatan dimatikan", () => {
    const vnode = UsageDisabled() as VNode;
    expect(textOf(vnode)).toContain("Pencatatan pemakaian dimatikan.");
    expect(propsOf(vnode).class).toBe("jk-note");
  });
});

describe("UsageError", () => {
  test("menampilkan pesan dan tombol coba lagi", () => {
    let dipanggil = 0;
    const vnode = UsageError({
      message: "gagal",
      onRetry: () => {
        dipanggil += 1;
      },
    }) as VNode;

    expect(textOf(vnode)).toContain("gagal");
    const tombol = byTag(vnode, "button")[0];
    expect(tombol).toBeDefined();
    expect(propsOf(tombol).onClick).toBeDefined();
  });
});

describe("groupUsageSessions", () => {
  const row = (sessionId: string, costUsd: number, turns = 1) => ({
    sessionId,
    costUsd,
    inputTokens: 10,
    outputTokens: 5,
    turns,
    lastTs: "2026-11-27T00:00:00.000Z",
  });

  test("menggabungkan induk dan anak menjadi satu grup tim", () => {
    const groups = groupUsageSessions(
      [row("anak-1", 0.2), row("induk", 0.1), row("biasa", 0.05)],
      {
        parentOf: (id) => (id === "anak-1" ? "induk" : undefined),
        childCount: (id) => (id === "induk" ? 1 : 0),
      },
    );

    expect(groups.map((group) => group.id)).toEqual(["induk", "biasa"]);
    const tim = groups[0]!;
    expect(tim.team).toBe(true);
    expect(tim.childCount).toBe(1);
    expect(tim.costUsd).toBeCloseTo(0.3, 6);
    expect(tim.turns).toBe(2);
    expect(tim.members.map((member) => member.sessionId)).toEqual(["anak-1", "induk"]);
    expect(groups[1]).toMatchObject({ id: "biasa", team: false, childCount: 0 });
  });

  test("tanpa tim hasilnya identik dengan masukan", () => {
    const rows = [row("a", 0.5), row("b", 0.2)];
    const groups = groupUsageSessions(rows, {
      parentOf: () => undefined,
      childCount: () => 0,
    });
    expect(groups).toEqual(
      rows.map((item) => ({
        ...item,
        id: item.sessionId,
        team: false,
        childCount: 0,
        members: [item],
      })),
    );
  });
});
