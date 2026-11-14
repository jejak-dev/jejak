import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ApiError, createApiClient } from "../src/client/lib/api";
import {
  goalCanResume,
  goalCostCapLabel,
  goalIsFinished,
  goalIsLive,
  goalProgressLabel,
  goalReasonLabel,
  goalStatusLabel,
  parseGoalCommand,
  validateGoalOptions,
  type GoalView,
} from "../src/client/lib/goal";
import { GoalBar } from "../src/client/components/GoalBar";
import { UserItem } from "../src/client/components/Timeline";
import { reduceTimeline, type TimelineItem } from "../src/client/lib/timeline";

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

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function buttonTexts(node: ComponentChild): string[] {
  return byTag(node, "button").map((vnode) => textOf(propsOf(vnode).children as ComponentChild));
}

/* ---------- Data bantu ---------- */

function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: "g_1",
    objective: "Buat semua tes auth hijau",
    status: "active",
    maxTurns: 10,
    autoTurns: 3,
    idleTurns: 0,
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOOP = (): void => undefined;

/* ---------- Fungsi murni ---------- */

describe("parseGoalCommand", () => {
  test("mengambil tujuan setelah /goal", () => {
    expect(parseGoalCommand("/goal bereskan tes")).toBe("bereskan tes");
    expect(parseGoalCommand("  /goal   bereskan tes  ")).toBe("bereskan tes");
    expect(parseGoalCommand("/GOAL bereskan tes")).toBe("bereskan tes");
    expect(parseGoalCommand("/goal\nbaris kedua")).toBe("baris kedua");
  });

  test("/goal tanpa isi dan /goalx bukan perintah", () => {
    expect(parseGoalCommand("/goal")).toBeUndefined();
    expect(parseGoalCommand("/goal   ")).toBeUndefined();
    expect(parseGoalCommand("/goalx bereskan tes")).toBeUndefined();
    expect(parseGoalCommand("bukan /goal bereskan tes")).toBeUndefined();
    expect(parseGoalCommand("")).toBeUndefined();
  });
});

describe("label Goal", () => {
  test("progres menyebut giliran dan batas", () => {
    expect(goalProgressLabel({ autoTurns: 3, maxTurns: 10 })).toBe("giliran 3 dari 10");
    expect(goalProgressLabel({ autoTurns: 0, maxTurns: 50 })).toBe("giliran 0 dari 50");
  });

  test("status punya label Indonesia", () => {
    expect(goalStatusLabel({ status: "active" })).toBe("Berjalan");
    expect(goalStatusLabel({ status: "paused" })).toBe("Dijeda");
    expect(goalStatusLabel({ status: "achieved" })).toBe("Tercapai");
    expect(goalStatusLabel({ status: "blocked" })).toBe("Buntu");
    expect(goalStatusLabel({ status: "stopped" })).toBe("Dihentikan");
  });

  test("alasan punya label Indonesia", () => {
    expect(goalReasonLabel("selesai")).toBe("Tujuan tercapai");
    expect(goalReasonLabel("buntu")).toBe("Agent melaporkan buntu");
    expect(goalReasonLabel("plafon-giliran")).toBe("Batas giliran otomatis tercapai");
    expect(goalReasonLabel("plafon-biaya")).toBe("Plafon biaya tercapai");
    expect(goalReasonLabel("anggaran-sesi")).toBe("Anggaran sesi terlampaui");
    expect(goalReasonLabel("tanpa-kemajuan")).toBe("Dua giliran tanpa kemajuan");
    expect(goalReasonLabel("gagal")).toBe("Giliran gagal");
    expect(goalReasonLabel("dihentikan")).toBe("Dihentikan");
  });

  test("status hidup, boleh dilanjutkan, dan selesai", () => {
    expect(goalIsLive(goal({ status: "active" }))).toBe(true);
    expect(goalIsLive(goal({ status: "paused" }))).toBe(false);
    expect(goalCanResume(goal({ status: "paused" }))).toBe(true);
    expect(goalCanResume(goal({ status: "active" }))).toBe(false);
    expect(goalIsFinished(goal({ status: "achieved" }))).toBe(true);
    expect(goalIsFinished(goal({ status: "blocked" }))).toBe(true);
    expect(goalIsFinished(goal({ status: "stopped" }))).toBe(true);
    expect(goalIsFinished(goal({ status: "paused" }))).toBe(false);
  });

  test("plafon biaya hanya tampil bila ada", () => {
    expect(goalCostCapLabel(goal())).toBeUndefined();
    expect(goalCostCapLabel(goal({ costCapUsd: 5 }))).toBe("plafon $5,00");
  });
});

describe("validateGoalOptions", () => {
  test("string kosong berarti tidak diisi", () => {
    expect(validateGoalOptions({})).toEqual({ ok: true });
    expect(validateGoalOptions({ maxTurns: "", costCapUsd: "" })).toEqual({ ok: true });
    expect(validateGoalOptions({ maxTurns: "  " })).toEqual({ ok: true });
  });

  test("batas giliran 1 sampai 50 diterima", () => {
    expect(validateGoalOptions({ maxTurns: "1" })).toEqual({ ok: true, maxTurns: 1 });
    expect(validateGoalOptions({ maxTurns: "10" })).toEqual({ ok: true, maxTurns: 10 });
    expect(validateGoalOptions({ maxTurns: "50" })).toEqual({ ok: true, maxTurns: 50 });
  });

  test("batas giliran di luar 1-50 ditolak", () => {
    for (const value of ["0", "51", "-1", "abc", "NaN", "10.5", "100"]) {
      const result = validateGoalOptions({ maxTurns: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("giliran otomatis");
    }
  });

  test("plafon biaya lebih dari 0 dan maksimal 1000", () => {
    expect(validateGoalOptions({ costCapUsd: "0.5" })).toEqual({ ok: true, costCapUsd: 0.5 });
    expect(validateGoalOptions({ costCapUsd: "1000" })).toEqual({ ok: true, costCapUsd: 1000 });
  });

  test("plafon biaya 0, negatif, NaN, dan 1001 ditolak", () => {
    for (const value of ["0", "-3", "NaN", "abc", "1001"]) {
      const result = validateGoalOptions({ costCapUsd: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Plafon biaya");
    }
  });

  test("keduanya bisa diisi sekaligus", () => {
    expect(validateGoalOptions({ maxTurns: "5", costCapUsd: "2" })).toEqual({
      ok: true,
      maxTurns: 5,
      costCapUsd: 2,
    });
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

describe("api goal", () => {
  test("startGoal mengirim tujuan ke /goal", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ goal: goal() }));
    const api = createApiClient({ fetch });

    const result = await api.startGoal("s_1", { objective: "Buat tes hijau" });

    expect(result.goal?.objective).toBe("Buat semua tes auth hijau");
    expect(calls[0]?.url).toBe("/api/sessions/s_1/goal");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ objective: "Buat tes hijau" }));
  });

  test("startGoal mengirim batas bila diisi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ goal: goal() }));
    const api = createApiClient({ fetch });

    await api.startGoal("s_1", { objective: "Tujuan", maxTurns: 5, costCapUsd: 2 });

    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ objective: "Tujuan", maxTurns: 5, costCapUsd: 2 }),
    );
  });

  test("pause, resume, dan stop memakai rute masing-masing", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ goal: goal({ status: "paused" }) }));
    const api = createApiClient({ fetch });

    await api.pauseGoal("s_1");
    await api.resumeGoal("s_1");
    await api.stopGoal("s_1");

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "POST /api/sessions/s_1/goal/pause",
      "POST /api/sessions/s_1/goal/resume",
      "POST /api/sessions/s_1/goal/stop",
    ]);
    expect(calls[0]?.init.body).toBe("{}");
  });

  test("getGoal memakai GET dan boleh null", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ goal: null }));
    const api = createApiClient({ fetch });

    expect(await api.getGoal("s_1")).toEqual({ goal: null });
    expect(calls[0]?.url).toBe("/api/sessions/s_1/goal");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("id sesi di-encode pada path", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ goal: null }));
    const api = createApiClient({ fetch });

    await api.getGoal("s/1 2");

    expect(calls[0]?.url).toBe("/api/sessions/s%2F1%202/goal");
  });

  test("galat server menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Sesi ini sudah punya tujuan aktif." }, 409),
    );
    const api = createApiClient({ fetch });

    await expect(api.startGoal("s_1", { objective: "Tujuan" })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.startGoal("s_1", { objective: "Tujuan" })).rejects.toThrow(
      "Sesi ini sudah punya tujuan aktif.",
    );
  });
});

/* ---------- Pita Goal ---------- */

describe("GoalBar", () => {
  test("status berjalan: tujuan, progres, jeda, dan hentikan", () => {
    const node = GoalBar({
      goal: goal({ status: "active", autoTurns: 2, maxTurns: 10, costCapUsd: 5 }),
      busy: false,
      onPause: NOOP,
      onResume: NOOP,
      onStop: NOOP,
    }) as unknown as ComponentChild;

    const text = textOf(node);
    expect(text).toContain("Tujuan: Buat semua tes auth hijau");
    expect(text).toContain("giliran 2 dari 10");
    expect(text).toContain("plafon $5,00");
    expect(buttonTexts(node)).toEqual(["Jeda", "Hentikan"]);
  });

  test("status dijeda: alasan, lanjutkan, dan hentikan", () => {
    const node = GoalBar({
      goal: goal({ status: "paused", endedReason: "plafon-giliran" }),
      busy: false,
      onPause: NOOP,
      onResume: NOOP,
      onStop: NOOP,
    }) as unknown as ComponentChild;

    const text = textOf(node);
    expect(text).toContain("Batas giliran otomatis tercapai");
    expect(text).toContain("giliran 3 dari 10");
    expect(text).toContain("Lanjutkan");
    expect(buttonTexts(node)).toEqual(["Lanjutkan", "Hentikan"]);
  });

  test("status selesai: judul, alasan, ringkasan sebagai teks, dan tombol tutup", () => {
    const node = GoalBar({
      goal: goal({
        status: "achieved",
        endedReason: "selesai",
        summary: "Semua tes auth hijau (12 tes).",
      }),
      busy: false,
      onPause: NOOP,
      onResume: NOOP,
      onStop: NOOP,
      onDismiss: NOOP,
    }) as unknown as ComponentChild;

    const text = textOf(node);
    expect(text).toContain("Tercapai");
    expect(text).toContain("Tujuan tercapai");
    expect(text).toContain("Semua tes auth hijau (12 tes).");
    expect(buttonTexts(node)).toEqual(["Tutup"]);

    // Ringkasan ditampilkan apa adanya: teks biasa, bukan HTML/markdown.
    const ringkasan = byClass(node, "jk-goal-summary")[0];
    expect(typeof propsOf(ringkasan).children).toBe("string");
    expect(propsOf(ringkasan).children).toBe("Semua tes auth hijau (12 tes).");
    expect(byTag(node, "div").some((vnode) => "dangerouslySetInnerHTML" in propsOf(vnode))).toBe(
      false,
    );
  });

  test("mode bypass memunculkan peringatan", () => {
    const node = GoalBar({
      goal: goal({ status: "active" }),
      busy: false,
      onPause: NOOP,
      onResume: NOOP,
      onStop: NOOP,
      permissionMode: "bypassPermissions",
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Mode bypass: agent bekerja tanpa meminta izin.");
  });

  test("tanpa mode bypass tidak ada peringatan", () => {
    const node = GoalBar({
      goal: goal({ status: "active" }),
      busy: false,
      onPause: NOOP,
      onResume: NOOP,
      onStop: NOOP,
      permissionMode: "default",
    }) as unknown as ComponentChild;

    expect(textOf(node)).not.toContain("Mode bypass");
  });
});

/* ---------- Timeline ---------- */

describe("timeline mode Goal", () => {
  test("reducer meneruskan penanda auto", () => {
    const items = reduceTimeline([], { type: "user_message", text: "Lanjutkan tujuan aktif", auto: "goal" });
    const item = items[0] as Extract<TimelineItem, { kind: "user" }>;
    expect(item.kind).toBe("user");
    expect(item.auto).toBe("goal");
  });

  test("pesan biasa tidak mendapat penanda auto", () => {
    const items = reduceTimeline([], { type: "user_message", text: "halo" });
    const item = items[0] as Extract<TimelineItem, { kind: "user" }>;
    expect(item.auto).toBeUndefined();
  });

  test("pesan otomatis tampil sebagai baris kecil tanpa tombol mundur", () => {
    const node = UserItem({
      item: { kind: "user", text: "Tujuan: …", seq: 7, auto: "goal" },
      turn: 2,
      canRewind: true,
      rewinding: false,
      onRequestRewind: NOOP,
    }) as unknown as ComponentChild;

    expect(byClass(node, "jk-goal-auto").length).toBe(1);
    expect(byClass(node, "jk-user").length).toBe(0);
    const text = textOf(node);
    expect(text).toContain("Melanjutkan tujuan");
    expect(text).toContain("giliran ke-2");
    expect(text).not.toContain("Tujuan: …");
    expect(byTag(node, "button").length).toBe(0);
  });

  test("pesan biasa tetap gelembung dan bisa dimundurkan", () => {
    const node = UserItem({
      item: { kind: "user", text: "halo", seq: 7 },
      canRewind: true,
      rewinding: false,
      onRequestRewind: NOOP,
    }) as unknown as ComponentChild;

    expect(byClass(node, "jk-user").length).toBe(1);
    expect(buttonTexts(node)).toEqual(["Mundur ke sini"]);
  });

  test("tombol mundur tetap terpasang saat konfirmasi dibuka", () => {
    const node = UserItem({
      item: { kind: "user", text: "halo", seq: 7 },
      canRewind: true,
      rewinding: true,
      onRequestRewind: NOOP,
    }) as unknown as ComponentChild;

    const tombol = byTag(node, "button")[0];
    expect(textOf(propsOf(tombol).children as ComponentChild)).toBe("Mundur ke sini");
    expect(propsOf(tombol).disabled).toBe(true);
  });
});
