import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ContextTab, telemetrySummary } from "../src/client/components/ContextTab";
import {
  MAX_TELEMETRY_TOOLS,
  computeTelemetry,
  type TelemetryEvent,
} from "../src/client/lib/telemetry";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
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

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function renderTab(telemetry = computeTelemetry([])): ComponentChild {
  return ContextTab({ telemetry }) as unknown as ComponentChild;
}

/* ---------- computeTelemetry ---------- */

describe("computeTelemetry", () => {
  test("tanpa event hasilnya nol dan tanpa konteks", () => {
    const telemetry = computeTelemetry([]);
    expect(telemetry.context).toBeUndefined();
    expect(telemetry.inputTokens).toBe(0);
    expect(telemetry.outputTokens).toBe(0);
    expect(telemetry.cacheReadTokens).toBe(0);
    expect(telemetry.cacheWriteTokens).toBe(0);
    expect(telemetry.numTurns).toBe(0);
    expect(telemetry.cost).toBeUndefined();
    expect(telemetry.tools).toEqual([]);
    expect(telemetry.otherTools).toBe(0);
    expect(telemetry.subagentCalls).toBe(0);
    expect(telemetry.userMessages).toBe(0);
    expect(telemetry.resultsOk).toBe(0);
    expect(telemetry.resultsFailed).toBe(0);
  });

  test("beberapa result dijumlah; konteks diambil dari yang terakhir", () => {
    const events: TelemetryEvent[] = [
      { type: "user_message", text: "halo" },
      {
        type: "result",
        ok: true,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        numTurns: 2,
        costUsd: 0.25,
        contextTokens: 900,
        contextWindow: 1000,
      },
      { type: "user_message", text: "lagi" },
      {
        type: "result",
        ok: true,
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        numTurns: 1,
        costUsd: 0.75,
        contextTokens: 1500,
        contextWindow: 1000,
      },
    ];

    const telemetry = computeTelemetry(events);
    expect(telemetry.inputTokens).toBe(300);
    expect(telemetry.outputTokens).toBe(70);
    expect(telemetry.cacheReadTokens).toBe(11);
    expect(telemetry.cacheWriteTokens).toBe(5);
    expect(telemetry.numTurns).toBe(3);
    expect(telemetry.userMessages).toBe(2);
    expect(telemetry.resultsOk).toBe(2);
    expect(telemetry.resultsFailed).toBe(0);
    expect(telemetry.context).toEqual({
      tokens: 1500,
      window: 1000,
      percent: 100,
      level: "high",
    });
  });

  test("hasil gagal dihitung terpisah", () => {
    const telemetry = computeTelemetry([
      { type: "result", ok: true },
      { type: "result", ok: false },
      { type: "result", ok: false },
    ]);
    expect(telemetry.resultsOk).toBe(1);
    expect(telemetry.resultsFailed).toBe(2);
  });

  test("biaya dipakai; perkiraan hanya bila satu-satunya", () => {
    const nyata = computeTelemetry([{ type: "result", ok: true, costUsd: 0.4 }]);
    expect(nyata.cost).toEqual({ usd: 0.4, estimated: false });

    const perkiraan = computeTelemetry([
      { type: "result", ok: true, estimatedCostUsd: 0.2 },
      { type: "result", ok: true, estimatedCostUsd: 0.3 },
    ]);
    expect(perkiraan.cost).toEqual({ usd: 0.5, estimated: true });

    // Biaya SDK menang bila keduanya ada.
    const campur = computeTelemetry([
      { type: "result", ok: true, costUsd: 1, estimatedCostUsd: 9 },
    ]);
    expect(campur.cost).toEqual({ usd: 1, estimated: false });
  });

  test("alat dihitung per nama dengan galat dipasangkan lewat id", () => {
    const telemetry = computeTelemetry([
      { type: "tool_call", id: "t1", name: "Bash", input: {} },
      { type: "tool_call", id: "t2", name: "Bash", input: {} },
      { type: "tool_result", id: "t2", output: "gagal", isError: true },
      { type: "tool_call", id: "t3", name: "Read", input: {} },
      { type: "tool_result", id: "t3", output: "ok", isError: false },
    ]);

    expect(telemetry.tools).toEqual([
      { name: "Bash", calls: 2, errors: 1 },
      { name: "Read", calls: 1, errors: 0 },
    ]);
    expect(telemetry.otherTools).toBe(0);
    expect(telemetry.subagentCalls).toBe(0);
  });

  test("alat subagen dihitung sama tapi ditandai terpisah", () => {
    const telemetry = computeTelemetry([
      { type: "tool_call", id: "t1", name: "Task", input: {} },
      {
        type: "tool_call",
        id: "t2",
        name: "Grep",
        input: {},
        parentToolUseId: "t1",
      },
      { type: "tool_result", id: "t2", output: "gagal", isError: true },
    ]);

    expect(telemetry.tools).toEqual([
      { name: "Grep", calls: 1, errors: 1 },
      { name: "Task", calls: 1, errors: 0 },
    ]);
    expect(telemetry.subagentCalls).toBe(1);
  });

  test("tabel alat dibatasi 12 baris; sisanya dihitung", () => {
    const events: TelemetryEvent[] = [];
    for (let index = 0; index < 15; index += 1) {
      events.push({ type: "tool_call", id: `t${index}`, name: `Alat${index}`, input: {} });
    }

    const telemetry = computeTelemetry(events);
    expect(telemetry.tools).toHaveLength(MAX_TELEMETRY_TOOLS);
    expect(telemetry.otherTools).toBe(3);
    expect(telemetry.tools[0]?.name).toBe("Alat0");
  });

  test("alat tanpa nama tetap dihitung", () => {
    const telemetry = computeTelemetry([{ type: "tool_call", id: "t1", input: {} }]);
    expect(telemetry.tools).toEqual([{ name: "(tanpa nama)", calls: 1, errors: 0 }]);
  });
});

/* ---------- ContextTab ---------- */

describe("ContextTab", () => {
  test("tanpa data menampilkan pesan kosong", () => {
    const teks = textOf(renderTab());
    expect(teks).toContain("Belum ada data konteks.");
    expect(teks).toContain("Belum ada penggunaan alat.");
  });

  test("semua blok tampil saat data ada", () => {
    const telemetry = computeTelemetry([
      { type: "user_message", text: "halo" },
      {
        type: "result",
        ok: true,
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 60,
        cacheWriteTokens: 10,
        numTurns: 3,
        costUsd: 0.42,
        contextTokens: 40000,
        contextWindow: 200000,
      },
      { type: "tool_call", id: "t1", name: "Bash", input: {} },
      { type: "tool_result", id: "t1", output: "ok", isError: false },
    ]);

    const node = renderTab(telemetry);
    const teks = textOf(node);
    expect(teks).toContain("Konteks");
    expect(teks).toContain("Pemakaian");
    expect(teks).toContain("Alat");
    expect(teks).toContain("Giliran");
    expect(teks).toContain("1.200");
    expect(teks).toContain("Bash");
    expect(teks).toContain("3");
  });

  test("level konteks tinggi memakai kelas high", () => {
    const telemetry = computeTelemetry([
      {
        type: "result",
        ok: true,
        contextTokens: 190000,
        contextWindow: 200000,
      },
    ]);

    const node = renderTab(telemetry);
    expect(telemetry.context?.level).toBe("high");
    const bar = byClass(node, "jk-ctx-bar");
    expect(bar).toHaveLength(1);
    expect(String(propsOf(bar[0])["class"])).toContain("jk-ctx-high");
    const isi = byClass(node, "jk-ctx-bar-fill");
    expect(isi).toHaveLength(1);
    const gaya = propsOf(isi[0])["style"] as { width?: string } | undefined;
    expect(gaya?.width).toBe("95%");
  });

  test("biaya perkiraan diberi label perkiraan", () => {
    const telemetry = computeTelemetry([
      { type: "result", ok: true, estimatedCostUsd: 0.5 },
    ]);
    expect(textOf(renderTab(telemetry))).toContain("Biaya (perkiraan)");
  });
});

describe("telemetrySummary", () => {
  test("ringkasan memuat konteks, token, biaya, dan alat teratas", () => {
    const telemetry = computeTelemetry([
      { type: "result", ok: true, inputTokens: 10, outputTokens: 5, costUsd: 0.1, contextTokens: 100, contextWindow: 1000 },
      { type: "tool_call", id: "t1", name: "Bash", input: {} },
    ]);
    const ringkasan = telemetrySummary(telemetry, "claude-sonnet", "anthropic");
    expect(ringkasan).toContain("Konteks:");
    expect(ringkasan).toContain("Token:");
    expect(ringkasan).toContain("Biaya:");
    expect(ringkasan).toContain("Bash (1)");
    expect(ringkasan).toContain("claude-sonnet");
    expect(ringkasan).toContain("anthropic");
  });
});
