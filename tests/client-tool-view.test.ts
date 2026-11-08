import { describe, expect, test } from "bun:test";
import {
  clipContent,
  diffCopyText,
  MAX_VIEW_LINES,
  toolView,
  type DiffLine,
} from "../src/client/lib/tool-view";

function linesOf(count: number, prefix = "baris"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

describe("toolView: Bash", () => {
  test("command dengan description", () => {
    expect(toolView("Bash", { command: "bun test", description: "jalankan tes" })).toEqual({
      kind: "command",
      command: "bun test",
      description: "jalankan tes",
    });
  });

  test("command tanpa description tidak menyertakan field", () => {
    const view = toolView("Bash", { command: "ls -la" });
    expect(view).toEqual({ kind: "command", command: "ls -la" });
    expect(view).not.toHaveProperty("description");
  });

  test("description kosong dianggap tidak ada", () => {
    expect(toolView("Bash", { command: "ls", description: "" })).toEqual({
      kind: "command",
      command: "ls",
    });
  });
});

describe("toolView: Edit", () => {
  test("baris lama jadi del lalu baris baru jadi add", () => {
    const view = toolView("Edit", {
      file_path: "/repo/a.ts",
      old_string: "satu\ndua",
      new_string: "tiga",
    });
    expect(view).toEqual({
      kind: "diff",
      path: "/repo/a.ts",
      lines: [
        { type: "del", text: "satu" },
        { type: "del", text: "dua" },
        { type: "add", text: "tiga" },
      ],
    });
  });

  test("replace_all menambah catatan semua kemunculan", () => {
    const view = toolView("Edit", {
      file_path: "a.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(view).toMatchObject({ kind: "diff", note: "semua kemunculan" });
  });

  test("old/new kosong menghasilkan diff tanpa baris", () => {
    expect(toolView("Edit", { file_path: "a.ts", old_string: "", new_string: "" })).toEqual({
      kind: "diff",
      path: "a.ts",
      lines: [],
    });
  });

  test("memakai path bila file_path tidak ada", () => {
    expect(toolView("Edit", { path: "b.ts", old_string: "a", new_string: "b" })).toMatchObject({
      kind: "diff",
      path: "b.ts",
    });
  });
});

describe("toolView: MultiEdit", () => {
  test("menggabungkan edit dengan pemisah", () => {
    expect(
      toolView("MultiEdit", {
        file_path: "a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c\nd", new_string: "e" },
        ],
      }),
    ).toEqual({
      kind: "diff",
      path: "a.ts",
      lines: [
        { type: "del", text: "a" },
        { type: "add", text: "b" },
        { type: "sep" },
        { type: "del", text: "c" },
        { type: "del", text: "d" },
        { type: "add", text: "e" },
      ],
    });
  });

  test("edits kosong atau bukan array menjadi generic", () => {
    expect(toolView("MultiEdit", { file_path: "a.ts", edits: [] })).toEqual({ kind: "generic" });
    expect(toolView("MultiEdit", { file_path: "a.ts", edits: "x" })).toEqual({ kind: "generic" });
  });

  test("satu edit rusak membuat seluruh tampilan generic", () => {
    expect(
      toolView("MultiEdit", {
        file_path: "a.ts",
        edits: [{ old_string: "a", new_string: "b" }, { old_string: 1, new_string: "c" }],
      }),
    ).toEqual({ kind: "generic" });
  });
});

describe("toolView: Write", () => {
  test("path dan isi", () => {
    expect(toolView("Write", { file_path: "x.md", content: "# hi" })).toEqual({
      kind: "write",
      path: "x.md",
      content: "# hi",
    });
  });
});

describe("toolView: nama & bentuk input", () => {
  test("awalan mcp__server__ dilepas dan nama tak peka huruf besar-kecil", () => {
    expect(
      toolView("mcp__fs__Edit", { file_path: "a", old_string: "x", new_string: "y" }),
    ).toMatchObject({ kind: "diff", path: "a" });
    expect(toolView("EDIT", { file_path: "a", old_string: "x", new_string: "y" })).toMatchObject({
      kind: "diff",
    });
    expect(toolView("bash", { command: "pwd" })).toEqual({ kind: "command", command: "pwd" });
  });

  test("tool lain menjadi generic", () => {
    expect(toolView("Read", { file_path: "a" })).toEqual({ kind: "generic" });
  });

  test("input salah tipe atau field hilang menjadi generic tanpa melempar", () => {
    expect(toolView("Bash", null)).toEqual({ kind: "generic" });
    expect(toolView("Bash", undefined)).toEqual({ kind: "generic" });
    expect(toolView("Bash", "ls")).toEqual({ kind: "generic" });
    expect(toolView("Bash", [])).toEqual({ kind: "generic" });
    expect(toolView("Bash", {})).toEqual({ kind: "generic" });
    expect(toolView("Bash", { command: 42 })).toEqual({ kind: "generic" });
    expect(toolView("Edit", { file_path: "a", old_string: "x" })).toEqual({ kind: "generic" });
    expect(toolView("Write", { file_path: "a" })).toEqual({ kind: "generic" });
    expect(toolView("Write", { content: "isi" })).toEqual({ kind: "generic" });
  });

  test("input aneh yang tidak bisa diserialisasi tidak melempar", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolView("Bash", cyclic)).toEqual({ kind: "generic" });
  });
});

describe("toolView: batas 400 baris", () => {
  test("Edit lebih dari 400 baris dipotong dengan more", () => {
    const view = toolView("Edit", {
      file_path: "a.ts",
      old_string: linesOf(300, "lama"),
      new_string: linesOf(300, "baru"),
    });
    expect(view.kind).toBe("diff");
    if (view.kind !== "diff") return;

    expect(view.lines).toHaveLength(MAX_VIEW_LINES + 1);
    const last = view.lines.at(-1) as DiffLine;
    expect(last).toEqual({ type: "more", count: 200 });
    expect(view.lines.slice(0, MAX_VIEW_LINES).every((line) => line.type === "del" || line.type === "add")).toBe(
      true,
    );
  });

  test("tepat 400 baris tidak menambah more", () => {
    const view = toolView("Edit", {
      file_path: "a.ts",
      old_string: linesOf(200, "lama"),
      new_string: linesOf(200, "baru"),
    });
    expect(view.kind).toBe("diff");
    if (view.kind !== "diff") return;
    expect(view.lines).toHaveLength(400);
    expect(view.lines.some((line) => line.type === "more")).toBe(false);
  });

  test("baris pemisah MultiEdit tidak dihitung dan tidak melewati more", () => {
    const edits = Array.from({ length: 3 }, () => ({
      old_string: linesOf(200, "lama"),
      new_string: linesOf(200, "baru"),
    }));
    const view = toolView("MultiEdit", { file_path: "a.ts", edits });
    expect(view.kind).toBe("diff");
    if (view.kind !== "diff") return;

    const more = view.lines.filter((line) => line.type === "more");
    expect(more).toEqual([{ type: "more", count: 800 }]);
    expect(view.lines.at(-1)?.type).toBe("more");
    expect(view.lines.filter((line) => line.type === "del" || line.type === "add")).toHaveLength(400);
  });
});

describe("clipContent", () => {
  test("memotong isi write di 400 baris dan melaporkan sisa", () => {
    const content = linesOf(405);
    const clipped = clipContent(content);
    expect(clipped.text.split("\n")).toHaveLength(400);
    expect(clipped.hidden).toBe(5);
  });

  test("isi pendek dikembalikan apa adanya", () => {
    expect(clipContent("a\nb\n")).toEqual({ text: "a\nb\n", hidden: 0 });
  });
});

describe("diffCopyText", () => {
  test("Edit menyalin new_string", () => {
    expect(diffCopyText("Edit", { old_string: "a", new_string: "b\nc" })).toBe("b\nc");
  });

  test("MultiEdit menyalin semua new_string", () => {
    expect(
      diffCopyText("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    ).toBe("b\nd");
  });

  test("selain edit atau input buruk menghasilkan string kosong", () => {
    expect(diffCopyText("Bash", { command: "ls" })).toBe("");
    expect(diffCopyText("Edit", null)).toBe("");
    expect(diffCopyText("Edit", { old_string: "a" })).toBe("");
  });
});
