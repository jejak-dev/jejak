import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import type { AgentEvent } from "../src/server/agent/events";
import { SuggestionChip } from "../src/client/components/ReplyBar";
import { rewindableSeqs, type RewindEvent } from "../src/client/lib/rewind";
import {
  fillSuggestion,
  latestSuggestion,
  replyKeyAction,
  showsSuggestion,
  type Suggestion,
} from "../src/client/lib/suggestion";
import { reduceTimeline, type TimelineItem } from "../src/client/lib/timeline";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function cariVNode(
  node: ComponentChild,
  syarat: (vnode: VNode) => boolean,
): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => cariVNode(child, syarat));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return cariVNode(rendered, syarat);
  }
  const diri = syarat(vnode) ? [vnode] : [];
  return diri.concat(cariVNode(vnode.props.children as ComponentChild, syarat));
}

function propVNode(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function teksVNode(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(teksVNode).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "string") return teksVNode(vnode.props.children as ComponentChild);
  return "";
}

/* ---------- Data bantu ---------- */

const SARAN: Suggestion = { text: "Jalankan tesnya", seq: 7 };

function event(seq: number, isi: AgentEvent): RewindEvent {
  return { seq, event: isi };
}

/* ---------- Tes ---------- */

describe("latestSuggestion", () => {
  test("mengembalikan saran terakhir", () => {
    const events = [
      event(1, { type: "text", text: "halo", depth: 0 } as AgentEvent),
      event(2, { type: "suggestion", text: "Jalankan tesnya" }),
    ];
    expect(latestSuggestion(events)).toEqual({ text: "Jalankan tesnya", seq: 2 });
  });

  test("pesan pengguna setelah saran membatalkan saran lama", () => {
    const events = [
      event(2, { type: "suggestion", text: "Jalankan tesnya" }),
      event(3, { type: "user_message", text: "coba yang lain" }),
    ];
    expect(latestSuggestion(events)).toBeUndefined();
  });

  test("saran lebih baru menggantikan saran lama", () => {
    const events = [
      event(2, { type: "suggestion", text: "saran lama" }),
      event(3, { type: "suggestion", text: "saran baru" }),
    ];
    expect(latestSuggestion(events)?.text).toBe("saran baru");
  });
});

describe("showsSuggestion", () => {
  test("tampil saat sesi diam dan kolom balasan kosong", () => {
    expect(
      showsSuggestion({ suggestion: SARAN, running: false, text: "" }),
    ).toBe(true);
  });

  test("tak tampil saat sesi berjalan", () => {
    expect(showsSuggestion({ suggestion: SARAN, running: true, text: "" })).toBe(false);
  });

  test("tak tampil saat kolom balasan sudah berisi", () => {
    expect(showsSuggestion({ suggestion: SARAN, running: false, text: "halo" })).toBe(false);
  });

  test("tak tampil saat saran sudah dipakai atau ditutup", () => {
    expect(
      showsSuggestion({ suggestion: SARAN, running: false, text: "", dismissedSeq: 7 }),
    ).toBe(false);
    expect(
      showsSuggestion({ suggestion: SARAN, running: false, text: "", dismissedSeq: 3 }),
    ).toBe(true);
  });

  test("tak tampil tanpa saran atau dengan saran kosong", () => {
    expect(showsSuggestion({ running: false, text: "" })).toBe(false);
    expect(
      showsSuggestion({ suggestion: { text: "  ", seq: 1 }, running: false, text: "" }),
    ).toBe(false);
  });
});

describe("fillSuggestion", () => {
  test("mengisi kolom balasan dan mematikan chip", () => {
    expect(fillSuggestion(SARAN)).toEqual({ text: "Jalankan tesnya", dismissedSeq: 7 });
  });
});

describe("replyKeyAction", () => {
  test("tab memakai saran saat chip tampil", () => {
    expect(replyKeyAction({ key: "Tab", suggestionVisible: true })).toEqual({
      kind: "pakai-saran",
    });
  });

  test("tab dibiarkan saat chip tak tampil", () => {
    expect(replyKeyAction({ key: "Tab", suggestionVisible: false })).toEqual({
      kind: "biarkan",
    });
  });

  test("enter mengirim, shift+enter menambah baris", () => {
    expect(replyKeyAction({ key: "Enter", suggestionVisible: false })).toEqual({
      kind: "kirim",
    });
    expect(
      replyKeyAction({ key: "Enter", shiftKey: true, suggestionVisible: false }),
    ).toEqual({ kind: "biarkan" });
  });
});

describe("event suggestion", () => {
  test("tak menambah isi timeline", () => {
    const items: TimelineItem[] = [{ kind: "text", text: "halo", depth: 0 }];
    const next = reduceTimeline(items, { type: "suggestion", text: "Jalankan tesnya" });
    expect(next).toEqual(items);
  });

  test("tak mengganggu nomor urut yang bisa dimundurkan", () => {
    const events = [
      event(1, { type: "result", ok: true, anchorUuid: "u-1" }),
      event(2, { type: "suggestion", text: "Jalankan tesnya" }),
      event(3, { type: "user_message", text: "lanjut" }),
    ];
    expect(rewindableSeqs(events)).toEqual([3]);
  });
});

describe("SuggestionChip", () => {
  test("menampilkan teks saran dan tombol tutup berlabel", () => {
    const vnode = SuggestionChip({
      text: "Jalankan tesnya",
      onUse: () => undefined,
      onDismiss: () => undefined,
    }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button");
    expect(teksVNode(vnode)).toContain("Jalankan tesnya");
    expect(teksVNode(vnode)).toContain("Saran:");
    const label = tombol.map((n) => propVNode(n)["aria-label"]);
    expect(label).toContain("Tutup saran");
  });

  test("klik teks memakai saran tanpa mengirim, tombol x menutup", () => {
    let dipakai = 0;
    let ditutup = 0;
    const vnode = SuggestionChip({
      text: "Jalankan tesnya",
      onUse: () => {
        dipakai += 1;
      },
      onDismiss: () => {
        ditutup += 1;
      },
    }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button");
    const teks = tombol.find((n) => propVNode(n)["class"] === "jk-suggestion-text");
    const tutup = tombol.find((n) => propVNode(n)["class"] === "jk-suggestion-close");

    (propVNode(teks)["onClick"] as () => void)();
    expect(dipakai).toBe(1);
    expect(ditutup).toBe(0);

    (propVNode(tutup)["onClick"] as () => void)();
    expect(ditutup).toBe(1);
  });
});
