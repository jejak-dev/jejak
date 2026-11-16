import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askSummaryLine, type AskQuestion } from "../src/client/lib/ask-question";

const QUESTIONS: AskQuestion[] = [
  {
    question: "Mau lanjut ke mana?",
    header: "Fokus",
    multiSelect: false,
    options: [{ label: "Push", description: "" }],
  },
  {
    question: "Fitur?",
    header: "",
    multiSelect: false,
    options: [{ label: "Frontend", description: "" }],
  },
];

describe("askSummaryLine", () => {
  test("dua pertanyaan dengan jawaban digabung sesuai urutan pertanyaan", () => {
    expect(
      askSummaryLine(QUESTIONS, {
        "Mau lanjut ke mana?": "Edukasi & belajar",
        "Fitur?": "Frontend saja",
      }),
    ).toBe("2 pertanyaan: Edukasi & belajar, Frontend saja");
  });

  test("tanpa jawaban cukup jumlah pertanyaan", () => {
    expect(askSummaryLine(QUESTIONS)).toBe("2 pertanyaan");
    expect(askSummaryLine(QUESTIONS, { "Mau lanjut ke mana?": "   " })).toBe("2 pertanyaan");
  });

  test("satu pertanyaan tetap jamak tunggal", () => {
    expect(askSummaryLine([QUESTIONS[0]!], { "Mau lanjut ke mana?": "Push" })).toBe(
      "1 pertanyaan: Push",
    );
  });
});

const permissionCard = readFileSync(
  join(import.meta.dir, "..", "src", "client", "components", "PermissionCard.tsx"),
  "utf8",
);

describe("Pertanyaan agent yang dijawab dilipat", () => {
  test("kartu izin tak membuka rincian pertanyaan otomatis", () => {
    expect(permissionCard).not.toContain("open={asks !== undefined}");
  });

  test("status pertanyaan yang diizinkan tampil sebagai Dijawab", () => {
    expect(permissionCard).toContain('"Dijawab"');
  });
});
