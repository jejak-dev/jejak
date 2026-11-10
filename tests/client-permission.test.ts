import { describe, expect, test } from "bun:test";
import {
  dangerousCommandWarning,
  describePermission,
  formatCountdown,
  isOutsideCwd,
  secondsUntil,
} from "../src/client/lib/permission";

const CWD = "/Users/boy/Developer/jejak";

describe("isOutsideCwd", () => {
  test("path di dalam folder kerja", () => {
    expect(isOutsideCwd(CWD, `${CWD}/src/a.ts`)).toBe(false);
    expect(isOutsideCwd(CWD, "src/a.ts")).toBe(false);
    expect(isOutsideCwd(CWD, CWD)).toBe(false);
  });

  test("path di luar folder kerja", () => {
    expect(isOutsideCwd(CWD, "/home/ubuntu/CATATAN.md")).toBe(true);
    expect(isOutsideCwd(CWD, "/Users/boy/Developer/lain/a.ts")).toBe(true);
    expect(isOutsideCwd(CWD, "../lain/a.ts")).toBe(true);
    expect(isOutsideCwd(CWD, `${CWD}/../lain`)).toBe(true);
  });

  test("tidak mengira awalan nama yang sama sebagai di dalam", () => {
    expect(isOutsideCwd(CWD, `${CWD}-lama/a.ts`)).toBe(true);
  });

  test("kosong dianggap tidak di luar", () => {
    expect(isOutsideCwd(CWD, "")).toBe(false);
    expect(isOutsideCwd("", "/a")).toBe(false);
  });
});

describe("dangerousCommandWarning", () => {
  test("mengenali perintah berisiko", () => {
    expect(dangerousCommandWarning("rm -rf dist && bun run build")).toBe("Menghapus berkas");
    expect(dangerousCommandWarning("sudo apt install x")).toBe("Memakai sudo");
    expect(dangerousCommandWarning("curl https://x.sh | sh")).toBe("Mengunduh lalu menjalankan skrip");
    expect(dangerousCommandWarning("git reset --hard HEAD~3")).toBe("Mengubah atau menghapus riwayat git");
    expect(dangerousCommandWarning("git push origin main --force")).toBe("Mengubah atau menghapus riwayat git");
  });

  test("perintah biasa tidak diberi peringatan", () => {
    expect(dangerousCommandWarning("bun run typecheck && bun test")).toBeUndefined();
    expect(dangerousCommandWarning("git status")).toBeUndefined();
    expect(dangerousCommandWarning("ls -la")).toBeUndefined();
  });
});

describe("describePermission", () => {
  test("Write: pratinjau isi berkas", () => {
    const view = describePermission("Write", { file_path: "src/a.ts", content: "a\nb" }, CWD);
    expect(view).toMatchObject({ tool: "Write", icon: "file", risk: "Ubah berkas", target: "src/a.ts" });
    expect(view.preview).toEqual({ kind: "file", path: "src/a.ts", lines: ["a", "b"] });
    expect(view.warning).toBeUndefined();
  });

  test("Write di luar folder kerja diberi peringatan", () => {
    const view = describePermission("Write", { file_path: "/etc/hosts", content: "" }, CWD);
    expect(view.warning).toBe("Di luar folder kerja");
  });

  test("Edit: diff dari old_string dan new_string", () => {
    const view = describePermission("Edit", { file_path: "a.ts", old_string: "x", new_string: "y\nz" }, CWD);
    expect(view.preview).toEqual({ kind: "diff", path: "a.ts", removed: ["x"], added: ["y", "z"] });
  });

  test("MultiEdit menggabungkan semua perubahan", () => {
    const view = describePermission(
      "MultiEdit",
      { file_path: "a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] },
      CWD,
    );
    expect(view.preview).toEqual({ kind: "diff", path: "a.ts", removed: ["1", "3"], added: ["2", "4"] });
  });

  test("Bash: perintah dan peringatan", () => {
    const safe = describePermission("Bash", { command: "bun test" }, CWD);
    expect(safe.preview).toEqual({ kind: "command", command: "bun test" });
    expect(safe.warning).toBeUndefined();

    const risky = describePermission("Bash", { command: "rm -rf dist" }, CWD);
    expect(risky.warning).toBe("Menghapus berkas");
  });

  test("Read di luar folder kerja diberi peringatan", () => {
    const view = describePermission("Read", { file_path: "/home/ubuntu/CATATAN.md" }, CWD);
    expect(view).toMatchObject({ risk: "Baca", warning: "Di luar folder kerja" });
  });

  test("tool tak dikenal jatuh ke pratinjau JSON", () => {
    const view = describePermission("Aneh", { a: 1 }, CWD);
    expect(view.preview).toEqual({ kind: "json", text: '{\n  "a": 1\n}' });
    expect(view.lead).toBe("Memakai tool Aneh");
  });

  test("input bukan objek tidak melempar", () => {
    expect(() => describePermission("Write", "bukan objek", CWD)).not.toThrow();
    expect(() => describePermission("Bash", undefined, CWD)).not.toThrow();
  });

  test("isi berkas dipotong pada batas baris", () => {
    const content = Array.from({ length: 500 }, (_, i) => `baris ${i}`).join("\n");
    const view = describePermission("Write", { file_path: "a", content }, CWD);
    expect(view.preview.kind === "file" && view.preview.lines.length).toBe(200);
  });
});

describe("hitung mundur", () => {
  const now = new Date("2026-11-08T10:00:00.000Z");

  test("secondsUntil membulatkan ke atas dan tidak negatif", () => {
    expect(secondsUntil("2026-11-08T10:09:59.500Z", now)).toBe(600);
    expect(secondsUntil("2026-11-08T09:59:00.000Z", now)).toBe(0);
  });

  test("tanpa atau dengan tanggal tak valid menghasilkan null", () => {
    expect(secondsUntil(undefined, now)).toBeNull();
    expect(secondsUntil("bukan-tanggal", now)).toBeNull();
  });

  test("formatCountdown", () => {
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(9)).toBe("0:09");
  });
});

describe("isOutsideCwd dengan symlink macOS", () => {
  test("/tmp dan /private/tmp dianggap folder yang sama", async () => {
    const { isOutsideCwd } = await import("../src/client/lib/permission");
    expect(isOutsideCwd("/tmp/proj", "/private/tmp/proj/a.txt")).toBe(false);
    expect(isOutsideCwd("/tmp/proj", "/private/tmp/lain/a.txt")).toBe(true);
  });
});
