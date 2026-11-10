import { describe, expect, test } from "bun:test";
import {
  allAnswered,
  answerText,
  buildAnswers,
  emptySelection,
  parseAskQuestions,
  setOther,
  toggleLabel,
} from "../src/client/lib/ask-question";

const INPUT = {
  questions: [
    {
      question: "Mau lanjut ke mana?",
      header: "Fokus",
      options: [
        { label: "Push", description: "Siapkan remote" },
        { label: "Rilis 3", description: "" },
      ],
    },
    { question: "Fitur?", header: "", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ],
};

describe("parseAskQuestions", () => {
  test("membaca pertanyaan, opsi, dan multiSelect; abaikan entri rusak", () => {
    const parsed = parseAskQuestions(INPUT)!;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.options[0]).toEqual({ label: "Push", description: "Siapkan remote" });
    expect(parsed[1]!.multiSelect).toBe(true);
    expect(parseAskQuestions({ questions: [{ question: "" }, 3] })).toBeUndefined();
    expect(parseAskQuestions("x")).toBeUndefined();
    expect(parseAskQuestions({})).toBeUndefined();
  });
});

describe("pilihan jawaban", () => {
  test("tunggal: memilih mengganti pilihan dan menghapus teks bebas", () => {
    let s = toggleLabel(emptySelection(), "A", false);
    s = setOther(s, "lain", false);
    expect(s).toEqual({ labels: [], other: "lain" });
    s = toggleLabel(s, "B", false);
    expect(s).toEqual({ labels: ["B"], other: "" });
  });

  test("multi: toggle menambah dan menghapus, teks bebas ikut digabung", () => {
    let s = toggleLabel(emptySelection(), "A", true);
    s = toggleLabel(s, "B", true);
    s = toggleLabel(s, "A", true);
    s = setOther(s, " X ", true);
    expect(answerText(s)).toBe("B, X");
  });

  test("allAnswered dan buildAnswers memakai teks pertanyaan sebagai kunci", () => {
    const qs = parseAskQuestions(INPUT)!;
    const sel = [toggleLabel(emptySelection(), "Push", false), emptySelection()];
    expect(allAnswered(qs, sel)).toBe(false);
    sel[1] = toggleLabel(emptySelection(), "A", true);
    expect(allAnswered(qs, sel)).toBe(true);
    expect(buildAnswers(qs, sel)).toEqual({ "Mau lanjut ke mana?": "Push", "Fitur?": "A" });
  });
});

import { parsePlan } from "../src/client/lib/ask-question";

describe("parsePlan", () => {
  test("mengambil teks plan, menolak kosong dan bentuk lain", () => {
    expect(parsePlan({ plan: "  # Rencana\n1. a " })).toBe("# Rencana\n1. a");
    expect(parsePlan({ plan: "   " })).toBeUndefined();
    expect(parsePlan({ plan: 3 })).toBeUndefined();
    expect(parsePlan("x")).toBeUndefined();
  });
});
