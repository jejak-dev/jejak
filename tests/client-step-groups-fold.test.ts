import { describe, expect, test } from "bun:test";
import {
  foldWork,
  groupSteps,
  workTitle,
  type StepItem,
  type TimelineBlock,
  type WorkItem,
} from "../src/client/lib/step-groups";
import type { TimelineItem } from "../src/client/lib/timeline";

let urut = 0;

function tool(name: string, status: "berjalan" | "selesai" | "gagal" = "selesai"): TimelineItem {
  urut += 1;
  return { kind: "tool", id: `t${urut}`, name, input: {}, summary: "", status, depth: 0 };
}

const think: TimelineItem = { kind: "thinking", text: "hmm", depth: 0 };

function text(value: string, streaming = false): TimelineItem {
  return streaming
    ? { kind: "text", text: value, depth: 0, streaming: true }
    : { kind: "text", text: value, depth: 0 };
}

const user: TimelineItem = { kind: "user", text: "tanya lagi" };

const permission: TimelineItem = {
  kind: "permission",
  id: "p1",
  name: "Bash",
  input: {},
  status: "menunggu",
};

const result: TimelineItem = { kind: "result", ok: true };

/** Lipat hasil groupSteps seperti di Timeline. */
function lipat(items: TimelineItem[], live = false): TimelineBlock[] {
  return foldWork(groupSteps(items), { live });
}

function kinds(blocks: TimelineBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

/** Isi blok "Bekerja" sebagai daftar nama item, mis. ["text","tool"]. */
function isiWork(block: TimelineBlock | undefined): string[] {
  if (block?.kind !== "work") return [];
  return block.items.map((item) => item.kind);
}

function blokWork(blocks: TimelineBlock[]): TimelineBlock | undefined {
  return blocks.find((block) => block.kind === "work");
}

describe("foldWork", () => {
  test("(a) teks, langkah, teks, langkah, teks akhir: satu blok Bekerja, jawaban tetap di luar", () => {
    const blocks = lipat([text("Kolom ada"), tool("Read"), text("Sekarang verifikasi"), tool("Bash"), text("Selesai."), result]);
    expect(kinds(blocks)).toEqual(["work", "item", "item"]);
    const work = blokWork(blocks);
    expect(work?.kind === "work" && work.items.length).toBe(4);
    expect(isiWork(work)).toEqual(["text", "tool", "text", "tool"]);
    // jawaban akhir tetap blok item biasa, lalu hasil
    expect(blocks[1]?.kind === "item" && blocks[1].item.kind === "text").toBe(true);
    expect(blocks[2]?.kind === "item" && blocks[2].item.kind === "result").toBe(true);
  });

  test("(b) giliran ekor saat masih berjalan tidak dilipat", () => {
    const blocks = lipat([text("Mulai"), tool("Read"), text("Lanjut")], true);
    expect(kinds(blocks)).toEqual(["item", "steps", "item"]);
  });

  test("(c) teks yang masih streaming di ekor tidak dilipat", () => {
    const blocks = lipat([text("Mulai"), tool("Read"), text("Lanjut", true)], false);
    expect(kinds(blocks)).toEqual(["item", "steps", "item"]);
  });

  test("(d) segmen tanpa langkah tidak berubah", () => {
    const blocks = lipat([text("Satu"), text("Dua")], false);
    expect(kinds(blocks)).toEqual(["item", "item"]);
    expect(blocks[0]?.kind === "item" && blocks[0].item.kind === "text").toBe(true);
    expect(blocks[1]?.kind === "item" && blocks[1].item.kind === "text").toBe(true);
  });

  test("(e) dua giliran dipisah pesan pengguna jadi dua blok Bekerja", () => {
    const blocks = lipat([text("A"), tool("Read"), text("Jawaban A"), user, text("B"), tool("Bash"), text("Jawaban B")]);
    expect(kinds(blocks)).toEqual(["work", "item", "item", "work", "item"]);
    const works = blocks.filter((block) => block.kind === "work");
    expect(works).toHaveLength(2);
    expect(works.every((block) => block.kind === "work" && block.steps === 1)).toBe(true);
  });

  test("(f) kartu izin memutus segmen", () => {
    const blocks = lipat([text("A"), tool("Read"), permission, text("B"), tool("Bash"), text("Akhir")]);
    expect(kinds(blocks)).toEqual(["work", "item", "work", "item"]);
    expect(blocks[1]?.kind === "item" && blocks[1].item.kind === "permission").toBe(true);
  });

  test("(g) segmen berakhir di langkah: blok Bekerja tanpa jawaban akhir", () => {
    const blocks = lipat([text("A"), tool("Read")]);
    expect(kinds(blocks)).toEqual(["work"]);
    expect(isiWork(blocks[0])).toEqual(["text", "tool"]);
  });

  test("(h) satu blok langkah tunggal tetap blok langkah biasa", () => {
    const blocks = lipat([tool("Read")]);
    expect(kinds(blocks)).toEqual(["steps"]);
    expect(blocks[0]?.kind === "steps" && blocks[0].items.length).toBe(1);
  });

  test("(i) jumlah langkah benar dan judul tepat", () => {
    const blocks = lipat([text("A"), tool("Read"), think, tool("Bash"), text("Akhir")]);
    const work = blokWork(blocks);
    expect(work?.kind === "work" && work.steps).toBe(3);
    expect(work?.kind === "work" && workTitle(work)).toBe("Bekerja, 3 langkah");

    const satu = lipat([text("A"), tool("Read"), text("Akhir")]);
    const blokSatu = blokWork(satu);
    expect(blokSatu?.kind === "work" && blokSatu.steps).toBe(1);
    expect(blokSatu?.kind === "work" && workTitle(blokSatu)).toBe("Bekerja, 1 langkah");
  });

  test("blok Bekerja menyimpan urutan asli dan indeks item pertama", () => {
    const items = [text("A"), tool("Read"), text("B"), tool("Bash"), text("Akhir")];
    const blocks = lipat(items);
    const work = blokWork(blocks);
    expect(work?.kind === "work" && work.index).toBe(0);
    const isi = work?.kind === "work" ? (work.items as WorkItem[]) : [];
    expect(isi.map((item) => (item.kind === "text" ? item.text : item.kind))).toEqual([
      "A",
      "tool",
      "B",
      "tool",
    ]);
  });

  test("blok langkah di dalam Bekerja tetap bisa dihitung statusnya", () => {
    const blocks = lipat([text("A"), tool("Read", "gagal"), tool("Bash"), text("Akhir")]);
    const work = blokWork(blocks);
    const langkah = work?.kind === "work" ? work.items.filter((item): item is StepItem => item.kind !== "text") : [];
    expect(langkah).toHaveLength(2);
    expect(langkah[0]?.kind === "tool" && langkah[0].status).toBe("gagal");
  });
});
