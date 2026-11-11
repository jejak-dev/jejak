import { describe, expect, test } from "bun:test";
import { groupSteps, stepsStatus, summarizeSteps, type StepItem } from "../src/client/lib/step-groups";
import type { TimelineItem } from "../src/client/lib/timeline";

function tool(name: string, status: "berjalan" | "selesai" | "gagal" = "selesai"): TimelineItem {
  return { kind: "tool", id: `${name}-${Math.random()}`, name, input: {}, summary: "", status, depth: 0 };
}
const think: TimelineItem = { kind: "thinking", text: "hmm", depth: 0 };
const text = (value: string): TimelineItem => ({ kind: "text", text: value, depth: 0 });

describe("groupSteps", () => {
  test("deretan tool dan berpikir jadi satu blok; teks memutus", () => {
    const blocks = groupSteps([
      { kind: "user", text: "hai" },
      think,
      tool("Bash"),
      tool("Read"),
      text("halo"),
      tool("Bash"),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["item", "steps", "item", "steps"]);
    const first = blocks[1];
    expect(first?.kind === "steps" && first.items.length).toBe(3);
  });

  test("AskUserQuestion dan ExitPlanMode tidak masuk blok", () => {
    const blocks = groupSteps([tool("AskUserQuestion"), tool("ExitPlanMode")]);
    expect(blocks).toEqual([]);
  });

  test("kartu izin memutus deretan", () => {
    const permission: TimelineItem = {
      kind: "permission",
      id: "p",
      name: "Bash",
      input: {},
      status: "menunggu",
    };
    const blocks = groupSteps([tool("Read"), permission, tool("Read")]);
    expect(blocks.map((block) => block.kind)).toEqual(["steps", "item", "steps"]);
  });
});

describe("summarizeSteps", () => {
  test("menghitung per kategori dengan urutan tetap", () => {
    const items = [
      tool("Bash"),
      tool("Bash"),
      tool("mcp__jejak-memory__memory_search"),
      think,
    ] as StepItem[];
    expect(summarizeSteps(items)).toBe("Berpikir, mengingat kembali 1 memori, menjalankan 2 perintah");
  });

  test("tool lain dan edit", () => {
    const items = [tool("Edit"), tool("Mystery")] as StepItem[];
    expect(summarizeSteps(items)).toBe("Mengubah 1 berkas, memakai 1 tool");
  });
});

describe("stepsStatus", () => {
  test("hitung gagal dan berjalan", () => {
    const items = [tool("Bash", "gagal"), tool("Bash", "berjalan"), think] as StepItem[];
    expect(stepsStatus(items)).toEqual({ failed: 1, running: true });
  });
});

describe("formatElapsed", () => {
  test("detik, menit, dan menit dengan sisa detik", async () => {
    const { formatElapsed } = await import("../src/client/components/StepsGroup");
    expect(formatElapsed(37)).toBe("37 dtk");
    expect(formatElapsed(60)).toBe("1 mnt");
    expect(formatElapsed(122.7)).toBe("2 mnt 2 dtk");
    expect(formatElapsed(-3)).toBe("0 dtk");
  });
});
