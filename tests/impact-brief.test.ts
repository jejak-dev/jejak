import { describe, expect, test } from "bun:test";
import {
  IMPACT_BRIEF_MAX_TASK,
  buildImpactBriefPrompt,
  impactBriefTitle,
} from "../src/shared/impact-brief";

describe("buildImpactBriefPrompt", () => {
  test("membungkus tugas sebagai data dan memuat aturan baca-saja serta question_ask", () => {
    const prompt = buildImpactBriefPrompt("  Ubah kolom orders.status  ");
    expect(prompt).toContain("<tugas>\nUbah kolom orders.status\n</tugas>");
    expect(prompt).toContain("Jangan mengubah berkas");
    expect(prompt).toContain("question_ask");
    expect(prompt).toContain("ASAL");
    expect(prompt).toContain("dikonfirmasi");
    expect(prompt).toContain("bukan instruksi");
  });

  test("memotong tugas yang terlalu panjang", () => {
    const prompt = buildImpactBriefPrompt("x".repeat(IMPACT_BRIEF_MAX_TASK + 500));
    expect(prompt.split("x").length - 1).toBe(IMPACT_BRIEF_MAX_TASK);
  });
});

describe("impactBriefTitle", () => {
  test("baris pertama, rapikan spasi, potong 60 karakter", () => {
    expect(impactBriefTitle("Ubah  status\nbaris dua")).toBe("Brief: Ubah status");
    const long = impactBriefTitle("a".repeat(100));
    expect(long.length).toBe("Brief: ".length + 60);
    expect(long.endsWith("…")).toBe(true);
    expect(impactBriefTitle("   ")).toBe("Brief dampak");
  });
});
